/**
 * The team roster's WIRE SHAPE, pinned at its real source.
 *
 * Carla's 2026-09-09 safety ruling (docs/meetings/2026-09-09-carla-jackie-
 * employee-surface-and-qc.md §2.6) is a redaction, and a redaction is only worth
 * anything if the redacted fields never leave the server: `/api/team-roster` is
 * reachable directly, and `route-access.ts` gates PAGES, not APIs. A future
 * change can keep every render clean while quietly putting the legal name or the
 * personal address back on the wire — that is what these scans catch, and a
 * behavioural test cannot.
 *
 * Run:  npx tsx --test src/lib/supabase/team-roster.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, 'team-roster.ts'), 'utf8');

/** The body of `export interface TeamRosterProfile { ... }` — what the route
 *  serialises to the browser. */
function profileInterfaceBody(): string {
  const m = src.match(/export interface TeamRosterProfile\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'expected TeamRosterProfile to be findable');
  return m[1]!;
}

describe('team roster — what reaches a peer', () => {
  it('never declares a personal email', () => {
    assert.ok(
      !/\bpersonalEmail\b/.test(profileInterfaceBody()),
      'TeamRosterProfile must not carry personalEmail — a teammate with no work ' +
        'email would have their personal address shipped to the whole team',
    );
  });

  it('never declares a raw `name`, only the redacted `displayName`', () => {
    const body = profileInterfaceBody();
    assert.ok(
      /^\s*displayName:\s*string;/m.test(body),
      'TeamRosterProfile must expose the redacted displayName',
    );
    assert.ok(
      !/^\s*name\s*:/m.test(body),
      'TeamRosterProfile must not carry `name` — the master-list cell is the ' +
        'surname-first LEGAL name, which is the whole thing the ruling removes',
    );
  });

  it('redacts through the shared resolver rather than inline', () => {
    assert.ok(
      /teamDisplayNames\(/.test(src),
      'the roster must redact via teamDisplayNames — an inline trim would not ' +
        'resolve collisions across the whole roster, and the go-by/first-name ' +
        'rule would drift away from its tests',
    );
  });

  it('resolves the viewer server-side instead of shipping an address to compare', () => {
    assert.ok(
      /isSelf:\s*!!viewerNorm/.test(src),
      '"this card is you" must be decided here — the client no longer holds the ' +
        'personal address it used to match on',
    );
  });

  it('keys the returned last-seen map on WORK emails only', () => {
    // The map's KEYS are addresses. Keying it on both would leak the exact field
    // the profile shape drops, just one level down in the same JSON.
    assert.ok(
      /for \(const e of allWorkEmails\) \{\s*const v = seenByEmail\.get\(e\);/.test(src),
      'the lastSeen map must be built from allWorkEmails',
    );
  });
});
