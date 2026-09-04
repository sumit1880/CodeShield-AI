import {
  detectionOutputSchema,
  classificationOutputSchema,
  verificationOutputSchema
} from '../../src/schemas/agent.schema';

describe('detectionOutputSchema', () => {
  it('accepts a valid detection response', () => {
    const result = detectionOutputSchema.safeParse({
      findings: [
        {
          id: 'F1',
          title: 'Possible SQL Injection',
          category: 'Injection',
          evidence: "db.query('SELECT * FROM users WHERE id = ' + id)",
          file: 'server.js',
          lineStart: 10,
          lineEnd: 12
        }
      ]
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty findings array', () => {
    expect(detectionOutputSchema.safeParse({ findings: [] }).success).toBe(true);
  });

  it('rejects a malformed response missing required fields', () => {
    const result = detectionOutputSchema.safeParse({ findings: [{ id: 'F1' }] });
    expect(result.success).toBe(false);
  });
});

describe('classificationOutputSchema', () => {
  const validFinding = {
    id: 'F1',
    title: 'SQL Injection',
    cwe: { id: 'CWE-89', name: 'Improper Neutralization of Special Elements used in an SQL Command' },
    severity: 'HIGH',
    confidence: 0.9,
    location: { file: 'server.js', function: 'getUser', lineStart: 10, lineEnd: 12 },
    explanation: 'User input flows into a SQL string without sanitization.',
    recommendation: 'Use parameterized queries.'
  };

  it('accepts a valid classification response', () => {
    expect(classificationOutputSchema.safeParse({ findings: [validFinding] }).success).toBe(true);
  });

  it('rejects an invalid/unrecognized CWE id', () => {
    const invalid = { ...validFinding, cwe: { id: 'CWE-99999', name: 'Made Up' } };
    expect(classificationOutputSchema.safeParse({ findings: [invalid] }).success).toBe(false);
  });

  it('rejects an invalid severity value', () => {
    const invalid = { ...validFinding, severity: 'SUPER_HIGH' };
    expect(classificationOutputSchema.safeParse({ findings: [invalid] }).success).toBe(false);
  });

  it('rejects confidence outside 0-1', () => {
    const invalid = { ...validFinding, confidence: 1.5 };
    expect(classificationOutputSchema.safeParse({ findings: [invalid] }).success).toBe(false);
  });
});

describe('verificationOutputSchema', () => {
  it('accepts a valid verification response', () => {
    const result = verificationOutputSchema.safeParse({
      findings: [{ id: 'F1', status: 'CONFIRMED', confidence: 0.95, reason: 'Matches known SQLi pattern.' }]
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid verification status', () => {
    const result = verificationOutputSchema.safeParse({
      findings: [{ id: 'F1', status: 'MAYBE', confidence: 0.5, reason: 'unsure' }]
    });
    expect(result.success).toBe(false);
  });

  it('accepts UNCERTAIN as a verdict for the agent loop', () => {
    const result = verificationOutputSchema.safeParse({
      findings: [{ id: 'F1', status: 'UNCERTAIN', confidence: 0.5, reason: 'insufficient evidence' }]
    });
    expect(result.success).toBe(true);
  });
});
