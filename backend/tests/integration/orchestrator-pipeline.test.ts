import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { DetectionAgent } from '../../src/agents/detection.agent';
import { ClassificationAgent } from '../../src/agents/classification.agent';
import { VerificationAgent } from '../../src/agents/verification.agent';
import { ManagerAgent } from '../../src/agents/manager.agent';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { RagService } from '../../src/services/rag/rag.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';
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
    managerAgent: new ManagerAgent(llm),
    semgrepService,
    ragService,
    codeContextService: new CodeContextService(),
    codeSearchService: new CodeSearchService(),
    prisma
  });
}

function managerDecision(action: string, reason: string, args: Record<string, unknown> = {}) {
  return { action, arguments: args, reason };
}

describe('AnalysisOrchestrator bounded autonomous pipeline (mocked LLM)', () => {
  it('Manager drives Semgrep -> Detection -> Classification -> Verification -> Finish, filtering rejected findings', async () => {
    const llm = new FakeLlmService();

    // Detection is still a genuine Manager choice (nothing to classify/verify yet).
    llm.enqueue(managerDecision('DETECT_VULNERABILITIES', 'No candidates yet, run detection'));

    llm.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'SQL Injection',
          category: 'Injection',
          evidence: 'string concatenation into db.query',
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

    // CLASSIFY_FINDING is now forced deterministically by the orchestrator
    // as soon as unclassified candidates exist — no Manager decision needed.
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

    // VERIFY_FINDING is likewise forced deterministically right after
    // classification completes — this is the fix for the production bug
    // where the Manager could stall indefinitely before ever verifying.
    llm.enqueue({
      findings: [
        { id: 'F1', status: 'CONFIRMED', confidence: 0.97, reason: 'Matches known SQLi pattern and data flow.' },
        { id: 'F2', status: 'REJECTED', confidence: 0.6, reason: 'No actual untrusted input reaches this code.' }
      ]
    });

    llm.enqueue(managerDecision('FINISH', 'All findings verified'));

    const prismaCreateMock = jest.fn().mockResolvedValue({ id: 'analysis-1' });
    const orchestrator = buildOrchestrator(llm, prismaCreateMock);

    const result = await orchestrator.analyzePastedCode({
      language: VULNERABLE_SNIPPETS.sqlInjection.language,
      code: VULNERABLE_SNIPPETS.sqlInjection.code
    });

    // 2 Manager decisions (DETECT, FINISH) + 3 specialist calls = 5 LLM calls total.
    expect(llm.calls.length).toBe(5);

    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].id).toBe('finding-1');
    expect(result.vulnerabilities[0].verification.status).toBe('CONFIRMED');
    expect(result.summary.totalIssues).toBe(1);
    expect(result.summary.high).toBe(1);
    expect(result.partial).toBe(false);
    expect(result.analysisStatus).toBe('COMPLETE');
    expect(result.uncertainFindings).toHaveLength(0);

    expect(prismaCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = prismaCreateMock.mock.calls[0][0];
    expect(createArgs.data.findings.create).toHaveLength(1);
  }, 30000);

  it('Manager finishes without calling every specialist when Detection finds nothing', async () => {
    const llm = new FakeLlmService();

    llm.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Check for candidates'));
    llm.enqueue({ findings: [] });
    llm.enqueue(managerDecision('FINISH', 'No candidates found, nothing to classify or verify'));

    const orchestrator = buildOrchestrator(llm);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n'
    });

    // 2 Manager decisions + 1 Detection call; Classification/Verification never invoked.
    expect(llm.calls.length).toBe(3);
    expect(result.vulnerabilities).toHaveLength(0);
  }, 30000);

  it('Manager dynamically investigates an UNCERTAIN finding before confirming it (adaptive path)', async () => {
    const llm = new FakeLlmService();

    llm.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Run detection first'));
    llm.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'Possible command injection',
          category: 'Injection',
          evidence: 'user input passed near exec call',
          file: 'submission.js',
          lineStart: 1,
          lineEnd: 2
        }
      ]
    });

    // CLASSIFY_FINDING and VERIFY_FINDING are forced deterministically —
    // no Manager decision consumed for either.
    llm.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'Possible command injection',
          cwe: { id: 'CWE-78', name: 'OS Command Injection' },
          severity: 'HIGH',
          confidence: 0.5,
          location: { file: 'submission.js', function: null, lineStart: 1, lineEnd: 2 },
          explanation: 'Unclear whether input is sanitized before use.',
          recommendation: 'Avoid shell execution with user input.'
        }
      ]
    });

    llm.enqueue({
      findings: [{ id: 'F1', status: 'UNCERTAIN', confidence: 0.5, reason: 'Cannot tell if input is sanitized elsewhere.' }]
    });

    llm.enqueue(managerDecision('SEARCH_CODE', 'Look for sanitization near the call site', { query: 'function' }));
    llm.enqueue(managerDecision('REANALYZE_FINDING', 'Re-verify with the new evidence'));
    llm.enqueue({
      findings: [{ id: 'F1', status: 'CONFIRMED', confidence: 0.9, reason: 'No sanitization found in the surrounding code.' }]
    });

    llm.enqueue(managerDecision('FINISH', 'Finding resolved'));

    const orchestrator = buildOrchestrator(llm);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function run(cmd) { require("child_process").exec(cmd); }\n'
    });

    // Detection(1)+Classification(1)+Verification(1)+Reanalyze(1) specialist calls
    // + 4 Manager decisions (DETECT, SEARCH_CODE, REANALYZE_FINDING, FINISH) = 8.
    expect(llm.calls.length).toBe(8);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].verification.status).toBe('CONFIRMED');
    expect(result.uncertainFindings).toHaveLength(0);
    expect(result.partial).toBe(false);
  }, 30000);

  it('stops at the hard iteration limit even if the Manager keeps requesting more work', async () => {
    const llm = new FakeLlmService();

    // Default AGENT_MAX_ITERATIONS=10: queue 10 rounds of (decide, detect-nothing).
    // The backend must stop after 10 iterations without a 11th Manager call,
    // regardless of what the Manager would have said.
    for (let i = 0; i < 10; i++) {
      llm.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Keep looking'));
      llm.enqueue({ findings: [] });
    }

    const orchestrator = buildOrchestrator(llm);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function add(a, b) { return a + b; }\n'
    });

    expect(llm.calls.length).toBe(20); // exactly 10 iterations worth; no 11th Manager call
    expect(result.vulnerabilities).toHaveLength(0);
    // Stopped by a hard safety limit rather than a clean Manager FINISH.
    expect(result.partial).toBe(true);
    expect(result.analysisStatus).toBe('PARTIAL');
  }, 30000);

  it('returns already-classified findings as uncertain/unverified instead of dropping them when the global timeout hits before verification', async () => {
    const originalTimeout = process.env.AGENT_MAX_ANALYSIS_TIME_MS;
    process.env.AGENT_MAX_ANALYSIS_TIME_MS = '50';
    jest.resetModules();

    try {
      const { AnalysisOrchestrator: FreshOrchestrator } = await import('../../src/orchestrator/analysis.orchestrator');
      const { DetectionAgent: FreshDetectionAgent } = await import('../../src/agents/detection.agent');
      const { ClassificationAgent: FreshClassificationAgent } = await import('../../src/agents/classification.agent');
      const { VerificationAgent: FreshVerificationAgent } = await import('../../src/agents/verification.agent');
      const { ManagerAgent: FreshManagerAgent } = await import('../../src/agents/manager.agent');
      const { SemgrepService: FreshSemgrepService } = await import('../../src/services/semgrep/semgrep.service');

      const llm = new FakeLlmService();
      // Detection: a genuine Manager choice.
      llm.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Run detection'));
      llm.enqueue({
        findings: [
          {
            id: 'F1',
            title: 'SQL Injection',
            category: 'Injection',
            evidence: 'string concatenation into db.query',
            file: 'submission.js',
            lineStart: 3,
            lineEnd: 5
          }
        ]
      });
      // Classification is forced deterministically. Delay this response past
      // the 50ms budget so the loop's next deadline check trips *before*
      // VERIFY_FINDING can run, simulating the production timeout.
      llm.enqueue(
        {
          findings: [
            {
              id: 'F1',
              title: 'SQL Injection',
              cwe: { id: 'CWE-89', name: 'Improper Neutralization of Special Elements used in an SQL Command' },
              severity: 'HIGH',
              confidence: 0.9,
              location: { file: 'submission.js', function: 'getUser', lineStart: 3, lineEnd: 5 },
              explanation: 'User-controlled input is concatenated into a SQL query string.',
              recommendation: 'Use parameterized queries.'
            }
          ]
        },
        200
      );

      const ragService = { retrieve: jest.fn().mockResolvedValue([]) } as any;
      const prisma = { analysis: { create: jest.fn().mockResolvedValue({ id: 'analysis-timeout' }) } } as any;
      const { CodeContextService: FreshCodeContextService } = await import('../../src/services/code-context/code-context.service');
      const { CodeSearchService: FreshCodeSearchService } = await import('../../src/services/code-context/code-search.service');

      const orchestrator = new FreshOrchestrator({
        detectionAgent: new FreshDetectionAgent(llm),
        classificationAgent: new FreshClassificationAgent(llm),
        verificationAgent: new FreshVerificationAgent(llm),
        managerAgent: new FreshManagerAgent(llm),
        semgrepService: new FreshSemgrepService(),
        ragService,
        codeContextService: new FreshCodeContextService(),
        codeSearchService: new FreshCodeSearchService(),
        prisma
      });

      const result = await orchestrator.analyzePastedCode({
        language: 'javascript',
        code: "function getUser(db, req, res) {\n  db.query(\"SELECT * FROM users WHERE id = '\" + req.query.id + \"'\");\n}\n"
      });

      // The timeout must NOT silently erase the already-classified finding,
      // and must NEVER upgrade it to CONFIRMED just because time ran out.
      expect(result.vulnerabilities).toHaveLength(0);
      expect(result.uncertainFindings).toHaveLength(1);
      expect(result.uncertainFindings[0].id).toBe('finding-1');
      expect(result.uncertainFindings[0].verification.status).toBe('UNVERIFIED');
      expect(result.partial).toBe(true);
      expect(result.analysisStatus).toBe('PARTIAL');
    } finally {
      process.env.AGENT_MAX_ANALYSIS_TIME_MS = originalTimeout;
      jest.resetModules();
    }
  }, 30000);
});
