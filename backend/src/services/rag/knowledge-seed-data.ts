import { KnowledgeSourceDoc } from './ingest.service';

/**
 * A small curated starter knowledge base covering the vulnerability
 * classes this system targets. Intended as a seed for the college-project
 * prototype — extend with more CWE/OWASP references as needed.
 */
export const SEED_KNOWLEDGE: KnowledgeSourceDoc[] = [
  {
    title: 'SQL Injection (CWE-89)',
    source: 'OWASP / CWE-89',
    content:
      'SQL Injection occurs when untrusted input is concatenated directly into a SQL query instead of being passed as a bound parameter. ' +
      'This lets an attacker alter query logic, exfiltrate data, or bypass authentication. Remediation: always use parameterized queries ' +
      'or an ORM/query builder that binds parameters, never build SQL via string concatenation of user input, and apply least-privilege ' +
      'database accounts.'
  },
  {
    title: 'Cross-Site Scripting (CWE-79)',
    source: 'OWASP / CWE-79',
    content:
      'XSS occurs when untrusted input is rendered into HTML/JS context without proper encoding, letting an attacker execute script in ' +
      "another user's browser. Remediation: contextually encode output (HTML, attribute, JS, URL contexts differ), use templating engines " +
      'that auto-escape by default, and apply a Content-Security-Policy as defense in depth.'
  },
  {
    title: 'OS Command Injection (CWE-78)',
    source: 'OWASP / CWE-78',
    content:
      'Command Injection occurs when user input is passed to a shell interpreter (e.g. via exec/system calls) without sanitization. ' +
      'Remediation: avoid shell invocation entirely by using APIs like execFile/spawn with an argument array (never a concatenated ' +
      'command string), and validate/allow-list input if shell use is unavoidable.'
  },
  {
    title: 'Path Traversal (CWE-22)',
    source: 'OWASP / CWE-22',
    content:
      'Path Traversal occurs when user-controlled input is used to build a filesystem path without normalizing and confining it to an ' +
      'intended base directory, letting an attacker read or write arbitrary files (e.g. via "../" sequences). Remediation: resolve the ' +
      'final path and verify it remains within an allow-listed base directory, and reject inputs containing traversal sequences or ' +
      'absolute paths.'
  },
  {
    title: 'Hard-coded Credentials (CWE-798 / CWE-259)',
    source: 'CWE-798',
    content:
      'Hard-coded credentials (API keys, passwords, tokens) embedded in source code can be extracted by anyone with code access, ' +
      'including through version control history. Remediation: load secrets from environment variables or a secrets manager, rotate any ' +
      'credential that was ever committed, and add secret-scanning to CI.'
  },
  {
    title: 'Weak/Broken Cryptography (CWE-327)',
    source: 'CWE-327',
    content:
      'Use of broken or risky cryptographic algorithms (MD5, SHA1 for integrity/signing, DES, ECB mode) provides a false sense of ' +
      'security. Remediation: use modern, vetted algorithms (AES-GCM, SHA-256/3, bcrypt/argon2 for password hashing) via well-maintained ' +
      'libraries rather than custom implementations.'
  },
  {
    title: 'Server-Side Request Forgery (CWE-918)',
    source: 'OWASP / CWE-918',
    content:
      'SSRF occurs when an application fetches a remote resource using a URL influenced by user input, allowing an attacker to reach ' +
      'internal-only services or cloud metadata endpoints. Remediation: validate/allow-list destination hosts, block requests to private ' +
      'IP ranges and metadata endpoints, and avoid following redirects blindly.'
  },
  {
    title: 'Insecure Deserialization (CWE-502)',
    source: 'OWASP / CWE-502',
    content:
      'Deserializing untrusted data with formats/libraries that support object instantiation or code execution during deserialization ' +
      'can lead to remote code execution. Remediation: prefer plain data formats (JSON with strict schemas) over native ' +
      'serialization for untrusted input, and if native deserialization is required, use integrity checks and allow-listed types.'
  }
];
