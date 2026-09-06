import { ApiError, ErrorCode } from '../../utils/errors';

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'LLM request'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ApiError(ErrorCode.AI_TIMEOUT, `${label} timed out after ${ms}ms`));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
