import { buildConcurrencyLimiter } from '../../src/middleware/concurrency';
import { Request, Response, NextFunction } from 'express';

/** Create a minimal mock req/res/next triple. */
function mockContext() {
  const events: Record<string, Array<() => void>> = {};
  const res = {
    on(event: string, fn: () => void) {
      (events[event] = events[event] ?? []).push(fn);
      return this;
    },
    emit(event: string) {
      (events[event] ?? []).forEach((fn) => fn());
    }
  } as unknown as Response;
  const req = {} as Request;
  const next: NextFunction & { calls: Array<unknown> } = Object.assign(
    (arg?: unknown) => { next.calls.push(arg); },
    { calls: [] as Array<unknown> }
  );
  return { req, res, next };
}

describe('buildConcurrencyLimiter', () => {
  it('allows the first request through', () => {
    const limiter = buildConcurrencyLimiter(1);
    const { req, res, next } = mockContext();
    limiter(req, res, next);
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]).toBeUndefined(); // no error
  });

  it('rejects a second concurrent request when limit is 1', () => {
    const limiter = buildConcurrencyLimiter(1);
    const ctx1 = mockContext();
    const ctx2 = mockContext();

    // First request enters — slot occupied
    limiter(ctx1.req, ctx1.res, ctx1.next);
    expect(ctx1.next.calls).toHaveLength(1);
    expect(ctx1.next.calls[0]).toBeUndefined();

    // Second request arrives while first is in flight — must be rejected
    limiter(ctx2.req, ctx2.res, ctx2.next);
    expect(ctx2.next.calls).toHaveLength(1);
    expect(ctx2.next.calls[0]).toBeInstanceOf(Error);
  });

  it('frees the slot on res "finish" and allows the next request', () => {
    const limiter = buildConcurrencyLimiter(1);
    const ctx1 = mockContext();
    const ctx2 = mockContext();

    limiter(ctx1.req, ctx1.res, ctx1.next);

    // Simulate finishing the first response
    ctx1.res.emit('finish');

    // Now the slot is free; the next request should pass
    limiter(ctx2.req, ctx2.res, ctx2.next);
    expect(ctx2.next.calls[0]).toBeUndefined();
  });

  it('frees the slot on res "close" (client disconnect)', () => {
    const limiter = buildConcurrencyLimiter(1);
    const ctx1 = mockContext();
    const ctx2 = mockContext();

    limiter(ctx1.req, ctx1.res, ctx1.next);
    ctx1.res.emit('close');

    limiter(ctx2.req, ctx2.res, ctx2.next);
    expect(ctx2.next.calls[0]).toBeUndefined();
  });

  it('does not double-release if both finish and close fire', () => {
    const limiter = buildConcurrencyLimiter(2);
    const ctx1 = mockContext();
    const ctx2 = mockContext();
    const ctx3 = mockContext();

    limiter(ctx1.req, ctx1.res, ctx1.next);
    limiter(ctx2.req, ctx2.res, ctx2.next);

    // Both slots occupied; third must be rejected
    limiter(ctx3.req, ctx3.res, ctx3.next);
    expect(ctx3.next.calls[0]).toBeInstanceOf(Error);

    // Double-release ctx1 (finish then close)
    ctx1.res.emit('finish');
    ctx1.res.emit('close');

    // Only one slot freed — third re-attempt should now pass (1 of 2 slots free)
    const ctx4 = mockContext();
    limiter(ctx4.req, ctx4.res, ctx4.next);
    expect(ctx4.next.calls[0]).toBeUndefined();

    // But a fifth should still be rejected (second slot still taken by ctx2)
    const ctx5 = mockContext();
    limiter(ctx5.req, ctx5.res, ctx5.next);
    expect(ctx5.next.calls[0]).toBeInstanceOf(Error);
  });
});
