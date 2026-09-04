import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { ErrorCode } from '../../src/utils/errors';
import { FakeLlmService } from '../fixtures/fake-llm.service';
import { DetectionAgent } from '../../src/agents/detection.agent';
import { ClassificationAgent } from '../../src/agents/classification.agent';
import { VerificationAgent } from '../../src/agents/verification.agent';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { RagService } from '../../src/services/rag/rag.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';
import { ManagerAgent } from '../../src/agents/manager.agent';

function buildOrchestrator() {
  const llm = new FakeLlmService();
  const semgrepService = new SemgrepService();
  const ragService = { retrieve: jest.fn().mockResolvedValue([]) } as unknown as RagService;
  const prisma = { analysis: { create: jest.fn() } } as any;

  const orchestrator = new AnalysisOrchestrator({
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

  return { orchestrator, llm };
}

describe('AnalysisOrchestrator validation (pasted code)', () => {
  it('rejects empty code', async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(orchestrator.analyzePastedCode({ language: 'javascript', code: '   ' })).rejects.toMatchObject({
      code: ErrorCode.EMPTY_CODE
    });
  });

  it('rejects unsupported language', async () => {
    const { orchestrator } = buildOrchestrator();
    await expect(
      orchestrator.analyzePastedCode({ language: 'cobol', code: 'DISPLAY "hi".' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_LANGUAGE });
  });

  it('rejects code exceeding the max line count', async () => {
    const { orchestrator } = buildOrchestrator();
    const bigCode = Array(10001).fill('const x = 1;').join('\n');
    await expect(orchestrator.analyzePastedCode({ language: 'javascript', code: bigCode })).rejects.toMatchObject({
      code: ErrorCode.CODE_TOO_LARGE
    });
  });

  it('rejects code exceeding the max character count', async () => {
    const { orchestrator } = buildOrchestrator();
    const bigCode = 'a'.repeat(500001);
    await expect(orchestrator.analyzePastedCode({ language: 'javascript', code: bigCode })).rejects.toMatchObject({
      code: ErrorCode.CODE_TOO_LARGE
    });
  });
});
