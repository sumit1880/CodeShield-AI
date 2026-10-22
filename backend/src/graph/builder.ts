// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { StateGraph, END, START } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PrismaPgvectorRetriever } from '../services/rag/prisma-retriever';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { CodeSearchService } from '../services/code-context/code-search.service';
import {
  semgrepNode,
  detectNode,
  classifyNode,
  verifyNode,
  reanalyzeNode,
  ragNode,
  codeSearchNode,
  codeAnalyzeNode,
  managerNode,
  finalizeNode
} from './nodes/index';
import { routeFromManager, routeFromWorker } from './router';
import { AnalysisGraphAnnotation, AnalysisGraphState } from './state';

export interface GraphDeps {
  detectionModel: BaseChatModel;
  verificationModel: BaseChatModel;
  retriever: PrismaPgvectorRetriever;
  semgrepService: SemgrepService;
  codeSearchService: CodeSearchService;
  signal?: AbortSignal;
}

/**
 * Builds and compiles the analysis StateGraph.
 *
 * All non-terminal nodes route through the same conditional edge function
 * which enforces safety limits before deterministic overrides before
 * the manager's LLM decision.
 *
 * Note: `as any` casts on addEdge/addConditionalEdges are necessary because
 * TypeScript's incremental generic inference can't track dynamically registered
 * node names at call-site. Runtime behavior is fully correct — nodes are
 * validated by LangGraph at graph construction time.
 */
export function buildAnalysisGraph(deps: GraphDeps) {
  // Cast to any-typed builder so we can add edges without fighting TypeScript's
  // incremental generic accumulation. The actual correctness is enforced by
  // LangGraph's runtime node registration checks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graph = new StateGraph(AnalysisGraphAnnotation) as any;

  // ── Node Registration ────────────────────────────────────────────────────
  graph.addNode('manager',      managerNode({ model: deps.detectionModel, signal: deps.signal }));
  graph.addNode('detect',       detectNode({ model: deps.detectionModel, signal: deps.signal }));
  graph.addNode('classify',     classifyNode({ model: deps.detectionModel, signal: deps.signal }));
  graph.addNode('verify',       verifyNode({ model: deps.verificationModel, signal: deps.signal }));
  graph.addNode('reanalyze',    reanalyzeNode({ model: deps.verificationModel, signal: deps.signal }));
  graph.addNode('rag',          ragNode({ retriever: deps.retriever }));
  graph.addNode('code_search',  codeSearchNode({ codeSearchService: deps.codeSearchService }));
  graph.addNode('code_analyze', codeAnalyzeNode({ codeSearchService: deps.codeSearchService }));
  graph.addNode('run_semgrep',  semgrepNode({ semgrepService: deps.semgrepService, signal: deps.signal }));
  graph.addNode('finalize',     finalizeNode());

  // ── Entry edge: START → manager ──────────────────────────────────────────
  graph.addEdge(START, 'manager');

  // ── Conditional edges: manager uses routeFromManager ─────────────────────
  graph.addConditionalEdges('manager', (state: AnalysisGraphState) =>
    routeFromManager(state, deps.signal)
  );

  // ── Conditional edges: worker nodes use routeFromWorker ──────────────────
  const workerNodes = [
    'detect', 'classify', 'verify', 'reanalyze',
    'rag', 'code_search', 'code_analyze', 'run_semgrep'
  ];

  for (const nodeName of workerNodes) {
    graph.addConditionalEdges(nodeName, (state: AnalysisGraphState) =>
      routeFromWorker(state, deps.signal)
    );
  }

  // ── Terminal edge: finalize → END ────────────────────────────────────────
  graph.addEdge('finalize', END);

  return graph.compile();
}
