import { FakeLlmService } from '../fixtures/fake-llm.service';
import { DetectionAgent } from '../../src/agents/detection.agent';
import { ClassificationAgent } from '../../src/agents/classification.agent';
import { VerificationAgent } from '../../src/agents/verification.agent';
import { ManagerAgent } from '../../src/agents/manager.agent';
import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { RagService } from '../../src/services/rag/rag.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';

function buildOrchestrator(llm: FakeLlmService) {
  const semgrepService = new SemgrepService();
  const ragService = { retrieve: jest.fn().mockResolvedValue([]) } as unknown as RagService;
  const prisma = { analysis: { create: jest.fn().mockResolvedValue({ id: 'analysis-1' }) } } as any;

  return new AnalysisOrchestrator({
    detectionAgent: new DetectionAgent(llm),
    classificationAgent: new ClassificationAgent(llm),
    verificationAgent: new VerificationAgent(llm),
    managerAgent: new ManagerAgent(llm),
    semgrepService,
    ragService,
    codeContextService: new CodeContextService(),
    codeSearchService: new CodeSearchService(),
    prisma
  });
}

describe('Abort on client disconnect', () => {
  it('aborts the analysis when signal is triggered before LLM responds', async () => {
    const llm = new FakeLlmService();

    // Manager decides to detect; detection agent will hang until abort
    llm.enqueue({ action: 'DETECT_VULNERABILITIES', arguments: {}, reason: 'start' });
    llm.enqueueHang(); // detection LLM call hangs

    const orchestrator = buildOrchestrator(llm);
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
    const llm = new FakeLlmService();
    const orchestrator = buildOrchestrator(llm);

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
    expect(llm.calls).toHaveLength(0);
  });

  it('FakeLlmService.enqueueHang rejects on abort signal', async () => {
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
