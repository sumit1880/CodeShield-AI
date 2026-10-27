import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { PrismaPgvectorRetriever } from '../services/rag/prisma-retriever';
import { CodeContextService } from '../services/code-context/code-context.service';
import { CodeSearchService } from '../services/code-context/code-search.service';
import { buildAnalysisGraph } from '../graph/builder';
import { withTempDir } from '../utils/temp-workspace';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';
import { isSupportedLanguage, languageForExtension } from '../config/languages';
import { env } from '../config/env';
import { SemgrepFinding, UncertainFindingResponse, VulnerabilityResponse } from '../types/findings';
import { FinalizedFindings } from '../graph/state';
import fs from 'fs/promises';
import path from 'path';

export interface OrchestratorDeps {
  detectionModel: BaseChatModel;
  verificationModel: BaseChatModel;
  semgrepService: SemgrepService;
  retriever: PrismaPgvectorRetriever;
  codeContextService: CodeContextService;
  codeSearchService: CodeSearchService;
  prisma: PrismaClient;
}

export interface AnalyzePastedCodeInput {
  language: string;
  code: string;
  userId?: string;
  analysisId?: string;
  signal?: AbortSignal;
}

export interface AnalyzeProjectInput {
  language: string;
  files: Array<{ relativePath: string; absolutePath: string }>;
  projectRoot: string;
  userId?: string;
  analysisId?: string;
  signal?: AbortSignal;
}

export interface AnalysisSummary {
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface AnalysisResult {
  id?: string;
  persisted: boolean;
  language: string;
  summary: AnalysisSummary;
  vulnerabilities: VulnerabilityResponse[];
  uncertainFindings: UncertainFindingResponse[];
  partial: boolean;
  analysisStatus: 'COMPLETE' | 'PARTIAL';
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function summarize(vulns: VulnerabilityResponse[]): AnalysisSummary {
  const summary: AnalysisSummary = { totalIssues: vulns.length, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const v of vulns) {
    switch (v.severity) {
      case 'CRITICAL': summary.critical++; break;
      case 'HIGH':     summary.high++;     break;
      case 'MEDIUM':   summary.medium++;   break;
      case 'LOW':      summary.low++;      break;
      case 'INFO':     summary.info++;     break;
    }
  }
  return summary;
}

/**
 * Thin orchestrator facade.
 * Handles workspace setup, initial Semgrep scan, source-view preparation,
 * LangGraph execution, and Prisma persistence. The agentic pipeline itself
 * lives in src/graph/ (StateGraph + nodes + router).
 */
export class AnalysisOrchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async analyzePastedCode(input: AnalyzePastedCodeInput): Promise<AnalysisResult> {
    const { language, code, userId, analysisId: preCreatedId, signal } = input;
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

    this.validatePastedCode(language, code);

    return withTempDir(async (tempDir) => {
      const startedAt = Date.now();
      const ext = this.guessExtension(language);
      const filePath = path.join(tempDir, `submission${ext}`);
      await fs.writeFile(filePath, code, 'utf-8');

      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

      const semgrepFindings = await this.runSemgrepSafely(tempDir, language);
      const submissionFile = 'submission' + ext;

      // Bounded source view for large files
      const lines = code.split('\n');
      let effectiveSource = code;
      if (lines.length > 3000) {
        const head = lines.slice(0, 1000).join('\n');
        const findingWindows = semgrepFindings.map((f) => {
          const start = Math.max(0, f.lineStart - 20);
          const end = Math.min(lines.length, f.lineEnd + 20);
          return `// Lines ${start}-${end} (near ${f.ruleId})\n` + lines.slice(start, end).join('\n');
        });
        effectiveSource = [head, '// ... (middle omitted for length) ...', ...findingWindows].join('\n\n---\n\n');
      }

      const result = await this.runGraph({
        language,
        sourceCode: effectiveSource,
        semgrepFindings: semgrepFindings.map((f) => ({ ...f, file: submissionFile })),
        projectRoot: tempDir,
        files: [submissionFile],
        signal
      });

      const analysisId = await this.persist({
        existingId: preCreatedId,
        userId,
        language,
        codeHash: hashCode(code),
        sourceType: 'PASTE',
        durationMs: Date.now() - startedAt,
        vulnerabilities: result.vulnerabilities,
        uncertainFindings: result.uncertainFindings,
        partial: result.partial
      });

      return {
        id: analysisId ?? undefined,
        persisted: analysisId !== null,
        language,
        summary: summarize(result.vulnerabilities),
        vulnerabilities: result.vulnerabilities,
        uncertainFindings: result.uncertainFindings,
        partial: result.partial,
        analysisStatus: result.partial ? 'PARTIAL' : 'COMPLETE'
      };
    });
  }

  async analyzeProject(input: AnalyzeProjectInput): Promise<AnalysisResult> {
    const startedAt = Date.now();
    const { language, files, projectRoot, userId, analysisId: preCreatedId, signal } = input;
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

    const relevantFiles = this.deps.codeContextService.filterRelevantFiles(
      files.map((f) => ({ relativePath: f.relativePath, absolutePath: f.absolutePath, size: 0 }))
    );

    if (relevantFiles.length === 0) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'No analyzable source files found in the archive');
    }

    const effectiveLanguage =
      language && language !== 'auto'
        ? language
        : this.inferDominantLanguage(relevantFiles.map((f) => f.relativePath));

    if (language && language !== 'auto' && !isSupportedLanguage(language)) {
      throw new ApiError(ErrorCode.UNSUPPORTED_LANGUAGE, 'The selected language is not currently supported.');
    }

    const semgrepFindings = await this.runSemgrepSafely(
      projectRoot,
      language === 'auto' ? 'auto' : language
    );

    const normalizedFindings: SemgrepFinding[] = semgrepFindings.map((f) => ({
      ...f,
      file: path.relative(projectRoot, path.resolve(f.file))
    }));

    const contexts = await this.deps.codeContextService.extractContextForFindings(
      projectRoot,
      normalizedFindings
    );

    const sourceView = contexts
      .map((c) => `// File: ${c.file} (lines ${c.startLine}-${c.endLine})\n${c.snippet}`)
      .join('\n\n---\n\n');

    const result = await this.runGraph({
      language: effectiveLanguage,
      sourceCode: sourceView || '// No Semgrep findings to provide context for.',
      semgrepFindings: normalizedFindings,
      projectRoot,
      files: relevantFiles.map((f) => f.relativePath),
      signal
    });

    const analysisId = await this.persist({
      existingId: preCreatedId,
      userId,
      language: effectiveLanguage,
      codeHash: await this.hashProject(relevantFiles),
      sourceType: 'ZIP',
      durationMs: Date.now() - startedAt,
      vulnerabilities: result.vulnerabilities,
      uncertainFindings: result.uncertainFindings,
      partial: result.partial
    });

    return {
      id: analysisId ?? undefined,
      persisted: analysisId !== null,
      language: effectiveLanguage,
      summary: summarize(result.vulnerabilities),
      vulnerabilities: result.vulnerabilities,
      uncertainFindings: result.uncertainFindings,
      partial: result.partial,
      analysisStatus: result.partial ? 'PARTIAL' : 'COMPLETE'
    };
  }

  // -------------------------------------------------------------------
  // Graph runner — replaces the hand-written while loop.
  // Prepares initial state, invokes the compiled LangGraph, and extracts
  // the finalized findings from the terminal state.
  // -------------------------------------------------------------------
  private async runGraph(params: {
    language: string;
    sourceCode: string;
    semgrepFindings: SemgrepFinding[];
    projectRoot: string;
    files: string[];
    signal?: AbortSignal;
  }): Promise<FinalizedFindings> {
    const { language, sourceCode, semgrepFindings, projectRoot, files, signal } = params;

    const graph = buildAnalysisGraph({
      detectionModel: this.deps.detectionModel,
      verificationModel: this.deps.verificationModel,
      retriever: this.deps.retriever,
      semgrepService: this.deps.semgrepService,
      codeSearchService: this.deps.codeSearchService,
      signal
    });

    logger.info('[Graph] Starting security analysis');

    const deadline = Date.now() + env.agent.maxAnalysisTimeMs;

    const finalState = await graph.invoke(
      {
        goal: 'Identify, classify, and verify real security vulnerabilities in the submitted code.',
        language,
        projectRoot,
        files,
        sourceCode,
        semgrepFindings,
        deadline,
        candidateFindings: [],
        classifiedFindings: [],
        verifiedById: {},
        knowledge: [],
        evidence: [],
        actionsTaken: [],
        iteration: 0,
        toolCallCount: 0,
        stopReason: 'FINISHED',
        nextAction: null,
        finalized: null
      },
      { recursionLimit: (env.agent.maxIterations + 1) * 2 + 10 }
    );

    if (!finalState.finalized) {
      logger.warn('[Graph] No finalized findings in terminal state — returning empty result');
      return { vulnerabilities: [], uncertainFindings: [], rejectedCount: 0, partial: true };
    }

    logger.info(
      {
        confirmed: finalState.finalized.vulnerabilities.length,
        uncertain: finalState.finalized.uncertainFindings.length,
        rejected: finalState.finalized.rejectedCount
      },
      '[Graph] Analysis complete'
    );

    return finalState.finalized;
  }

  private async runSemgrepSafely(dir: string, language: string): Promise<SemgrepFinding[]> {
    try {
      return await this.deps.semgrepService.scan({ targetDir: dir, language });
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.SEMGREP_NOT_INSTALLED) {
        logger.error('Semgrep not installed; continuing with LLM-only detection.');
        return [];
      }
      throw err;
    }
  }

  private async persist(params: {
    existingId?: string;
    userId?: string;
    language: string;
    codeHash: string;
    sourceType: 'PASTE' | 'ZIP';
    durationMs: number;
    vulnerabilities: VulnerabilityResponse[];
    uncertainFindings: UncertainFindingResponse[];
    partial: boolean;
  }): Promise<string | null> {
    try {
      const confirmedRows = params.vulnerabilities.map((v) => ({
        title: v.title,
        cweId: v.cwe.id,
        cweName: v.cwe.name,
        severity: v.severity,
        confidence: v.confidence,
        file: v.location.file,
        function: v.location.function ?? undefined,
        lineStart: v.location.lineStart,
        lineEnd: v.location.lineEnd,
        explanation: v.explanation,
        recommendation: v.recommendation,
        verificationStatus: 'CONFIRMED' as const,
        verificationReason: v.verification.reason ?? v.explanation
      }));

      const uncertainRows = params.uncertainFindings.map((u) => ({
        title: u.title,
        cweId: u.cwe.id,
        cweName: u.cwe.name,
        severity: u.severity,
        confidence: u.confidence,
        file: u.location.file,
        function: u.location.function ?? undefined,
        lineStart: u.location.lineStart,
        lineEnd: u.location.lineEnd,
        explanation: u.explanation,
        recommendation: u.recommendation,
        verificationStatus: 'UNCERTAIN' as const,
        verificationReason: u.verification.reason ?? 'Analysis did not reach a final verdict'
      }));

      if (params.existingId) {
        await this.deps.prisma.analysis.update({
          where: { id: params.existingId },
          data: {
            codeHash: params.codeHash,
            status: params.partial ? 'PARTIAL' : 'COMPLETED',
            completedAt: new Date(),
            durationMs: params.durationMs,
            findings: { create: [...confirmedRows, ...uncertainRows] }
          }
        });
        return params.existingId;
      }

      const analysis = await this.deps.prisma.analysis.create({
        data: {
          userId: params.userId,
          language: params.language,
          codeHash: params.codeHash,
          sourceType: params.sourceType,
          status: params.partial ? 'PARTIAL' : 'COMPLETED',
          completedAt: new Date(),
          durationMs: params.durationMs,
          findings: { create: [...confirmedRows, ...uncertainRows] }
        }
      });
      return analysis.id;
    } catch (err) {
      logger.error({ err, existingId: params.existingId }, 'Failed to persist analysis');
      if (params.existingId) {
        throw err;
      }
      return null;
    }
  }

  private async hashProject(files: Array<{ relativePath: string; absolutePath: string }>): Promise<string> {
    const h = crypto.createHash('sha256');
    for (const f of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      h.update(f.relativePath);
      try {
        h.update(await fs.readFile(f.absolutePath));
      } catch {
        // unreadable file — path alone goes into the hash
      }
    }
    return h.digest('hex');
  }

  private validatePastedCode(language: string, code: string) {
    if (!code || code.trim().length === 0) {
      throw new ApiError(ErrorCode.EMPTY_CODE, 'Submitted code is empty');
    }
    if (!isSupportedLanguage(language)) {
      throw new ApiError(ErrorCode.UNSUPPORTED_LANGUAGE, 'The selected language is not currently supported.');
    }
    const lineCount = code.split('\n').length;
    if (lineCount > env.limits.maxCodeLines) {
      throw new ApiError(ErrorCode.CODE_TOO_LARGE, `Code exceeds ${env.limits.maxCodeLines} lines`);
    }
    if (code.length > env.limits.maxCodeCharacters) {
      throw new ApiError(ErrorCode.CODE_TOO_LARGE, `Code exceeds ${env.limits.maxCodeCharacters} characters`);
    }
  }

  private guessExtension(language: string): string {
    const map: Record<string, string> = {
      javascript: '.js', typescript: '.ts', python: '.py', java: '.java',
      go: '.go', c: '.c', cpp: '.cpp', ruby: '.rb', php: '.php', csharp: '.cs'
    };
    return map[language] || '.txt';
  }

  private inferDominantLanguage(relativePaths: string[]): string {
    const counts = new Map<string, number>();
    for (const p of relativePaths) {
      const ext = path.extname(p);
      const langId = languageForExtension(ext);
      if (!langId) continue;
      counts.set(langId, (counts.get(langId) || 0) + 1);
    }
    let best = '';
    let bestCount = -1;
    for (const [langId, count] of counts) {
      if (count > bestCount) { best = langId; bestCount = count; }
    }
    return best || 'unknown';
  }
}
