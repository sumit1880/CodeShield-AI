import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { ErrorCode } from '../../src/utils/errors';
import { FakeChatModel } from '../../src/llm/fake-chat-model';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';

function buildOrchestrator() {
  const model = new FakeChatModel();
  const semgrepService = new SemgrepService();
  const retriever = { retrieveKnowledge: jest.fn().mockResolvedValue([]), _getRelevantDocuments: jest.fn().mockResolvedValue([]) } as any;
  const prisma = { analysis: { create: jest.fn() } } as any;

  const orchestrator = new AnalysisOrchestrator({
    detectionModel: model,
    verificationModel: model,
    semgrepService,
    retriever,
    codeContextService: new CodeContextService(),
    codeSearchService: new CodeSearchService(),
    prisma
  });

  return { orchestrator, model };
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
