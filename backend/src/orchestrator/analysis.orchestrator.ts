import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { DetectionAgent } from '../agents/detection.agent';
import { ClassificationAgent } from '../agents/classification.agent';
import { VerificationAgent } from '../agents/verification.agent';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { RagService } from '../services/rag/rag.service';
import { CodeContextService } from '../services/code-context/code-context.service';
import { withTempDir } from '../utils/temp-workspace';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';
import { isSupportedLanguage, languageForExtension } from '../config/languages';
import { env } from '../config/env';
import {
  AnalyzedFinding,
  CandidateFinding,
  SemgrepFinding,
  VerificationResult,
  VulnerabilityResponse
} from '../types/findings';
import fs from 'fs/promises';
import path from 'path';

export interface OrchestratorDeps {
  detectionAgent: DetectionAgent;
  classificationAgent: ClassificationAgent;
  verificationAgent: VerificationAgent;
  semgrepService: SemgrepService;
  ragService: RagService;
  codeContextService: CodeContextService;
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

      const result = await this.runPipeline({
        language,
        sourceCode: code,
        semgrepFindings: semgrepFindings.map((f) => ({ ...f, file: 'submission' + ext }))
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

    const result = await this.runPipeline({
      language: effectiveLanguage,
      sourceCode: sourceView || '// No Semgrep findings to provide context for.',
      semgrepFindings: normalizedFindings
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
  // Shared pipeline: Semgrep(already run) -> RAG -> Agent1 -> Agent2 -> Agent3 -> filter
  // -------------------------------------------------------------------
  private async runPipeline(params: {
    language: string;
    sourceCode: string;
    semgrepFindings: SemgrepFinding[];
  }): Promise<VulnerabilityResponse[]> {
    const { language, sourceCode, semgrepFindings } = params;

    const knowledge = await this.deps.ragService.retrieve({
      query: `Common vulnerability classes and secure coding guidance relevant to ${language} code`,
      topK: 5
    });

    const detection = await this.deps.detectionAgent.run({ language, sourceCode, semgrepFindings });

    if (detection.findings.length === 0) {
      return [];
    }

    const classification = await this.deps.classificationAgent.run({
      language,
      sourceCode,
      findings: detection.findings,
      securityKnowledge: knowledge
    });

    if (classification.findings.length === 0) {
      return [];
    }

    const verification = await this.deps.verificationAgent.run({
      language,
      sourceCode,
      findings: classification.findings
    });

    return this.mergeAndFilter(classification.findings, verification.findings);
  }

  private mergeAndFilter(
    analyzed: AnalyzedFinding[],
    verifications: VerificationResult[]
  ): VulnerabilityResponse[] {
    const verificationById = new Map(verifications.map((v) => [v.id, v]));

    const merged: VulnerabilityResponse[] = [];
    for (const finding of analyzed) {
      const verdict = verificationById.get(finding.id);
      if (!verdict || verdict.status === 'REJECTED') {
        continue; // Rejected findings MUST NOT appear in the final response.
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
