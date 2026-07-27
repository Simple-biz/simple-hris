import 'server-only';

/**
 * Recently-offboarded people, unioned from every place an off-board gets
 * recorded — so payroll surfaces (the KPI bonus calculators' "Offboarded"
 * pickers) can still find someone whose FINAL bonuses need to be paid.
 *
 * The active roster can't see these people at all: `active_employees` requires
 * `off_boarded_at IS NULL` AND presence on the current sheet upload, and every
 * flavor of leaving fails one of those. Four flavors exist in practice:
 *
 *   1. Pipeline offboard (HR completed a queue request / dashboard offboard):
 *      the master row is stamped `off_boarded_at` — visible in
 *      `global_master_list`, `offboarding_queue` (completed), and usually
 *      `offboarded_sheet`, all with department + work email.
 *   2. Sheet-recorded offboard: only the "Offboarded" tab / `offboarded_sheet`
 *      knows, until the manual sync stamps the master row.
 *   3. Stamped DUPLICATE row: the person's active row survives while a dupe
 *      row carries the stamp (the sheet has duplicate person rows).
 *   4. Fell off the sheet UNSTAMPED: the row's `last_seen_upload_id` just goes
 *      stale — no stamp anywhere. Detected here by cross-matching stale rows
 *      against the last two Hubstaff timesheets (they were logging hours until
 *      they left, and those final hours are exactly why payroll still cares).
 *
 * `hubstaff_email` is the payable identity: the Payroll Wizard resolves
 * manager-submitted bonuses by DIRECT Hubstaff-email match first and only
 * falls back to the ACTIVE-roster master index — which cannot bridge these
 * people. A bonus keyed on anything other than their Hubstaff login silently
 * pays ₱0, so callers adding an offboarded person to a calculator must key on
 * `hubstaff_email` when present (e.g. master says cathyp@ but Hubstaff logs
 * cathypa@ — only the latter pays).
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { applyDeptOverrideToRawRow } from '@/lib/departments/dept-email-overrides';
import {
  listHubstaffUploads,
  fetchHubstaffRowsBySourceFile,
  rowsToPayrollRows,
} from '@/lib/supabase/hubstaff-hours-db';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';

export interface RecentlyOffboardedPerson {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  /** `YYYY-MM-DD` they left. Null when the person only FELL OFF the sheet
   *  (flavor 4) — no stamp exists anywhere, we just know they vanished while
   *  still logging hours. */
  off_boarded_at: string | null;
  /** The email their recent Hubstaff hours are keyed on, when determinable
   *  from the last two timesheets. THE identity payroll pays — see the module
   *  doc. Null when they have no hours in those files (their final pay is
   *  already out, or they never tracked). */
  hubstaff_email: string | null;
}

/** Calendar-date prefix of an ISO timestamp / date string. */
function toDay(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Name → lowercased word set with the master list's surname-first commas,
 *  quoted nicknames and curly quotes stripped (mirrors payroll-readiness). */
function nameTokens(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .toLowerCase()
      .replace(/["“”'’,.()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

interface Cand {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  /** Latest known off date (day string), null for flavor-4 rows. */
  off: string | null;
}

const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

/** Sorted-token name key, for exact person-level name comparison. */
function nameKey(raw: string | null | undefined): string {
  return [...nameTokens(raw)].sort().join(' ');
}

/**
 * List everyone off-boarded (or fallen off the roster) within the last `days`
 * days who is NOT on the active roster.
 *
 * Failure semantics are asymmetric ON PURPOSE. The queue/offboarded-sheet
 * reads are best-effort — losing one merely narrows the list. But the reads
 * that make the output SAFE fail the whole call instead of degrading:
 *  - the master list (the candidate backbone),
 *  - the current-upload id (without it the active-roster exclusion silently
 *    matches nobody and every stamped dupe row of an ACTIVE person — the
 *    documented off/active landmines — would be served as "offboarded"), and
 *  - the recent Hubstaff files (without them every person reads
 *    hubstaff_email: null, indistinguishable from "no recent hours", and
 *    flavor-4 detection silently vanishes).
 * The route 500s and the calculators degrade to an empty strip — honest and
 * recoverable — rather than offering a wrong-payment-shaped list.
 */
export async function listRecentlyOffboardedPeople(days = 90): Promise<{
  people: RecentlyOffboardedPerson[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { people: [], error: 'Supabase not configured' };

  const cutoff = toDay(new Date(Date.now() - days * 86_400_000).toISOString())!;

  type Row = Record<string, unknown>;
  const readAll = async (
    page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<Row[]> => {
    const PAGE = 1000;
    const out: Row[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await page(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as Row[];
      out.push(...batch);
      if (batch.length < PAGE) break;
      from += PAGE;
    }
    return out;
  };

  // ── Reads (see the failure-semantics note in the function doc) ────────────
  const [gmlRes, currentUploadRes, usIdsRes, queueRows, sheetRows, hubRows] = await Promise.all([
    readAll((from, to) =>
      supabase
        .from('global_master_list')
        .select(
          '"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department",off_boarded_at,last_seen_upload_id',
        )
        .range(from, to),
    ).then(
      (rows) => ({ rows, error: null as string | null }),
      (e: unknown) => ({ rows: [] as Row[], error: e instanceof Error ? e.message : 'master list read failed' }),
    ),
    supabase.from('master_list_uploads').select('id').eq('is_current', true),
    // US-prefixed employees are seeded outside the sheet sync, so their master
    // rows carry a permanently stale upload id yet the app treats them as
    // active (fetchActiveEmployees unions them back in). Mirror that here or
    // they'd read as flavor-4 leavers forever.
    supabase.from('employee_ids').select('work_email, personal_email').like('employee_id', 'US-%'),
    readAll((from, to) =>
      supabase
        .from('offboarding_queue')
        .select('employee_name, employee_email, employee_work_email, employee_personal_email, decided_at, department')
        .eq('status', 'completed')
        .gte('decided_at', cutoff)
        .range(from, to),
    ).catch(() => [] as Row[]),
    readAll((from, to) =>
      supabase
        .from('offboarded_sheet')
        .select('name, department, work_email, personal_email, off_boarded_at')
        .gte('off_boarded_at', cutoff)
        .range(from, to),
    ).catch(() => [] as Row[]),
    // The last two timesheets: who was logging hours recently, under which
    // email. Powers flavor-4 detection AND the hubstaff_email bridge. `null`
    // signals a FAILED read (≠ empty) so the caller can fail closed.
    (async () => {
      const uploads = await listHubstaffUploads();
      const dated = uploads
        .map((u) => {
          const file = (u.source_file ?? '').trim();
          return { file, start: file ? parseDateRangeFromFilename(file)?.start ?? null : null };
        })
        .filter((u): u is { file: string; start: Date } => !!u.file && !!u.start && !Number.isNaN(u.start.getTime()))
        .sort((a, b) => b.start.getTime() - a.start.getTime());
      const files = [...new Set(dated.map((u) => u.file))].slice(0, 2);
      const out: { email: string; tokens: Set<string> }[] = [];
      const seen = new Set<string>();
      for (const f of files) {
        const { rows } = await fetchHubstaffRowsBySourceFile(f);
        for (const r of rowsToPayrollRows(rows)) {
          const em = normEmail(r.email ?? '');
          if (!em || seen.has(em)) continue;
          seen.add(em);
          out.push({ email: em, tokens: nameTokens(r.name) });
        }
      }
      return out;
    })().catch(() => null),
  ]);

  if (gmlRes.error && gmlRes.rows.length === 0) {
    return { people: [], error: gmlRes.error };
  }
  // Fail closed on an unresolvable current upload: with no (or an ambiguous)
  // is_current row, the active-roster exclusion below would match NOBODY and
  // the list would happily serve stamped dupe rows of active people. Exactly
  // one is_current row is the only trustworthy state — a sheet-sync promote
  // window (zero rows) or the documented sync race (two rows) both bail.
  if (currentUploadRes.error) {
    return { people: [], error: `master_list_uploads: ${currentUploadRes.error.message}` };
  }
  const currentRows = (currentUploadRes.data ?? []) as { id: unknown }[];
  if (currentRows.length !== 1) {
    return {
      people: [],
      error: `master_list_uploads has ${currentRows.length} is_current rows — cannot resolve the active roster`,
    };
  }
  const currentUploadId = str(currentRows[0].id);
  if (hubRows === null) {
    return { people: [], error: 'Hubstaff timesheets could not be read — payable identities cannot be resolved' };
  }
  const hubEmails = new Set(hubRows.map((h) => h.email));
  const usEmails = new Set<string>();
  for (const r of (usIdsRes.data ?? []) as { work_email?: string | null; personal_email?: string | null }[]) {
    for (const e of [r.work_email, r.personal_email]) {
      const em = normEmail(e ?? '');
      if (em) usEmails.add(em);
    }
  }

  // ── Active roster exclusion sets ───────────────────────────────────────────
  // Emails (all four columns — a leaver's login colliding with an ACTIVE
  // person's alternate address must exclude the candidate too) and exact
  // name keys (a stamped/stale DUPE row of an active person shares the name
  // even when its emails don't overlap — never offer someone whose name is
  // identical to an active person's; under-listing is the safe direction).
  const EMAIL_COLS = ['Work Email', 'Personal Email', 'Alternate Work Email', 'Alternate Work Email 2'];
  const activeEmails = new Set<string>();
  const activeNameKeys = new Set<string>();
  const activeNameTokenSets: Set<string>[] = [];
  for (const raw of gmlRes.rows) {
    if (raw['off_boarded_at']) continue;
    const emails = EMAIL_COLS.map((c) => normEmail(str(raw[c]) ?? '')).filter(Boolean) as string[];
    const onCurrentUpload = str(raw['last_seen_upload_id']) === currentUploadId;
    const isUsSeed = emails.some((e) => usEmails.has(e));
    let counts = onCurrentUpload || isUsSeed;
    if (!counts) {
      // Unstamped but stale upload id. Someone WITH hours in the recent
      // timesheets is a fell-off-the-sheet leaver (flavor 4) — their row must
      // NOT protect anything or they'd suppress their own candidacy. Someone
      // with NO recent hours is a non-sheet person (dev/founder — the
      // documented "merely fell off the latest upload" class): protect their
      // identity so a stamped dupe row of theirs never lists them as a leaver.
      const toks = nameTokens(str(raw['Name']));
      const onHub =
        emails.some((e) => hubEmails.has(e)) ||
        (toks.size >= 2 && hubRows.some((h) => h.tokens.size >= 2 && isSubset(h.tokens, toks)));
      counts = !onHub;
    }
    if (!counts) continue;
    for (const em of emails) activeEmails.add(em);
    const nk = nameKey(str(raw['Name']));
    if (nk) activeNameKeys.add(nk);
    const toks = nameTokens(str(raw['Name']));
    if (toks.size >= 2) activeNameTokenSets.push(toks);
  }

  // ── Candidates from every source ──────────────────────────────────────────
  const cands: Cand[] = [];

  for (const raw of gmlRes.rows) {
    const r = applyDeptOverrideToRawRow(raw);
    const w = str(r['Work Email']);
    const p = str(r['Personal Email']);
    const name = str(r['Name']);
    if (!name || (!w && !p)) continue;
    const off = toDay(str(r['off_boarded_at']));
    if (off) {
      // Flavor 1/3: stamped row.
      if (off >= cutoff) cands.push({ name, department: str(r['Department']), work_email: w, personal_email: p, off });
    } else if (str(r['last_seen_upload_id']) !== currentUploadId) {
      // Flavor 4: fell off the sheet unstamped. Only counts as "offboarded"
      // when they were logging hours in the last two timesheets — that both
      // filters out non-sheet people (devs/founders with no Hubstaff) and
      // dates the departure as recent enough to matter. Hub rows under an
      // ACTIVE person's email never qualify: a stale row name-matching an
      // active hour-logger is a dupe/lookalike of that active person, not a
      // leaver (the active-name guard below drops most of these anyway).
      const emails = [w, p].map((e) => normEmail(e ?? '')).filter(Boolean) as string[];
      let onHub = emails.some((e) => hubEmails.has(e) && !activeEmails.has(e));
      if (!onHub) {
        const toks = nameTokens(name);
        onHub =
          toks.size >= 2 &&
          hubRows.some((h) => !activeEmails.has(h.email) && h.tokens.size >= 2 && isSubset(h.tokens, toks));
      }
      if (onHub) cands.push({ name, department: str(r['Department']), work_email: w, personal_email: p, off: null });
    }
  }

  for (const r of queueRows) {
    const name = str(r['employee_name']);
    const w = str(r['employee_work_email']);
    const p = str(r['employee_personal_email']) ?? str(r['employee_email']);
    if (!name || (!w && !p)) continue;
    cands.push({ name, department: str(r['department']), work_email: w, personal_email: p, off: toDay(str(r['decided_at'])) });
  }

  for (const r of sheetRows) {
    const name = str(r['name']);
    const w = str(r['work_email']);
    const p = str(r['personal_email']);
    if (!name || (!w && !p)) continue;
    cands.push({ name, department: str(r['department']), work_email: w, personal_email: p, off: toDay(str(r['off_boarded_at'])) });
  }

  // ── Merge duplicates (same person recorded by several sources / dupe rows) ─
  const groups: Cand[] = [];
  const groupByEmail = new Map<string, Cand>();
  for (const c of cands) {
    const emails = [c.work_email, c.personal_email].map((e) => normEmail(e ?? '')).filter(Boolean) as string[];
    let g: Cand | undefined;
    for (const e of emails) {
      g = groupByEmail.get(e);
      if (g) break;
    }
    if (!g) {
      g = { ...c };
      groups.push(g);
    } else {
      g.department = g.department ?? c.department;
      g.work_email = g.work_email ?? c.work_email;
      g.personal_email = g.personal_email ?? c.personal_email;
      // Latest known departure wins (a dated record beats an undated one).
      if (c.off && (!g.off || c.off > g.off)) g.off = c.off;
    }
    for (const e of [g.work_email, g.personal_email].map((x) => normEmail(x ?? '')).filter(Boolean) as string[]) {
      groupByEmail.set(e, g);
    }
  }

  // ── Finalize: drop actives, bridge to the Hubstaff identity, sort ─────────
  const people: RecentlyOffboardedPerson[] = [];
  for (const g of groups) {
    const emails = [g.work_email, g.personal_email].map((e) => normEmail(e ?? '')).filter(Boolean) as string[];
    // Anyone with a still-active row is NOT offboarded for our purposes: the
    // record is stale (re-hire) or the email was recycled to a new person —
    // either way the active roster already serves them. The name check drops
    // dupe-row shadows of active people whose emails DON'T overlap (the
    // documented off/active landmines — e.g. a stamped dupe of someone who
    // never left). A genuinely-offboarded person sharing an exact full name
    // with an unrelated active person is dropped too — under-listing beats
    // offering a chip that could route money to the wrong human.
    if (emails.some((e) => activeEmails.has(e))) continue;
    if (activeNameKeys.has(nameKey(g.name))) continue;

    let hubstaff_email = emails.find((e) => hubEmails.has(e)) ?? null;
    if (!hubstaff_email) {
      // Email-variant bridge (master cathyp@ vs Hubstaff cathypa@): a UNIQUE
      // name-token match against the recent timesheets. Ambiguity keeps null,
      // and a hub row under an ACTIVE person's email is never a valid bridge
      // target — wrongly keying someone else's hours would pay the wrong
      // person (the hub files are dominated by active people, and a leaver
      // outside the two-file window CANNOT be in them, so an unguarded unique
      // hit would be guaranteed wrong exactly when it resolves).
      const toks = nameTokens(g.name);
      if (toks.size >= 2) {
        const hits = [
          ...new Set(
            hubRows
              .filter(
                (h) =>
                  !activeEmails.has(h.email) &&
                  h.tokens.size >= 2 &&
                  // Near-complete coverage, not just any subset: the master
                  // name may carry ONE extra token (the quoted-nickname dupe
                  // or a middle name), but a hub row matching far fewer
                  // tokens ("Jan Reroma" ⊂ "Jan Kane Reroma Teves") is a
                  // DIFFERENT person — bridging to them would pay the wrong
                  // (inactive) human, the one failure nothing downstream can
                  // catch.
                  h.tokens.size >= toks.size - 1 &&
                  isSubset(h.tokens, toks),
              )
              .map((h) => h.email),
          ),
        ];
        if (hits.length === 1) hubstaff_email = hits[0];
      }
    }

    // No payable identity + name contained in an ACTIVE person's fuller name
    // ("Reroma, Kane" vs the active "Reroma (Teves), Jan Kane") — almost
    // certainly a stale dupe row of that person under an older name form.
    // The exact-key guard above can't see these. They couldn't be paid via
    // the wizard anyway (no Hubstaff row), so suppress the ghost; payable
    // (hub-present) candidates are deliberately NOT subset-suppressed — a
    // real leaver may legitimately be a token-subset of an unrelated active
    // person's long name.
    if (!hubstaff_email) {
      const toks = nameTokens(g.name);
      if (toks.size >= 2 && activeNameTokenSets.some((a) => isSubset(toks, a))) continue;
    }

    people.push({
      name: g.name,
      department: g.department,
      work_email: g.work_email,
      personal_email: g.personal_email,
      off_boarded_at: g.off,
      hubstaff_email,
    });
  }

  // Most recent departures first; undated (just fell off the sheet) count as
  // the most recent of all. Alphabetical within a day.
  people.sort(
    (a, b) =>
      (b.off_boarded_at ?? '9999-99-99').localeCompare(a.off_boarded_at ?? '9999-99-99') ||
      a.name.localeCompare(b.name),
  );
  return { people: people.slice(0, 300), error: null };
}
