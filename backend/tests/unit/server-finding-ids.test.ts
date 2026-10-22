/**
 * Tests that the candidate finding deduplication and server-side ID assignment
 * logic works correctly. These semantics now live in the graph state reducer.
 */
import { dedupeCandidateFindings } from '../../src/graph/state';
import { CandidateFinding } from '../../src/types/findings';

describe('Server-side finding IDs and dedupeCandidateFindings reducer', () => {
  it('assigns stable sequential IDs and deduplicates across multiple detection passes', () => {
    // First detection pass: two new findings from LLM with arbitrary IDs
    const pass1: CandidateFinding[] = [
      { id: 'F1', title: 'SQL Injection', category: 'Injection', evidence: 'query()', file: 'db.js', lineStart: 10, lineEnd: 12 },
      { id: 'F2', title: 'XSS', category: 'Injection', evidence: 'innerHTML', file: 'view.js', lineStart: 20, lineEnd: 22 }
    ];

    const afterPass1 = dedupeCandidateFindings([], pass1);

    expect(afterPass1).toHaveLength(2);
    expect(afterPass1[0].id).toBe('finding-1');
    expect(afterPass1[0].title).toBe('SQL Injection');
    expect(afterPass1[1].id).toBe('finding-2');
    expect(afterPass1[1].title).toBe('XSS');

    // Second detection pass: one genuinely new finding and one duplicate (same title+file+lineStart)
    const pass2: CandidateFinding[] = [
      { id: 'F1', title: 'Command Injection', category: 'Injection', evidence: 'exec()', file: 'exec.js', lineStart: 5, lineEnd: 6 },
      { id: 'F2', title: 'SQL Injection', category: 'Injection', evidence: 'query()', file: 'db.js', lineStart: 10, lineEnd: 12 } // duplicate
    ];

    const afterPass2 = dedupeCandidateFindings(afterPass1, pass2);

    // Duplicate SQL Injection is dropped; new Command Injection gets finding-3
    expect(afterPass2).toHaveLength(3);
    expect(afterPass2[0].id).toBe('finding-1'); // unchanged
    expect(afterPass2[1].id).toBe('finding-2'); // unchanged
    expect(afterPass2[2].id).toBe('finding-3'); // new
    expect(afterPass2[2].title).toBe('Command Injection');
  });

  it('returns empty array when no findings provided', () => {
    expect(dedupeCandidateFindings([], [])).toHaveLength(0);
  });

  it('does not change IDs of existing findings when merging empty incoming', () => {
    const existing: CandidateFinding[] = [
      { id: 'finding-1', title: 'XSS', category: 'Injection', evidence: 'innerHTML', file: 'a.js', lineStart: 1, lineEnd: 2 }
    ];
    const result = dedupeCandidateFindings(existing, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('finding-1');
  });
});
