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
import { AnalysisState, ManagerDecision } from '../types/agent-state';
import { SemgrepFinding, UncertainFindingResponse, VulnerabilityResponse } from '../types/findings';
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
  signal?: AbortSignal;
}

export interface AnalyzeProjectInput {
  language: string; // may be 'auto'
  files: Array<{ relativePath: string; absolutePath: string }>;
  projectRoot: string;
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
  id: string;
  language: string;
  summary: AnalysisSummary;
  vulnerabilities: VulnerabilityResponse[];
  /** Classified findings that are neither safely CONFIRMED nor REJECTED (see UncertainFindingResponse). */
  uncertainFindings: UncertainFindingResponse[];
  /** True when the analysis stopped (safety limits/timeout) before every finding reached a final verdict. */
  partial: boolean;
  analysisStatus: 'COMPLETE' | 'PARTIAL';
}

/** Result of turning final agent state into the client-facing finding lists. */
interface FinalizedFindings {
  vulnerabilities: VulnerabilityResponse[];
  uncertainFindings: UncertainFindingResponse[];
  rejectedCount: number;
  partial: boolean;
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
    const { language, code, signal } = input;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    this.validatePastedCode(language, code);

    return withTempDir(async (tempDir) => {
      const startedAt = Date.now();
      const ext = this.guessExtension(language);
      const filePath = path.join(tempDir, `submission${ext}`);
      await fs.writeFile(filePath, code, 'utf-8');

      if (signal?.aborted) {
        throw signal.reason ?? new Error('Aborted');
      }

      const semgrepFindings = await this.runSemgrepSafely(tempDir, language);
      const submissionFile = 'submission' + ext;

      const result = await this.runAgenticPipeline({
        language,
        sourceCode: code,
        semgrepFindings: semgrepFindings.map((f) => ({ ...f, file: submissionFile })),
        projectRoot: tempDir,
        files: [submissionFile],
        signal
      });

      const analysisId = await this.persist({
        language,
        codeHash: hashCode(code),
        sourceType: 'PASTE',
        durationMs: Date.now() - startedAt,
        vulnerabilities: result.vulnerabilities
      });

      return {
        id: analysisId,
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
    const { language, files, projectRoot, signal } = input;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

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

    const semgrepFindings = await this.runSemgrepSafely(projectRoot, language === 'auto' ? 'auto' : language);

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
      files: relevantFiles.map((f) => f.relativePath),
      signal
    });

    const analysisId = await this.persist({
      language: effectiveLanguage,
      codeHash: await this.hashProject(relevantFiles),
      sourceType: 'ZIP',
      durationMs: Date.now() - startedAt,
      vulnerabilities: result.vulnerabilities
    });

    return {
      id: analysisId,
      language: effectiveLanguage,
      summary: summarize(result.vulnerabilities),
      vulnerabilities: result.vulnerabilities,
      uncertainFindings: result.uncertainFindings,
      partial: result.partial,
      analysisStatus: result.partial ? 'PARTIAL' : 'COMPLETE'
    };
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
    signal?: AbortSignal;
  }): Promise<FinalizedFindings> {
    const { language, sourceCode, semgrepFindings, projectRoot, files, signal } = params;

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
        signal,
        getSourceView: () =>
          state.evidence.length === 0
            ? sourceCode
            : [sourceCode, '\n--- Additional evidence gathered during analysis ---', ...state.evidence].join('\n')
      }
    );

    logger.info('[Agent] Starting security analysis');

    const deadline = Date.now() + env.agent.maxAnalysisTimeMs;
    let stopReason: 'FINISHED' | 'MAX_ITERATIONS' | 'MAX_TOOL_CALLS' | 'TIMEOUT' = 'FINISHED';

    while (state.status === 'RUNNING') {
      if (signal?.aborted) {
        logger.info('[Agent] Analysis aborted by client disconnect');
        throw signal.reason ?? new Error('Aborted');
      }

      state.iteration++;

      if (state.iteration > env.agent.maxIterations) {
        logger.warn('[Agent] Max iterations reached, finishing');
        stopReason = 'MAX_ITERATIONS';
        break;
      }
      if (state.toolCallCount >= env.agent.maxToolCalls) {
        logger.warn('[Agent] Max tool calls reached, finishing');
        stopReason = 'MAX_TOOL_CALLS';
        break;
      }
      if (Date.now() > deadline) {
        logger.warn('[Agent] Max analysis time reached, finishing');
        stopReason = 'TIMEOUT';
        break;
      }

      // Deterministic pipeline progression: classification and verification
      // are never left to the Manager's discretion once there is pending
      // work for them, so the LLM cannot burn the whole time budget without
      // the pipeline moving Detection -> Classification -> Verification.
      // The Manager is only consulted for genuinely open choices: whether/how
      // to detect, how to investigate an UNCERTAIN finding, or when to FINISH.
      const forced = this.nextDeterministicAction(state);
      const decision: ManagerDecision = forced ?? (await this.deps.managerAgent.decide(state, signal));

      if (!forced) {
        logger.info({ action: decision.action, reason: decision.reason }, `[Agent] Decision: ${decision.action}`);
      }

      if (decision.action === 'FINISH') break;

      const handler = tools[decision.action];
      state.toolCallCount++;

      try {
        const { resultSummary } = await handler(state, decision.arguments);
        state.actionsTaken.push({ iteration: state.iteration, action: decision.action, reason: decision.reason, resultSummary });
        logger.info({ result: resultSummary }, `[Agent] ${decision.action} complete: ${resultSummary}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown tool error';
        state.actionsTaken.push({ iteration: state.iteration, action: decision.action, reason: decision.reason, error: message });
        logger.warn({ err }, `[Tool] ${decision.action} failed; continuing`);
      }
    }

    state.status = 'DONE';
    logger.info('[Agent] Finalizing findings');
    const finalized = this.finalizeFindings(state, stopReason);
    logger.info(
      { confirmed: finalized.vulnerabilities.length, uncertain: finalized.uncertainFindings.length, rejected: finalized.rejectedCount },
      `[Agent] Analysis completed: ${finalized.vulnerabilities.length} confirmed, ${finalized.uncertainFindings.length} uncertain`
    );
    logger.info(`[Agent] Analysis partial: ${finalized.partial}`);
    return finalized;
  }

  /**
   * Fixed, code-enforced priority (equivalent to):
   *   IF unclassified candidates exist       -> CLASSIFY_FINDING
   *   ELSE IF unverified classified findings  -> VERIFY_FINDING
   *   ELSE                                    -> null (let the Manager decide)
   * This guarantees Detection -> Classification -> Verification ordering and
   * that verification always gets priority right after classification,
   * without spending an LLM call on a decision that isn't actually a choice.
   */
  private nextDeterministicAction(state: AnalysisState): ManagerDecision | null {
    const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
    const unclassified = state.candidateFindings.filter((f) => !classifiedIds.has(f.id));
    if (unclassified.length > 0) {
      return { action: 'CLASSIFY_FINDING', arguments: {}, reason: `${unclassified.length} candidate finding(s) pending classification.` };
    }

    const unverified = state.classifiedFindings.filter((f) => !state.verifiedById.has(f.id));
    if (unverified.length > 0) {
      return { action: 'VERIFY_FINDING', arguments: {}, reason: `${unverified.length} classified finding(s) pending verification.` };
    }

    return null;
  }

  private finalizeFindings(state: AnalysisState, stopReason: 'FINISHED' | 'MAX_ITERATIONS' | 'MAX_TOOL_CALLS' | 'TIMEOUT'): FinalizedFindings {
    const vulnerabilities: VulnerabilityResponse[] = [];
    const uncertainFindings: UncertainFindingResponse[] = [];
    let rejectedCount = 0;

    for (const finding of state.classifiedFindings) {
      const verdict = state.verifiedById.get(finding.id);
      const base = {
        id: finding.id,
        title: finding.title,
        cwe: finding.cwe,
        severity: finding.severity,
        confidence: finding.confidence,
        location: finding.location,
        explanation: finding.explanation,
        recommendation: finding.recommendation
      };

      if (verdict?.status === 'CONFIRMED') {
        vulnerabilities.push({ ...base, verification: { status: 'CONFIRMED', confidence: verdict.confidence } });
      } else if (verdict?.status === 'REJECTED') {
        // Semgrep findings with severity ERROR are a floor:
        // the verifier may mark them UNCERTAIN but not silently REJECTED without a stored reason.
        const isSemgrepError = state.semgrepFindings.some((sf) => {
          if (sf.severity?.toUpperCase() !== 'ERROR') return false;
          const fileMatch =
            sf.file === finding.location.file ||
            path.normalize(sf.file) === path.normalize(finding.location.file) ||
            sf.file.endsWith(finding.location.file) ||
            finding.location.file.endsWith(sf.file);
          if (!fileMatch) return false;
          return Math.max(sf.lineStart, finding.location.lineStart) <= Math.min(sf.lineEnd, finding.location.lineEnd);
        });

        if (isSemgrepError && (!verdict.reason || !verdict.reason.trim())) {
          uncertainFindings.push({
            ...base,
            verification: {
              status: 'UNCERTAIN',
              confidence: verdict.confidence,
              reason: 'Semgrep ERROR finding cannot be silently REJECTED without a stored reason'
            }
          });
        } else {
          // Verified and explicitly rejected: never reported as a vulnerability.
          rejectedCount++;
        }
      } else if (verdict?.status === 'UNCERTAIN') {
        // The Verification Agent itself could not confirm or reject it.
        uncertainFindings.push({ ...base, verification: { status: 'UNCERTAIN', confidence: verdict.confidence, reason: verdict.reason } });
      } else {
        // Classified but never reached verification at all (e.g. the global
        // timeout hit first). Must not be silently dropped nor upgraded to
        // CONFIRMED — report it as UNVERIFIED instead.
        uncertainFindings.push({ ...base, verification: { status: 'UNVERIFIED', confidence: finding.confidence } });
      }
    }

    const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
    const unclassifiedCandidates = state.candidateFindings.filter((f) => !classifiedIds.has(f.id)).length;
    const partial = stopReason !== 'FINISHED' || unclassifiedCandidates > 0 || uncertainFindings.length > 0;

    if (uncertainFindings.length > 0 || unclassifiedCandidates > 0) {
      logger.warn(
        { uncertain: uncertainFindings.length, unclassifiedCandidates, stopReason },
        '[Agent] Finished with uncertain/unclassified findings; returning them separately instead of dropping them'
      );
    }

    return { vulnerabilities, uncertainFindings, rejectedCount, partial };
  }

  private async runSemgrepSafely(dir: string, language: string): Promise<SemgrepFinding[]> {
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

  /** Hash of paths + contents, so two different projects with the same file names don't collide. */
  private async hashProject(files: Array<{ relativePath: string; absolutePath: string }>): Promise<string> {
    const h = crypto.createHash('sha256');
    for (const f of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      h.update(f.relativePath);
      try {
        h.update(await fs.readFile(f.absolutePath));
      } catch {
        // unreadable file: path alone still goes into the hash
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
