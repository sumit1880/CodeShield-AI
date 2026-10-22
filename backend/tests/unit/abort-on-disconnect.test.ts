import { FakeChatModel } from '../../src/llm/fake-chat-model';
import { FakeLlmService } from '../fixtures/fake-llm.service';
import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';

function buildOrchestrator(model: FakeChatModel) {
  const semgrepService = new SemgrepService();
  const retriever = { retrieveKnowledge: jest.fn().mockResolvedValue([]), _getRelevantDocuments: jest.fn().mockResolvedValue([]) } as any;
  const prisma = { analysis: { create: jest.fn().mockResolvedValue({ id: 'analysis-1' }) } } as any;

  return new AnalysisOrchestrator({
    detectionModel: model,
    verificationModel: model,
    semgrepService,
    retriever,
    codeContextService: new CodeContextService(),
    codeSearchService: new CodeSearchService(),
    prisma
  });
}

describe('Abort on client disconnect', () => {
  it('aborts the analysis when signal is triggered before LLM responds', async () => {
    const model = new FakeChatModel();

    // Manager decides to detect; detection model hangs until abort
    model.enqueue({ action: 'DETECT_VULNERABILITIES', arguments: {}, reason: 'start' });
    model.enqueueHang(); // detection LLM call hangs

    const orchestrator = buildOrchestrator(model);
    const abortController = new AbortController();

    const analysisPromise = orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'const x = 1;',
      signal: abortController.signal
    });

    // Give it a tick to start, then abort
    await new Promise((r) => setImmediate(r));
    abortController.abort();

    await expect(analysisPromise).rejects.toThrow();
  });

  it('aborts immediately if signal is already aborted before starting', async () => {
    const model = new FakeChatModel();
    const orchestrator = buildOrchestrator(model);

    const abortController = new AbortController();
    abortController.abort(); // already aborted

    await expect(
      orchestrator.analyzePastedCode({
        language: 'javascript',
        code: 'const x = 1;',
        signal: abortController.signal
      })
    ).rejects.toThrow();

    // No LLM calls should have been made
    expect(model.calls).toHaveLength(0);
  });

  it('FakeLlmService.enqueueHang rejects on abort signal (backward-compat)', async () => {
    // This test exercises the old FakeLlmService directly (not the orchestrator)
    // to ensure existing test infrastructure still works.
    const llm = new FakeLlmService();
    llm.enqueueHang();

    const abortController = new AbortController();
    const generatePromise = llm.generate({
      systemPrompt: 'sys',
      userPrompt: 'user',
      jsonMode: true,
      signal: abortController.signal
    });

    await new Promise((r) => setImmediate(r));
    abortController.abort(new Error('client disconnected'));

    await expect(generatePromise).rejects.toThrow('client disconnected');
  });
});
