import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AnalysisGraphState } from './state';

export type NodeName =
  | 'manager'
  | 'detect'
  | 'classify'
  | 'verify'
  | 'reanalyze'
  | 'rag'
  | 'code_search'
  | 'code_analyze'
  | 'run_semgrep'
  | 'finalize';

/**
 * Conditional edge router for the manager node.
 * Evaluates abort signal, safety limits, deterministic overrides, and the
 * manager's LLM decision.
 */
export function routeFromManager(
  state: AnalysisGraphState,
  signal?: AbortSignal
): NodeName {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Analysis aborted');
  }

  const now = Date.now();

  // Safety limits
  if (state.iteration > env.agent.maxIterations) {
    logger.warn({ iteration: state.iteration }, '[Router] Max iterations reached');
    return 'finalize';
  }
  if (state.toolCallCount >= env.agent.maxToolCalls) {
    logger.warn({ toolCallCount: state.toolCallCount }, '[Router] Max tool calls reached');
    return 'finalize';
  }
  if (state.deadline > 0 && now > state.deadline) {
    logger.warn('[Router] Deadline exceeded');
    return 'finalize';
  }

  // Deterministic: unclassified candidates must be classified first
  const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
  const unclassified = state.candidateFindings.filter((f) => !classifiedIds.has(f.id));
  if (unclassified.length > 0) {
    logger.info({ count: unclassified.length }, '[Router] Forcing classify (deterministic)');
    return 'classify';
  }

  // Deterministic: unverified classified findings must be verified
  const unverified = state.classifiedFindings.filter((f) => !state.verifiedById[f.id]);
  if (unverified.length > 0) {
    logger.info({ count: unverified.length }, '[Router] Forcing verify (deterministic)');
    return 'verify';
  }

  // Route based on manager decision
  const action = state.nextAction?.action;
  if (!action || action === 'FINISH') {
    return 'finalize';
  }

  const actionToNode: Record<string, NodeName> = {
    DETECT_VULNERABILITIES: 'detect',
    RUN_SEMGREP: 'run_semgrep',
    SEARCH_SECURITY_KNOWLEDGE: 'rag',
    SEARCH_CODE: 'code_search',
    ANALYZE_CODE: 'code_analyze',
    REANALYZE_FINDING: 'reanalyze',
    CLASSIFY_FINDING: 'classify',
    VERIFY_FINDING: 'verify'
  };

  const target = actionToNode[action];
  if (target) return target;

  logger.warn({ action }, '[Router] Unknown action, routing to finalize');
  return 'finalize';
}

/**
 * Conditional edge router for worker nodes (specialists and tools).
 * When a worker completes, enforces abort/safety limits, deterministic
 * classify/verify cascades, and otherwise routes back to the manager.
 */
export function routeFromWorker(
  state: AnalysisGraphState,
  signal?: AbortSignal
): NodeName {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Analysis aborted');
  }

  const now = Date.now();

  // Safety limits
  if (state.iteration > env.agent.maxIterations) {
    logger.warn({ iteration: state.iteration }, '[Router] Max iterations reached');
    return 'finalize';
  }
  if (state.toolCallCount >= env.agent.maxToolCalls) {
    logger.warn({ toolCallCount: state.toolCallCount }, '[Router] Max tool calls reached');
    return 'finalize';
  }
  if (state.deadline > 0 && now > state.deadline) {
    logger.warn('[Router] Deadline exceeded');
    return 'finalize';
  }

  // Deterministic: unclassified candidates must be classified first
  const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
  const unclassified = state.candidateFindings.filter((f) => !classifiedIds.has(f.id));
  if (unclassified.length > 0) {
    logger.info({ count: unclassified.length }, '[Router] Forcing classify from worker');
    return 'classify';
  }

  // Deterministic: unverified classified findings must be verified
  const unverified = state.classifiedFindings.filter((f) => !state.verifiedById[f.id]);
  if (unverified.length > 0) {
    logger.info({ count: unverified.length }, '[Router] Forcing verify from worker');
    return 'verify';
  }

  // Specialist work complete -> return to manager for next decision
  return 'manager';
}
