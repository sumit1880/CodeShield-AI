import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { DetectionAgent } from '../../src/agents/detection.agent';
import { ClassificationAgent } from '../../src/agents/classification.agent';
import { VerificationAgent } from '../../src/agents/verification.agent';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { RagService } from '../../src/services/rag/rag.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { FakeLlmService } from '../fixtures/fake-llm.service';
import { VULNERABLE_SNIPPETS } from '../fixtures/vulnerable-code';

function buildOrchestrator(llm: FakeLlmService, prismaCreateMock = jest.fn().mockResolvedValue({ id: 'analysis-1' })) {
  const semgrepService = new SemgrepService();
  const ragService = { retrieve: jest.fn().mockResolvedValue([]) } as unknown as RagService;
  const prisma = { analysis: { create: prismaCreateMock } } as any;

  return new AnalysisOrchestrator({
    detectionAgent: new DetectionAgent(llm),
    classificationAgent: new ClassificationAgent(llm),
    verificationAgent: new VerificationAgent(llm),
    semgrepService,
    ragService,
    codeContextService: new CodeContextService(),
    prisma
  });
}

describe('AnalysisOrchestrator full pipeline (mocked LLM)', () => {
  it('runs Semgrep -> Agent1 -> Agent2 -> Agent3 -> final output, filtering rejected findings', async () => {
    const llm = new FakeLlmService();

    // Agent 1 (Detection): find two candidates.
    llm.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'SQL Injection',
          category: 'Injection',
          evidence: "string concatenation into db.query",
          file: 'submission.js',
          lineStart: 3,
          lineEnd: 5
        },
        {
          id: 'F2',
          title: 'Possible weak check',
          category: 'Other',
          evidence: 'looks suspicious but likely fine',
          file: 'submission.js',
          lineStart: 1,
          lineEnd: 2
        }
      ]
    });

    // Agent 2 (Classification): classify both.
    llm.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'SQL Injection',
          cwe: { id: 'CWE-89', name: 'Improper Neutralization of Special Elements used in an SQL Command' },
          severity: 'HIGH',
          confidence: 0.95,
          location: { file: 'submission.js', function: 'getUser', lineStart: 3, lineEnd: 5 },
          explanation: 'User-controlled input is concatenated into a SQL query string.',
          recommendation: 'Use parameterized queries.'
        },
        {
          id: 'F2',
          title: 'Possible weak check',
          cwe: { id: 'CWE-20', name: 'Improper Input Validation' },
          severity: 'LOW',
          confidence: 0.4,
          location: { file: 'submission.js', function: null, lineStart: 1, lineEnd: 2 },
          explanation: 'Uncertain whether this is exploitable.',
          recommendation: 'Review manually.'
        }
      ]
    });

    // Agent 3 (Verification): confirm F1, reject F2.
    llm.enqueue({
      findings: [
        { id: 'F1', status: 'CONFIRMED', confidence: 0.97, reason: 'Matches known SQLi pattern and data flow.' },
        { id: 'F2', status: 'REJECTED', confidence: 0.6, reason: 'No actual untrusted input reaches this code.' }
      ]
    });

    const prismaCreateMock = jest.fn().mockResolvedValue({ id: 'analysis-1' });
    const orchestrator = buildOrchestrator(llm, prismaCreateMock);

    const result = await orchestrator.analyzePastedCode({
      language: VULNERABLE_SNIPPETS.sqlInjection.language,
      code: VULNERABLE_SNIPPETS.sqlInjection.code
    });

    // Exactly 3 LLM calls total for the whole analysis.
    expect(llm.calls.length).toBe(3);

    // Only the CONFIRMED finding survives.
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].id).toBe('F1');
    expect(result.vulnerabilities[0].verification.status).toBe('CONFIRMED');
    expect(result.summary.totalIssues).toBe(1);
    expect(result.summary.high).toBe(1);

    // Persistence was attempted with only the confirmed finding.
    expect(prismaCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = prismaCreateMock.mock.calls[0][0];
    expect(createArgs.data.findings.create).toHaveLength(1);
  }, 30000);

  it('short-circuits (no Agent 2/3 calls) when Agent 1 finds nothing', async () => {
    const llm = new FakeLlmService();
    llm.enqueue({ findings: [] });

    const orchestrator = buildOrchestrator(llm);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n'
    });

    expect(llm.calls.length).toBe(1);
    expect(result.vulnerabilities).toHaveLength(0);
  }, 30000);
});
