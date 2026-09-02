import { z } from 'zod';

/**
 * Recognized CWE ids. This is intentionally not exhaustive of the whole
 * CWE catalog (there are thousands), but it constrains Agent 2 to a
 * curated, well-known set relevant to the vulnerability classes this
 * system targets. Add to this list as needed rather than allowing
 * arbitrary/free-form CWE ids.
 */
export const KNOWN_CWE_IDS = [
  'CWE-20', // Improper Input Validation
  'CWE-22', // Path Traversal
  'CWE-78', // OS Command Injection
  'CWE-79', // XSS
  'CWE-89', // SQL Injection
  'CWE-90', // LDAP Injection
  'CWE-94', // Code Injection
  'CWE-95', // Eval Injection
  'CWE-119', // Buffer Overflow
  'CWE-125', // Out-of-bounds Read
  'CWE-190', // Integer Overflow
  'CWE-200', // Information Exposure
  'CWE-259', // Hard-coded Password
  'CWE-269', // Improper Privilege Management
  'CWE-287', // Improper Authentication
  'CWE-295', // Improper Certificate Validation
  'CWE-311', // Missing Encryption of Sensitive Data
  'CWE-327', // Broken/Weak Cryptography
  'CWE-330', // Use of Insufficiently Random Values
  'CWE-352', // CSRF
  'CWE-400', // Uncontrolled Resource Consumption
  'CWE-434', // Unrestricted Upload of Dangerous File Type
  'CWE-502', // Deserialization of Untrusted Data
  'CWE-611', // XXE
  'CWE-613', // Insufficient Session Expiration
  'CWE-732', // Incorrect Permission Assignment
  'CWE-798', // Hard-coded Credentials
  'CWE-862', // Missing Authorization
  'CWE-918', // SSRF
  'CWE-1004' // Missing HttpOnly Flag
] as const;

export const cweIdSchema = z.enum(KNOWN_CWE_IDS as unknown as [string, ...string[]]);

export const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
export const verificationStatusSchema = z.enum(['CONFIRMED', 'REJECTED']);

// ---------------------------------------------------------------------------
// Agent 1: Detection
// ---------------------------------------------------------------------------

export const candidateFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  evidence: z.string().min(1),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive()
});

export const detectionOutputSchema = z.object({
  findings: z.array(candidateFindingSchema)
});

export type DetectionOutput = z.infer<typeof detectionOutputSchema>;

// ---------------------------------------------------------------------------
// Agent 2: CWE + Localization + Explanation
// ---------------------------------------------------------------------------

export const analyzedFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  cwe: z.object({
    id: cweIdSchema,
    name: z.string().min(1)
  }),
  severity: severitySchema,
  confidence: z.number().min(0).max(1),
  location: z.object({
    file: z.string().min(1),
    function: z.string().nullable(),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive()
  }),
  explanation: z.string().min(1),
  recommendation: z.string().min(1)
});

export const classificationOutputSchema = z.object({
  findings: z.array(analyzedFindingSchema)
});

export type ClassificationOutput = z.infer<typeof classificationOutputSchema>;

// ---------------------------------------------------------------------------
// Agent 3: Verification
// ---------------------------------------------------------------------------

export const verificationResultSchema = z.object({
  id: z.string().min(1),
  status: verificationStatusSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
});

export const verificationOutputSchema = z.object({
  findings: z.array(verificationResultSchema)
});

export type VerificationOutput = z.infer<typeof verificationOutputSchema>;
