import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Who uploaded this Hubstaff report?" is answered from `csv.upload`
 * (Admin Penny's `search_audit_log`). Until 2026-09-28 that row's actor — and
 * the archive row's `uploaded_by` — came from the upload FORM's `uploaded_by`
 * field, a client-supplied identity (audit-log.md §3: "Never from the request
 * body"). The delete / rename / set-current events used `getSessionActor()`,
 * which fails open to "anonymous", in a route whose gate had already resolved
 * the caller. These pins keep all four on the gate's identity.
 */
const src = readFileSync(join(process.cwd(), 'app/api/hubstaff-hours/route.ts'), 'utf8').replace(/\r\n/g, '\n');

test('the Hubstaff uploader is the verified session, never the form field', () => {
  assert.match(src, /const uploadedBy = authz\.sessionEmail;/);
  assert.match(src, /user_name: {3}uploadedBy,/);
  // the form value survives only as a claim
  assert.match(src, /uploaded_by_claim: uploadedByClaim/);
  assert.doesNotMatch(src, /uploadedBy \?\? actor\.user_name/);
});

test('no Hubstaff audit falls back to a fail-open session lookup', () => {
  assert.doesNotMatch(src, /getSessionActor\(/);
  const actors = src.match(/const actor = \{ user_name: authz\.sessionEmail, user_role: authz\.roles\[0\] \?\? 'user' \};/g) ?? [];
  assert.equal(actors.length, 3, 'csv.delete, csv.set_current, csv.rename');
});
