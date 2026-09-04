import { managerDecisionSchema } from '../../src/schemas/manager.schema';

describe('managerDecisionSchema', () => {
  it('accepts a valid decision from the fixed action set', () => {
    const result = managerDecisionSchema.safeParse({
      action: 'SEARCH_CODE',
      arguments: { query: 'database query construction', file: 'src/auth.ts' },
      reason: 'Need evidence for suspected injection'
    });
    expect(result.success).toBe(true);
  });

  it('defaults arguments to {} when omitted', () => {
    const result = managerDecisionSchema.safeParse({ action: 'FINISH', reason: 'Done' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.arguments).toEqual({});
  });

  it('rejects an action outside the fixed safe action set (no arbitrary tools)', () => {
    const result = managerDecisionSchema.safeParse({
      action: 'RUN_SHELL_COMMAND',
      arguments: { cmd: 'rm -rf /' },
      reason: 'trying to escape the sandbox'
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const result = managerDecisionSchema.safeParse({ action: 'FINISH' });
    expect(result.success).toBe(false);
  });
});
