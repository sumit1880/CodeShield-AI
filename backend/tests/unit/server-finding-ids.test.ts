import { createToolRegistry, ToolRegistryDeps, ToolContext } from '../../src/orchestrator/tool-registry';
import { AnalysisState } from '../../src/types/agent-state';
import { CandidateFinding } from '../../src/types/findings';

describe('Server-side finding IDs and dedupeMerge', () => {
  it('assigns unique server-side IDs and avoids collisions across multiple detection passes', async () => {
    const mockDetectionAgent = {
      run: jest.fn()
    } as any;

    const deps: ToolRegistryDeps = {
      detectionAgent: mockDetectionAgent,
      classificationAgent: {} as any,
      verificationAgent: {} as any,
      semgrepService: {} as any,
      ragService: {} as any,
      codeSearchService: {} as any
    };

    const ctx: ToolContext = {
      projectRoot: '/tmp/test',
      language: 'javascript',
      getSourceView: () => 'const a = 1;'
    };

    const tools = createToolRegistry(deps, ctx);

    const state: AnalysisState = {
      goal: 'test',
      language: 'javascript',
      files: ['test.js'],
      semgrepFindings: [],
      candidateFindings: [],
      classifiedFindings: [],
      verifiedById: new Map(),
      knowledge: [],
      evidence: [],
      actionsTaken: [],
      iteration: 0,
      toolCallCount: 0,
      status: 'RUNNING'
    };

    // First detection pass returns candidates with LLM-generated IDs: F1, F2
    mockDetectionAgent.run.mockResolvedValueOnce({
      findings: [
        {
          id: 'F1',
          title: 'SQL Injection',
          category: 'Injection',
          evidence: 'query()',
          file: 'db.js',
          lineStart: 10,
          lineEnd: 12
        },
        {
          id: 'F2',
          title: 'XSS',
          category: 'Injection',
          evidence: 'innerHTML',
          file: 'view.js',
          lineStart: 20,
          lineEnd: 22
        }
      ] as CandidateFinding[]
    });

    await tools.DETECT_VULNERABILITIES(state, {});

    expect(state.candidateFindings).toHaveLength(2);
    expect(state.candidateFindings[0].id).toBe('finding-1');
    expect(state.candidateFindings[1].id).toBe('finding-2');
    expect(state.candidateFindings[0].title).toBe('SQL Injection');
    expect(state.candidateFindings[1].title).toBe('XSS');

    // Second detection pass returns candidates that reuse LLM IDs 'F1' and 'F2' for NEW findings
    mockDetectionAgent.run.mockResolvedValueOnce({
      findings: [
        {
          id: 'F1', // Reused LLM ID, but different finding
          title: 'Command Injection',
          category: 'Injection',
          evidence: 'exec()',
          file: 'exec.js',
          lineStart: 5,
          lineEnd: 6
        },
        {
          id: 'F2', // Reused LLM ID and duplicate finding of the first pass
          title: 'SQL Injection',
          category: 'Injection',
          evidence: 'query()',
          file: 'db.js',
          lineStart: 10,
          lineEnd: 12
        }
      ] as CandidateFinding[]
    });

    await tools.DETECT_VULNERABILITIES(state, {});

    // The duplicate SQL Injection is deduplicated, while the new Command Injection gets 'finding-3'
    // without overwriting 'finding-1'.
    expect(state.candidateFindings).toHaveLength(3);
    expect(state.candidateFindings[0].id).toBe('finding-1');
    expect(state.candidateFindings[1].id).toBe('finding-2');
    expect(state.candidateFindings[2].id).toBe('finding-3');
    expect(state.candidateFindings[2].title).toBe('Command Injection');
  });
});
