import { z } from 'zod';
import { routeFromManager, routeFromWorker } from '../../src/graph/router';
import { managerNode } from '../../src/graph/nodes/manager.node';
import { generateStructuredWithModel } from '../../src/llm/structured-output';
import { LangChainFallbackRouter } from '../../src/llm/factory';
import { FakeChatModel } from '../../src/llm/fake-chat-model';
import { AnalysisGraphState } from '../../src/graph/state';
import { ApiError, ErrorCode } from '../../src/utils/errors';
import { env } from '../../src/config/env';

function makeMockState(overrides: Partial<AnalysisGraphState> = {}): AnalysisGraphState {
  return {
    language: 'javascript',
    projectRoot: '/tmp/test',
    files: ['index.js'],
    sourceCode: 'console.log("hello");',
    goal: 'Test goal',
    deadline: 0,
    semgrepFindings: [],
    candidateFindings: [],
    classifiedFindings: [],
    verifiedById: {},
    knowledge: [],
    evidence: [],
    actionsTaken: [],
    iteration: 0,
    toolCallCount: 0,
    stopReason: 'FINISHED',
    nextAction: null,
    finalized: null,
    ...overrides
  };
}

describe('Phase 4: LangGraph Routing & LangChain LLM Tests', () => {
  describe('Graph Routing (routeFromManager & routeFromWorker)', () => {
    it('forces CLASSIFY when unclassified candidates exist (deterministic override)', () => {
      const state = makeMockState({
        candidateFindings: [
          {
            id: 'finding-1',
            title: 'SQLi',
            category: 'Injection',
            evidence: 'concat',
            file: 'test.js',
            lineStart: 1,
            lineEnd: 2
          }
        ],
        classifiedFindings: [],
        nextAction: { action: 'SEARCH_CODE', arguments: { query: 'test' }, reason: 'look around' }
      });

      // Manager wanted SEARCH_CODE, but unclassified candidates MUST force classify
      expect(routeFromManager(state)).toBe('classify');
      expect(routeFromWorker(state)).toBe('classify');
    });

    it('forces VERIFY when unverified classified findings exist (deterministic override)', () => {
      const state = makeMockState({
        candidateFindings: [
          {
            id: 'finding-1',
            title: 'SQLi',
            category: 'Injection',
            evidence: 'concat',
            file: 'test.js',
            lineStart: 1,
            lineEnd: 2
          }
        ],
        classifiedFindings: [
          {
            id: 'finding-1',
            title: 'SQLi',
            cwe: { id: 'CWE-89', name: 'SQL Injection' },
            severity: 'HIGH',
            confidence: 0.9,
            location: { file: 'test.js', function: null, lineStart: 1, lineEnd: 2 },
            explanation: 'SQL injection',
            recommendation: 'Use prepared statements'
          }
        ],
        verifiedById: {}, // finding-1 not yet in verifiedById
        nextAction: { action: 'DETECT_VULNERABILITIES', arguments: {}, reason: 'run more detection' }
      });

      // Even if manager wants detection, unverified classified findings force verify
      expect(routeFromManager(state)).toBe('verify');
      expect(routeFromWorker(state)).toBe('verify');
    });

    it('routes FINISH action to finalize', () => {
      const state = makeMockState({
        nextAction: { action: 'FINISH', arguments: {}, reason: 'All done' }
      });

      expect(routeFromManager(state)).toBe('finalize');
    });

    it('routes to finalize when iteration exceeds maxIterations', () => {
      const state = makeMockState({
        iteration: env.agent.maxIterations + 1,
        nextAction: { action: 'DETECT_VULNERABILITIES', arguments: {}, reason: 'keep going' }
      });

      expect(routeFromManager(state)).toBe('finalize');
      expect(routeFromWorker(state)).toBe('finalize');
    });

    it('routes to finalize when toolCallCount exceeds maxToolCalls', () => {
      const state = makeMockState({
        toolCallCount: env.agent.maxToolCalls,
        nextAction: { action: 'SEARCH_CODE', arguments: { query: 'x' }, reason: 'search' }
      });

      expect(routeFromManager(state)).toBe('finalize');
      expect(routeFromWorker(state)).toBe('finalize');
    });

    it('routes to finalize when deadline is exceeded', () => {
      const state = makeMockState({
        deadline: Date.now() - 1000, // in the past
        nextAction: { action: 'SEARCH_SECURITY_KNOWLEDGE', arguments: { query: 'cwe' }, reason: 'lookup' }
      });

      expect(routeFromManager(state)).toBe('finalize');
      expect(routeFromWorker(state)).toBe('finalize');
    });

    it('rejects unknown manager actions and safely routes to finalize', () => {
      const state = makeMockState({
        nextAction: { action: 'EXECUTE_ARBITRARY_COMMAND' as any, arguments: {}, reason: 'hack' }
      });

      expect(routeFromManager(state)).toBe('finalize');
    });
  });

  describe('Tool Allow-List Enforcement in ManagerNode', () => {
    it('defaults to FINISH if the LLM produces an action outside AGENT_ACTIONS', async () => {
      const model = new FakeChatModel();
      model.enqueue({
        action: 'EXECUTE_SHELL_COMMAND',
        arguments: { command: 'rm -rf /' },
        reason: 'malicious action'
      });
      model.enqueue({
        action: 'EXECUTE_SHELL_COMMAND',
        arguments: { command: 'rm -rf /' },
        reason: 'malicious action still'
      });

      const node = managerNode({ model });
      const update = await node(makeMockState());

      expect((update.nextAction as any)?.action).toBe('FINISH');
      expect((update.nextAction as any)?.reason).toMatch(/defaulting to FINISH/i);
    });
  });

  describe('Structured-Output Repair Loop', () => {
    const testSchema = z.object({
      greeting: z.string(),
      count: z.number().int().positive()
    });

    it('returns parsed output directly when first response matches schema', async () => {
      const model = new FakeChatModel();
      model.enqueue({ greeting: 'hello', count: 42 });

      const result = await generateStructuredWithModel(model, {
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: testSchema
      });

      expect(result).toEqual({ greeting: 'hello', count: 42 });
      expect(model.calls).toHaveLength(1);
    });

    it('successfully repairs invalid first response on second attempt', async () => {
      const model = new FakeChatModel();
      // First attempt: invalid schema (missing count, invalid greeting type)
      model.enqueue({ greeting: 123 });
      // Second attempt: valid repaired schema
      model.enqueue({ greeting: 'fixed hello', count: 7 });

      const result = await generateStructuredWithModel(model, {
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: testSchema
      });

      expect(result).toEqual({ greeting: 'fixed hello', count: 7 });
      expect(model.calls).toHaveLength(2);
      // The second call prompt should reference validation error
      const secondCallHumanMessage = (model.calls[1][1] as any).content;
      expect(secondCallHumanMessage).toContain('Validation error');
    });

    it('throws INVALID_AI_RESPONSE if repair attempt also fails validation', async () => {
      const model = new FakeChatModel();
      // First attempt: invalid JSON
      model.enqueue('not even json {{{');
      // Second attempt: also invalid
      model.enqueue({ still: 'wrong schema' });

      await expect(
        generateStructuredWithModel(model, {
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: testSchema
        })
      ).rejects.toThrow(ApiError);
    });
  });

  describe('LangChainFallbackRouter: Provider Fallback Semantics', () => {
    it('falls back to next provider on rate-limit error (429)', async () => {
      const primary = new FakeChatModel();
      const fallback = new FakeChatModel();

      // Primary throws rate limit error
      jest.spyOn(primary, '_generate').mockRejectedValueOnce({ status: 429, message: 'Rate limit exceeded' });
      // Fallback succeeds
      fallback.enqueue({ text: 'from fallback provider' });

      const router = new LangChainFallbackRouter([
        { name: 'primary', model: primary },
        { name: 'fallback', model: fallback }
      ]);

      const response = await router.invoke('Hello');
      expect(response.content).toBe('{"text":"from fallback provider"}');
    });

    it('falls back to next provider on timeout or server error (503)', async () => {
      const primary = new FakeChatModel();
      const fallback = new FakeChatModel();

      // Primary throws 503
      jest.spyOn(primary, '_generate').mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' });
      fallback.enqueue('healthy response');

      const router = new LangChainFallbackRouter([
        { name: 'primary', model: primary },
        { name: 'fallback', model: fallback }
      ]);

      const response = await router.invoke('Hello');
      expect(response.content).toBe('healthy response');
    });

    it('does NOT fall back on non-provider errors (throws immediately)', async () => {
      const primary = new FakeChatModel();
      const fallback = new FakeChatModel();

      // Non-provider error (e.g. invalid request format or custom validation error)
      const clientError = new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid request parameter');
      jest.spyOn(primary, '_generate').mockRejectedValueOnce(clientError);

      const fallbackSpy = jest.spyOn(fallback, '_generate');

      const router = new LangChainFallbackRouter([
        { name: 'primary', model: primary },
        { name: 'fallback', model: fallback }
      ]);

      await expect(router.invoke('Hello')).rejects.toThrow('Invalid request parameter');
      expect(fallbackSpy).not.toHaveBeenCalled();
    });
  });
});
