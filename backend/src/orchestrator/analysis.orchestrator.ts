import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { DetectionAgent } from '../agents/detection.agent';
import { ClassificationAgent } from '../agents/classification.agent';
import { VerificationAgent } from '../agents/verification.agent';
import { ManagerAgent } from '../agents/manager.agent';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { RagService } from '../services/rag/rag.service';
import { CodeContextService } from '../services/code-context/code-context.service';
import { CodeSearchService } from '../services/code-context/code-search.service';
import { createToolRegistry } from './tool-registry';
import { withTempDir } from '../utils/temp-workspace';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';
import { isSupportedLanguage, languageForExtension } from '../config/languages';
import { env } from '../config/env';
import { AnalysisState } from '../types/agent-state';
import { SemgrepFinding, VulnerabilityResponse } from '../types/findings';
import fs from 'fs/promises';
import path from 'path';

export interface OrchestratorDeps {
  detectionAgent: DetectionAgent;
  classificationAgent: ClassificationAgent;
  verificationAgent: VerificationAgent;
  managerAgent: ManagerAgent;
  semgrepService: SemgrepService;
  ragService: RagService;
  codeContextService: CodeContextService;
  codeSearchService: CodeSearchService;
  prisma: PrismaClient;
}

export interface AnalyzePastedCodeInput {
  language: string;
  code: string;
}

export interface AnalyzeProjectInput {
  language: string; // may be 'auto'
  files: Array<{ relativePath: string; absolutePath: string }>;
  projectRoot: string;
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
  id: string;
  language: string;
  summary: AnalysisSummary;
  vulnerabilities: VulnerabilityResponse[];
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function summarize(vulns: VulnerabilityResponse[]): AnalysisSummary {
  const summary: AnalysisSummary = { totalIssues: vulns.length, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const v of vulns) {
    switch (v.severity) {
      case 'CRITICAL':
        summary.critical++;
        break;
      case 'HIGH':
        summary.high++;
        break;
      case 'MEDIUM':
        summary.medium++;
        break;
      case 'LOW':
        summary.low++;
        break;
      case 'INFO':
        summary.info++;
        break;
    }
  }
  return summary;
}

/**
 * The orchestrator is the ONLY component responsible for sequencing the
 * three agents. Agents never call each other directly.
 */
export class AnalysisOrchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async analyzePastedCode(input: AnalyzePastedCodeInput): Promise<AnalysisResult> {
    const { language, code } = input;

    this.validatePastedCode(language, code);

    return withTempDir(async (tempDir) => {
      const startedAt = Date.now();
      const ext = this.guessExtension(language);
      const filePath = path.join(tempDir, `submission${ext}`);
      await fs.writeFile(filePath, code, 'utf-8');

      const semgrepFindings = await this.runSemgrepSafely(tempDir, language, 'server.js');
      const submissionFile = 'submission' + ext;

      const result = await this.runAgenticPipeline({
        language,
        sourceCode: code,
        semgrepFindings: semgrepFindings.map((f) => ({ ...f, file: submissionFile })),
        projectRoot: tempDir,
        files: [submissionFile]
      });

      const analysisId = await this.persist({
        language,
        codeHash: hashCode(code),
        sourceType: 'PASTE',
        durationMs: Date.now() - startedAt,
        vulnerabilities: result
      });

      return { id: analysisId, language, summary: summarize(result), vulnerabilities: result };
    });
  }

  async analyzeProject(input: AnalyzeProjectInput): Promise<AnalysisResult> {
    const startedAt = Date.now();
    const { language, files, projectRoot } = input;

    const relevantFiles = this.deps.codeContextService.filterRelevantFiles(
      files.map((f) => ({ relativePath: f.relativePath, absolutePath: f.absolutePath, size: 0 }))
    );

    if (relevantFiles.length === 0) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'No analyzable source files found in the archive');
    }

    // Determine the effective language for the run: if a specific language
    // was requested, validate it; 'auto' is resolved per-file by semgrep's
    // own multi-language auto config, and we tag the analysis with the
    // dominant language for reporting purposes.
    const effectiveLanguage =
      language && language !== 'auto' ? language : this.inferDominantLanguage(relevantFiles.map((f) => f.relativePath));

    if (language && language !== 'auto' && !isSupportedLanguage(language)) {
      throw new ApiError(ErrorCode.UNSUPPORTED_LANGUAGE, 'The selected language is not currently supported.');
    }

    const semgrepFindings = await this.deps.semgrepService.scan({
      targetDir: projectRoot,
      language: language === 'auto' ? 'auto' : language
    });

    // Relative-ize semgrep file paths against the project root.
    const normalizedFindings: SemgrepFinding[] = semgrepFindings.map((f) => ({
      ...f,
      file: path.relative(projectRoot, path.resolve(f.file))
    }));

    const contexts = await this.deps.codeContextService.extractContextForFindings(projectRoot, normalizedFindings);

    // Build a bounded "source view" for the LLM: concatenated relevant
    // snippets only, never the whole project.
    const sourceView = contexts
      .map((c) => `// File: ${c.file} (lines ${c.startLine}-${c.endLine})\n${c.snippet}`)
      .join('\n\n---\n\n');

    const result = await this.runAgenticPipeline({
      language: effectiveLanguage,
      sourceCode: sourceView || '// No Semgrep findings to provide context for.',
      semgrepFindings: normalizedFindings,
      projectRoot,
      files: relevantFiles.map((f) => f.relativePath)
    });

    const analysisId = await this.persist({
      language: effectiveLanguage,
      codeHash: hashCode(relevantFiles.map((f) => f.relativePath).join('|')),
      sourceType: 'ZIP',
      durationMs: Date.now() - startedAt,
      vulnerabilities: result
    });

    return { id: analysisId, language: effectiveLanguage, summary: summarize(result), vulnerabilities: result };
  }

  // -------------------------------------------------------------------
  // Bounded autonomous multi-agent pipeline.
  //
  // Semgrep has already run once (see callers). From here, a Manager Agent
  // observes compact state and repeatedly picks ONE action from a fixed
  // safe set (see tool-registry.ts), which is validated and dispatched —
  // the Manager never executes anything directly and cannot request
  // arbitrary tools. The loop is bounded by hard, code-enforced safety
  // limits (AGENT_MAX_ITERATIONS / AGENT_MAX_TOOL_CALLS / AGENT_MAX_ANALYSIS_TIME_MS),
  // which always take priority over the Manager's own FINISH/continue choice.
  // -------------------------------------------------------------------
  private async runAgenticPipeline(params: {
    language: string;
    sourceCode: string;
    semgrepFindings: SemgrepFinding[];
    projectRoot: string;
    files: string[];
  }): Promise<VulnerabilityResponse[]> {
    const { language, sourceCode, semgrepFindings, projectRoot, files } = params;

    const state: AnalysisState = {
      goal: 'Identify, classify, and verify real security vulnerabilities in the submitted code.',
      language,
      files,
      semgrepFindings,
      candidateFindings: [],
      classifiedFindings: [],
      verifiedById: new Map(),
      knowledge: [],
      evidence: [],
      actionsTaken: [],
      iteration: 0,
      toolCallCount: 0,
      status: 'RUNNING'
    };

    const tools = createToolRegistry(
      {
        detectionAgent: this.deps.detectionAgent,
        classificationAgent: this.deps.classificationAgent,
        verificationAgent: this.deps.verificationAgent,
        semgrepService: this.deps.semgrepService,
        ragService: this.deps.ragService,
        codeSearchService: this.deps.codeSearchService
      },
      {
        projectRoot,
        language,
        getSourceView: () =>
          state.evidence.length === 0
            ? sourceCode
            : [sourceCode, '\n--- Additional evidence gathered during analysis ---', ...state.evidence].join('\n')
      }
    );

    logger.info('[Agent] Starting security analysis');

    const deadline = Date.now() + env.agent.maxAnalysisTimeMs;

    while (state.status === 'RUNNING') {
      state.iteration++;

      if (state.iteration > env.agent.maxIterations) {
        logger.warn('[Agent] Max iterations reached, finishing');
        break;
      }
      if (state.toolCallCount >= env.agent.maxToolCalls) {
        logger.warn('[Agent] Max tool calls reached, finishing');
        break;
      }
      if (Date.now() > deadline) {
        logger.warn('[Agent] Max analysis time reached, finishing');
        break;
      }

      const decision = await this.deps.managerAgent.decide(state);
      logger.info({ action: decision.action, reason: decision.reason }, `[Agent] Decision: ${decision.action}`);

      if (decision.action === 'FINISH') break;

      const handler = tools[decision.action];
      state.toolCallCount++;

      try {
        const { resultSummary } = await handler(state, decision.arguments);
        state.actionsTaken.push({ iteration: state.iteration, action: decision.action, reason: decision.reason, resultSummary });
        logger.info({ result: resultSummary }, `[Tool] ${decision.action} completed`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown tool error';
        state.actionsTaken.push({ iteration: state.iteration, action: decision.action, reason: decision.reason, error: message });
        logger.warn({ err }, `[Tool] ${decision.action} failed; Manager will decide how to proceed`);
      }
    }

    state.status = 'DONE';
    return this.finalizeFindings(state);
  }

  private finalizeFindings(state: AnalysisState): VulnerabilityResponse[] {
    const merged: VulnerabilityResponse[] = [];
    let unresolved = 0;

    for (const finding of state.classifiedFindings) {
      const verdict = state.verifiedById.get(finding.id);

      if (!verdict || verdict.status !== 'CONFIRMED') {
        // REJECTED findings must never appear in the response. Findings
        // that never got a verdict, or remained UNCERTAIN when the loop
        // ended (e.g. a safety limit was hit), are dropped conservatively
        // rather than shipped unverified.
        if (!verdict || verdict.status === 'UNCERTAIN') unresolved++;
        continue;
      }

      merged.push({
        id: finding.id,
        title: finding.title,
        cwe: finding.cwe,
        severity: finding.severity,
        confidence: finding.confidence,
        location: finding.location,
        explanation: finding.explanation,
        recommendation: finding.recommendation,
        verification: { status: verdict.status, confidence: verdict.confidence }
      });
    }

    if (unresolved > 0) {
      logger.warn({ unresolved }, '[Agent] Finished with unresolved/uncertain findings dropped from the response');
    }

    return merged;
  }

  private async runSemgrepSafely(dir: string, language: string, _hint: string): Promise<SemgrepFinding[]> {
    try {
      return await this.deps.semgrepService.scan({ targetDir: dir, language });
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.SEMGREP_NOT_INSTALLED) {
        logger.error('Semgrep is not installed; continuing with LLM-only detection (no Semgrep evidence).');
        return [];
      }
      throw err;
    }
  }

  private async persist(params: {
    language: string;
    codeHash: string;
    sourceType: 'PASTE' | 'ZIP';
    durationMs: number;
    vulnerabilities: VulnerabilityResponse[];
  }): Promise<string> {
    try {
      const analysis = await this.deps.prisma.analysis.create({
        data: {
          language: params.language,
          codeHash: params.codeHash,
          sourceType: params.sourceType,
          status: 'COMPLETED',
          completedAt: new Date(),
          durationMs: params.durationMs,
          findings: {
            create: params.vulnerabilities.map((v) => ({
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
              verificationStatus: v.verification.status,
              verificationReason: 'See explanation'
            }))
          }
        }
      });
      return analysis.id;
    } catch (err) {
      logger.error({ err }, 'Failed to persist analysis; returning results without storage');
      // Persistence is important but should not block returning results to
      // the caller if the DB is temporarily unavailable in this prototype.
      return crypto.randomUUID();
    }
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
      javascript: '.js',
      typescript: '.ts',
      python: '.py',
      java: '.java',
      go: '.go',
      c: '.c',
      cpp: '.cpp',
      ruby: '.rb',
      php: '.php',
      csharp: '.cs'
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
      if (count > bestCount) {
        best = langId;
        bestCount = count;
      }
    }
    return best || 'unknown';
  }
}
