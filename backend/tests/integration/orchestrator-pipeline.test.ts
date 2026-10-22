/**
 * Integration tests for the LangGraph-based analysis pipeline.
 * Uses FakeChatModel (BaseChatModel subclass) to simulate LLM responses
 * deterministically without real API calls.
 */
import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';
import { FakeChatModel } from '../../src/llm/fake-chat-model';
import { VULNERABLE_SNIPPETS } from '../fixtures/vulnerable-code';

function buildOrchestrator(
  model: FakeChatModel,
  verificationModel?: FakeChatModel,
  prismaCreateMock = jest.fn().mockResolvedValue({ id: 'analysis-1' })
) {
  const semgrepService = new SemgrepService();
  const retriever = {
    retrieveKnowledge: jest.fn().mockResolvedValue([]),
    _getRelevantDocuments: jest.fn().mockResolvedValue([])
  } as any;
  const prisma = { analysis: { create: prismaCreateMock } } as any;

  return new AnalysisOrchestrator({
    detectionModel: model,
    verificationModel: verificationModel ?? model,
    semgrepService,
    retriever,
    codeContextService: new CodeContextService(),
    codeSearchService: new CodeSearchService(),
    prisma
  });
}

function managerDecision(action: string, reason: string, args: Record<string, unknown> = {}) {
  return { action, arguments: args, reason };
}

describe('AnalysisOrchestrator bounded autonomous pipeline (LangGraph + FakeChatModel)', () => {
  it('Manager drives Detection -> Classification -> Verification -> Finish, filtering rejected findings', async () => {
    const model = new FakeChatModel();

    // Manager iter 1: choose DETECT
    model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'No candidates yet, run detection'));

    // DetectionAgent response
    model.enqueue({
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

    // CLASSIFY_FINDING is forced deterministically (unclassified candidates exist)
    model.enqueue({
      findings: [
        {
          id: 'finding-1',
          title: 'SQL Injection',
          cwe: { id: 'CWE-89', name: 'Improper Neutralization of Special Elements used in an SQL Command' },
          severity: 'HIGH',
          confidence: 0.95,
          location: { file: 'submission.js', function: 'getUser', lineStart: 3, lineEnd: 5 },
          explanation: 'User-controlled input is concatenated into a SQL query string.',
          recommendation: 'Use parameterized queries.'
        },
        {
          id: 'finding-2',
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

    // VERIFY_FINDING is forced deterministically after classification
    model.enqueue({
      findings: [
        { id: 'finding-1', status: 'CONFIRMED', confidence: 0.97, reason: 'Matches known SQLi pattern.' },
        { id: 'finding-2', status: 'REJECTED', confidence: 0.6, reason: 'No actual untrusted input reaches this code.' }
      ]
    });

    // Manager iter 2: FINISH
    model.enqueue(managerDecision('FINISH', 'All findings verified'));

    const prismaCreateMock = jest.fn().mockResolvedValue({ id: 'analysis-1' });
    const orchestrator = buildOrchestrator(model, undefined, prismaCreateMock);

    const result = await orchestrator.analyzePastedCode({
      language: VULNERABLE_SNIPPETS.sqlInjection.language,
      code: VULNERABLE_SNIPPETS.sqlInjection.code
    });

    // 2 Manager calls + 1 Detect + 1 Classify + 1 Verify = 5 LLM calls
    expect(model.calls.length).toBe(5);

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
    const model = new FakeChatModel();

    model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Check for candidates'));
    model.enqueue({ findings: [] });
    model.enqueue(managerDecision('FINISH', 'No candidates found'));

    const orchestrator = buildOrchestrator(model);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n'
    });

    // 2 Manager + 1 Detect; no classify or verify invoked
    expect(model.calls.length).toBe(3);
    expect(result.vulnerabilities).toHaveLength(0);
  }, 30000);

  it('Manager dynamically investigates an UNCERTAIN finding before confirming it', async () => {
    const model = new FakeChatModel();

    model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Run detection first'));
    model.enqueue({
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

    // Forced: classify
    model.enqueue({
      findings: [
        {
          id: 'finding-1',
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

    // Forced: verify -> UNCERTAIN
    model.enqueue({
      findings: [{ id: 'finding-1', status: 'UNCERTAIN', confidence: 0.5, reason: 'Cannot tell if sanitized.' }]
    });

    // Manager: gather evidence
    model.enqueue(managerDecision('SEARCH_CODE', 'Look for sanitization', { query: 'function' }));
    // Manager: reanalyze
    model.enqueue(managerDecision('REANALYZE_FINDING', 'Re-verify with evidence'));
    // Reanalyze response
    model.enqueue({
      findings: [{ id: 'finding-1', status: 'CONFIRMED', confidence: 0.9, reason: 'No sanitization found.' }]
    });

    // Manager: FINISH
    model.enqueue(managerDecision('FINISH', 'Finding resolved'));

    const orchestrator = buildOrchestrator(model);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function run(cmd) { require("child_process").exec(cmd); }\n'
    });

    // 1 Detect + 1 Classify + 1 Verify + 1 Reanalyze + 4 Manager = 8 calls
    expect(model.calls.length).toBe(8);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].verification.status).toBe('CONFIRMED');
    expect(result.uncertainFindings).toHaveLength(0);
    expect(result.partial).toBe(false);
  }, 30000);

  it('stops at the hard iteration limit even if the Manager keeps requesting more work', async () => {
    const model = new FakeChatModel();

    // default maxIterations=10; queue enough for 10 rounds
    for (let i = 0; i < 12; i++) {
      model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Keep looking'));
      model.enqueue({ findings: [] });
    }

    const orchestrator = buildOrchestrator(model);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'function add(a, b) { return a + b; }\n'
    });

    // Stopped by safety limit; no confirmed vulnerabilities
    expect(result.vulnerabilities).toHaveLength(0);
    // Stopped by a hard safety limit rather than a clean Manager FINISH
    expect(result.partial).toBe(true);
    expect(result.analysisStatus).toBe('PARTIAL');
  }, 30000);

  it('returns classified findings as unverified instead of dropping them when deadline hits', async () => {
    const model = new FakeChatModel();

    // Manager: detect
    model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'Run detection'));
    model.enqueue({
      findings: [{
        id: 'F1',
        title: 'SQL Injection',
        category: 'Injection',
        evidence: 'concat into query',
        file: 'submission.js',
        lineStart: 3,
        lineEnd: 5
      }]
    });

    // Classification — delayed 300ms to trip the 50ms deadline
    model.enqueue(
      {
        findings: [{
          id: 'finding-1',
          title: 'SQL Injection',
          cwe: { id: 'CWE-89', name: 'Improper Neutralization of Special Elements used in an SQL Command' },
          severity: 'HIGH',
          confidence: 0.9,
          location: { file: 'submission.js', function: 'getUser', lineStart: 3, lineEnd: 5 },
          explanation: 'User-controlled input is concatenated into a SQL query string.',
          recommendation: 'Use parameterized queries.'
        }]
      },
      250 // delay > the 50ms budget set below
    );

    const originalTimeout = process.env.AGENT_MAX_ANALYSIS_TIME_MS;
    process.env.AGENT_MAX_ANALYSIS_TIME_MS = '50';
    jest.resetModules();

    try {
      const { AnalysisOrchestrator: FreshOrchestrator } = await import('../../src/orchestrator/analysis.orchestrator');
      const { SemgrepService: FreshSemgrepService } = await import('../../src/services/semgrep/semgrep.service');
      const { CodeContextService: FreshCodeContextService } = await import('../../src/services/code-context/code-context.service');
      const { CodeSearchService: FreshCodeSearchService } = await import('../../src/services/code-context/code-search.service');

      const retriever = { retrieveKnowledge: jest.fn().mockResolvedValue([]), _getRelevantDocuments: jest.fn().mockResolvedValue([]) } as any;
      const prisma = { analysis: { create: jest.fn().mockResolvedValue({ id: 'analysis-timeout' }) } } as any;

      const orchestrator = new FreshOrchestrator({
        detectionModel: model,
        verificationModel: model,
        semgrepService: new FreshSemgrepService(),
        retriever,
        codeContextService: new FreshCodeContextService(),
        codeSearchService: new FreshCodeSearchService(),
        prisma
      });

      const result = await orchestrator.analyzePastedCode({
        language: 'javascript',
        code: "function getUser(db, req, res) {\n  db.query(\"SELECT * FROM users WHERE id = '\" + req.query.id + \"'\");\n}\n"
      });

      // Timeout must NOT silently drop the classified finding, and must NOT
      // upgrade it to CONFIRMED — it must appear as UNVERIFIED
      expect(result.vulnerabilities).toHaveLength(0);
      expect(result.uncertainFindings).toHaveLength(1);
      expect(result.uncertainFindings[0].verification.status).toBe('UNVERIFIED');
      expect(result.partial).toBe(true);
      expect(result.analysisStatus).toBe('PARTIAL');
    } finally {
      process.env.AGENT_MAX_ANALYSIS_TIME_MS = originalTimeout;
      jest.resetModules();
    }
  }, 30000);
});
