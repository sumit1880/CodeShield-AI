import { analyzeRequestSchema } from '../../src/schemas/api.schema';
import { isSupportedLanguage } from '../../src/config/languages';
import { ApiError, ErrorCode } from '../../src/utils/errors';

describe('analyzeRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = analyzeRequestSchema.safeParse({ language: 'javascript', code: 'const a = 1;' });
    expect(result.success).toBe(true);
  });

  it('rejects empty code', () => {
    const result = analyzeRequestSchema.safeParse({ language: 'javascript', code: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing language', () => {
    const result = analyzeRequestSchema.safeParse({ code: 'const a = 1;' });
    expect(result.success).toBe(false);
  });
});

describe('isSupportedLanguage', () => {
  it('recognizes supported languages case-insensitively', () => {
    expect(isSupportedLanguage('javascript')).toBe(true);
    expect(isSupportedLanguage('JavaScript')).toBe(true);
    expect(isSupportedLanguage('python')).toBe(true);
  });

  it('rejects unsupported languages', () => {
    expect(isSupportedLanguage('brainfuck')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
  });
});

describe('ApiError', () => {
  it('produces the documented UNSUPPORTED_LANGUAGE shape', () => {
    const err = new ApiError(ErrorCode.UNSUPPORTED_LANGUAGE, 'The selected language is not currently supported.');
    expect(err.toJSON()).toEqual({
      success: false,
      error: {
        code: 'UNSUPPORTED_LANGUAGE',
        message: 'The selected language is not currently supported.'
      }
    });
    expect(err.statusCode).toBe(400);
  });

  it('maps CODE_TOO_LARGE to 413', () => {
    const err = new ApiError(ErrorCode.CODE_TOO_LARGE, 'too big');
    expect(err.statusCode).toBe(413);
  });
});
