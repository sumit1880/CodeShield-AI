import { ApiError, ErrorCode } from '../../utils/errors';

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'LLM request',
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new Error('Aborted'));
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new ApiError(ErrorCode.AI_TIMEOUT, `${label} timed out after ${ms}ms`));
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('Aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    promise
      .then((value) => {
        cleanup();
        resolve(value);
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}
