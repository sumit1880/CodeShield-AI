/**
 * Tests for task-5 persistence fixes:
 *  - userId is stored on the Analysis record
 *  - Real verifier reason (not 'See explanation') is stored
 *  - UNCERTAIN findings are persisted
 *  - Status is PARTIAL when partial=true
 *  - persisted:false is returned (not a fake UUID) when DB save fails
 *
 * Migrated to use FakeChatModel + new OrchestratorDeps (LangGraph pipeline).
 */
import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';
import { FakeChatModel } from '../../src/llm/fake-chat-model';

function managerDecision(action: string, reason: string, args: Record<string, unknown> = {}) {
  return { action, arguments: args, reason };
}

function buildOrchestrator(model: FakeChatModel, prismaCreateMock: jest.Mock, verificationModel?: FakeChatModel) {
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

/**
 * Build an orchestrator whose LLM queue produces a single CONFIRMED SQLi finding.
 *
 * Sequence in the LangGraph pipeline:
 *   1. Manager → DETECT_VULNERABILITIES
 *   2. Detection agent → {findings:[F1]}
 *   3. Classification agent (forced, no Manager call) → {findings:[F1 classified]}
 *   4. Verification agent (forced, no Manager call) → {findings:[{id:F1,status:CONFIRMED,...}]}
 *   5. Manager → FINISH
 */
function buildOrchestratorWithSQLi(prismaCreateMock: jest.Mock) {
  const model = new FakeChatModel();

  // 1. Manager: detect
  model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'No candidates yet'));

  // 2. Detection: return one finding
  model.enqueue({
    findings: [
      {
        id: 'F1',
        title: 'SQL Injection',
        category: 'Injection',
        evidence: 'raw query concatenation',
        file: 'submission.js',
        lineStart: 2,
        lineEnd: 4
      }
    ]
  });

  // 3. Classification: batch classify all pending (forced, no Manager call)
  model.enqueue({
    findings: [
      {
        id: 'F1',
        title: 'SQL Injection',
        cwe: { id: 'CWE-89', name: 'Improper Neutralization of Special Elements used in an SQL Command' },
        severity: 'HIGH',
        confidence: 0.92,
        location: { file: 'submission.js', function: 'queryUser', lineStart: 2, lineEnd: 4 },
        explanation: 'Unsanitised user input concatenated into SQL.',
        recommendation: 'Use parameterised queries.'
      }
    ]
  });

  // 4. Verification: batch verify all classified (forced, no Manager call)
  model.enqueue({
    findings: [
      {
        id: 'F1',
        status: 'CONFIRMED',
        confidence: 0.88,
        reason: 'Taint flows directly to db.query() with no sanitisation.'
      }
    ]
  });

  // 5. Manager: finish
  model.enqueue(managerDecision('FINISH', 'All findings verified'));

  return buildOrchestrator(model, prismaCreateMock);
}

const SAMPLE_CODE = `
function queryUser(id) {
  return db.query("SELECT * FROM users WHERE id = " + id);
}
`;

describe('Persistence fixes (task 5)', () => {
  it('stores userId on the Analysis record', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'analysis-123' });
    const orchestrator = buildOrchestratorWithSQLi(create);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: SAMPLE_CODE,
      userId: 'user-abc'
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.userId).toBe('user-abc');
    expect(result.persisted).toBe(true);
    expect(result.id).toBe('analysis-123');
  }, 30000);

  it('stores the real verifier reason, not the hardcoded fallback', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'analysis-xyz' });
    const orchestrator = buildOrchestratorWithSQLi(create);

    await orchestrator.analyzePastedCode({ language: 'javascript', code: SAMPLE_CODE });

    const data = create.mock.calls[0][0].data;
    const finding = data.findings.create.find((f: any) => f.verificationStatus === 'CONFIRMED');
    expect(finding).toBeDefined();
    // Must use the real reason from the verifier, not 'See explanation'.
    expect(finding!.verificationReason).not.toBe('See explanation');
    expect(finding!.verificationReason).toMatch(/Taint flows/i);
  }, 30000);

  it('sets status COMPLETED and analysisStatus COMPLETE for a full run', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'analysis-zzz' });
    const orchestrator = buildOrchestratorWithSQLi(create);

    const result = await orchestrator.analyzePastedCode({ language: 'javascript', code: SAMPLE_CODE });

    const data = create.mock.calls[0][0].data;
    expect(data.status).toBe('COMPLETED');
    expect(result.analysisStatus).toBe('COMPLETE');
    expect(result.partial).toBe(false);
  }, 30000);

  it('returns persisted:false and no id when DB save fails', async () => {
    const create = jest.fn().mockRejectedValue(new Error('DB connection refused'));
    const orchestrator = buildOrchestratorWithSQLi(create);

    const result = await orchestrator.analyzePastedCode({ language: 'javascript', code: SAMPLE_CODE });

    // Must not return a fake UUID; must signal the failure via persisted:false.
    expect(result.persisted).toBe(false);
    expect(result.id).toBeUndefined();
    // Results should still be returned despite DB failure.
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].verification.status).toBe('CONFIRMED');
  }, 30000);

  it('sets status PARTIAL and persists uncertain findings when analysis is incomplete', async () => {
    const model = new FakeChatModel();

    // Manager: detect
    model.enqueue(managerDecision('DETECT_VULNERABILITIES', 'first pass'));

    // Detection: one finding
    model.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'Possible XSS',
          category: 'Injection',
          evidence: 'innerHTML assignment',
          file: 'submission.js',
          lineStart: 1,
          lineEnd: 3
        }
      ]
    });

    // Classification: classified but will be verified as UNCERTAIN
    model.enqueue({
      findings: [
        {
          id: 'F1',
          title: 'Possible XSS',
          cwe: { id: 'CWE-79', name: 'Cross-site Scripting' },
          severity: 'MEDIUM',
          confidence: 0.5,
          location: { file: 'submission.js', function: null, lineStart: 1, lineEnd: 3 },
          explanation: 'May be XSS if input is user-controlled.',
          recommendation: 'Sanitise before inserting into DOM.'
        }
      ]
    });

    // Verification: UNCERTAIN verdict
    model.enqueue({
      findings: [{ id: 'F1', status: 'UNCERTAIN', confidence: 0.5, reason: 'Cannot determine if input is user-controlled.' }]
    });

    model.enqueue(managerDecision('FINISH', 'done'));

    const create = jest.fn().mockResolvedValue({ id: 'analysis-partial' });
    const orchestrator = buildOrchestrator(model, create);

    const result = await orchestrator.analyzePastedCode({
      language: 'javascript',
      code: 'element.innerHTML = userInput;'
    });

    // UNCERTAIN finding → partial=true
    expect(result.partial).toBe(true);
    expect(result.analysisStatus).toBe('PARTIAL');
    expect(result.uncertainFindings).toHaveLength(1);
    expect(result.vulnerabilities).toHaveLength(0);

    const data = create.mock.calls[0][0].data;
    expect(data.status).toBe('PARTIAL');
    // The UNCERTAIN finding must be persisted (as UNCERTAIN) — never silently dropped.
    const uncertainRow = data.findings.create.find((f: any) => f.verificationStatus === 'UNCERTAIN');
    expect(uncertainRow).toBeDefined();
    expect(uncertainRow!.verificationReason).toMatch(/Cannot determine/i);
  }, 30000);
});
