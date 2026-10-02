/**
 * Guard: the HR onboarding forms' Promote / Save gates know about DATA sub-teams.
 *
 * `hsl-subdepartments.md` §4 — *"the sub-team picker lists code **and data**
 * teams … so a data team is accepted"*. Both routes passed the map to
 * `isPlaceableDeptLabel`; the three CLIENT gates in `HrOnboardingForm.tsx`
 * called it with nothing, which knows only the 16 code teams. So the picker
 * offered `hsl:attorney` (created in Payment Catalog 2026-10-02) and the same
 * dialog then refused it — Bypass's "Promote to Master List" stayed disabled
 * with every field filled and the account verified.
 *
 * A single-argument call is the defect shape, so the scan refuses it outright.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { placeableSubIndex } from '@/lib/departments/builtin-subs';
import { isPlaceableDeptLabel } from '@/lib/departments/hsl-subdept';

const FILE = path.resolve(process.cwd(), 'src/components/hr/HrOnboardingForm.tsx');

/** Source with block and line comments blanked, so prose naming the function is not a call. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/** The argument text of every `name(` call, up to its matching paren. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Does this argument list have a comma at nesting depth 0 (i.e. two or more args)? */
function hasSecondArg(args: string): boolean {
  let depth = 0;
  for (const ch of args) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

test('the defect: without the map a data sub-team is refused, with it accepted', () => {
  const map = placeableSubIndex({ hogan_smith_law: [{ key: 'attorney', name: 'Attorney' }] });
  assert.equal(isPlaceableDeptLabel('hsl:attorney'), false);
  assert.equal(isPlaceableDeptLabel('hsl:attorney', map), true);
  assert.equal(isPlaceableDeptLabel('HSL', map), false, 'a bare HSL is still never a placement');
  assert.equal(isPlaceableDeptLabel('hsl:ghost', map), false, 'a sub that does not exist is not one');
});

test('every isPlaceableDeptLabel call in HrOnboardingForm passes the sub-team map', () => {
  const calls = callArgs(codeOnly(fs.readFileSync(FILE, 'utf8')), 'isPlaceableDeptLabel');
  assert.ok(calls.length > 0, 'scan found no calls — the file moved or the gate was renamed');
  const bare = calls.filter((a) => !hasSecondArg(a));
  assert.deepEqual(bare, [], `single-argument call(s) know only the code teams: ${bare.join(' | ')}`);
});

test('the department triggers never print the raw value', () => {
  // Base UI's Select.Value with no `items` on Root renders the raw value — for a
  // sub-team that is `hsl:attorney` on screen (hsl-subdepartments.md §12).
  const src = codeOnly(fs.readFileSync(FILE, 'utf8'));
  const selfClosing = src.match(/<SelectPrimitive\.Value\b[^>]*\/>/g) ?? [];
  const deptTriggers = selfClosing.filter((t) => /department/i.test(t));
  assert.deepEqual(deptTriggers, [], 'a department Select.Value must format its value');
});
