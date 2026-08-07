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
import { sanitizeOffboardDay } from '@/lib/roster/offboard-date-sanity';
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
  /** Raw `off_boarded_reason` from the stamped global_master_list row, when
   *  known. Null for flavor-4 (fell off the sheet unstamped) or when no
   *  contributing source carried a reason. */
  off_boarded_reason: string | null;
  /** Week-start day (`YYYY-MM-DD`, the file's Sunday) of the NEWEST timesheet
   *  their hours appear in — i.e. the last week they actually worked, as far
   *  as the two-file window can see. Dates the undated fell-off-the-sheet
   *  people, and lets callers scope the list to one pay week (a person is only
   *  scorable for a week they either worked or hadn't yet left). Null whenever
   *  `hubstaff_email` is null. */
  last_hours_week_start: string | null;
  /** Gsuite aliases from the master row — the same second-inbox bridge
   *  `active_employees` carries. A leaver's rate/Hubstaff row can be keyed on
   *  one of these, so consumers matching them back to a person need both. */
  alternate_work_email: string | null;
  alternate_work_email_2: string | null;
  /** Raw master-list "Start Date" (US-format, as stored). Carried so a final
   *  paycheck can still resolve tenure-gated pay (e.g. the Tech Bonus 30-day
   *  gate), which is otherwise unreachable once the person leaves the active
   *  roster. Null when the master row has none. */
  start_date: string | null;
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
  alternate_work_email: string | null;
  alternate_work_email_2: string | null;
  start_date: string | null;
  /** Latest known off date (day string), null for flavor-4 rows. */
  off: string | null;
  /** Latest known off_boarded_reason, null for flavor-4/queue/sheet rows. */
  off_boarded_reason: string | null;
  /** This candidate came from a master row still carried by the CURRENT sheet
   *  upload. Only stamped flavor-1/3 rows can set it (flavor 4 is defined by a
   *  stale upload id), and it decides which of a person's DUPLICATE master rows
   *  describes them today — see the promotion rule in the merge below. */
  on_current_upload: boolean;
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
  /** Older week-start day of the two-week hours-evidence window. Weeks BEFORE
   *  this have no hours signal at all — week-scoping consumers must degrade to
   *  the full list there instead of trusting "no hours" (see
   *  offboarded-week-relevance.ts). Null only when no Hubstaff file exists. */
  hoursWeekFloor: string | null;
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { people: [], hoursWeekFloor: null, error: 'Supabase not configured' };

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
  const [gmlRes, currentUploadRes, usIdsRes, queueRows, sheetRows, hubRes] = await Promise.all([
    readAll((from, to) =>
      supabase
        .from('global_master_list')
        .select(
          '"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Start Date",off_boarded_at,off_boarded_reason,last_seen_upload_id',
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
      // Keep every file of the TWO newest distinct WEEKS (keyed by the file's
      // parsed range start — the same day KPI weeks are keyed on). Deduping by
      // week, not filename, matters: one week can carry several distinct files
      // (the n8n api_sync export plus a manual CSV re-upload), and a
      // two-FILENAME window would then silently collapse the lookback to a
      // single week.
      const weekDays: string[] = [];
      const files: { file: string; weekStartDay: string }[] = [];
      const seenFiles = new Set<string>();
      for (const u of dated) {
        const weekStartDay = `${u.start.getFullYear()}-${String(u.start.getMonth() + 1).padStart(2, '0')}-${String(u.start.getDate()).padStart(2, '0')}`;
        if (!weekDays.includes(weekStartDay)) {
          if (weekDays.length >= 2) continue; // an older week — out of window
          weekDays.push(weekStartDay);
        }
        if (seenFiles.has(u.file)) continue;
        seenFiles.add(u.file);
        files.push({ file: u.file, weekStartDay });
      }
      const out: { email: string; tokens: Set<string>; weekStartDay: string }[] = [];
      const seen = new Set<string>();
      for (const { file, weekStartDay } of files) {
        const { rows } = await fetchHubstaffRowsBySourceFile(file);
        for (const r of rowsToPayrollRows(rows)) {
          const em = normEmail(r.email ?? '');
          if (!em || seen.has(em)) continue;
          seen.add(em);
          // Files iterate newest-week-first and `seen` keeps the first hit, so
          // each email's row carries the NEWEST week they logged hours in.
          out.push({ email: em, tokens: nameTokens(r.name), weekStartDay });
        }
      }
      // weekFloor = the OLDER kept week: the boundary below which the hours
      // evidence sees nothing. Callers week-scoping the list must not trust
      // "no hours" for weeks before it.
      return { rows: out, weekFloor: weekDays.length ? weekDays[weekDays.length - 1]! : null };
    })().catch(() => null),
  ]);

  if (gmlRes.error && gmlRes.rows.length === 0) {
    return { people: [], hoursWeekFloor: null, error: gmlRes.error };
  }
  // Fail closed on an unresolvable current upload: with no (or an ambiguous)
  // is_current row, the active-roster exclusion below would match NOBODY and
  // the list would happily serve stamped dupe rows of active people. Exactly
  // one is_current row is the only trustworthy state — a sheet-sync promote
  // window (zero rows) or the documented sync race (two rows) both bail.
  if (currentUploadRes.error) {
    return { people: [], hoursWeekFloor: null, error: `master_list_uploads: ${currentUploadRes.error.message}` };
  }
  const currentRows = (currentUploadRes.data ?? []) as { id: unknown }[];
  if (currentRows.length !== 1) {
    return {
      people: [],
      hoursWeekFloor: null,
      error: `master_list_uploads has ${currentRows.length} is_current rows — cannot resolve the active roster`,
    };
  }
  const currentUploadId = str(currentRows[0].id);
  if (hubRes === null) {
    return {
      people: [],
      hoursWeekFloor: null,
      error: 'Hubstaff timesheets could not be read — payable identities cannot be resolved',
    };
  }
  const { rows: hubRows, weekFloor: hoursWeekFloor } = hubRes;
  const hubEmails = new Set(hubRows.map((h) => h.email));
  const hubWeekByEmail = new Map(hubRows.map((h) => [h.email, h.weekStartDay]));
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

  /** Evidence that cannot be typo'd: the person appears in the last two
   *  timesheets (by email, or by near-complete name-token coverage), and NOT
   *  under an active person's address. The flavor-4 qualifier — also the only
   *  thing allowed to vouch for a record whose off date failed sanitization. */
  const hasRecentHours = (name: string, rawEmails: (string | null)[]): boolean => {
    const emails = rawEmails.map((e) => normEmail(e ?? '')).filter(Boolean) as string[];
    if (emails.some((e) => hubEmails.has(e) && !activeEmails.has(e))) return true;
    const toks = nameTokens(name);
    return (
      toks.size >= 2 &&
      hubRows.some((h) => !activeEmails.has(h.email) && h.tokens.size >= 2 && isSubset(h.tokens, toks))
    );
  };

  for (const raw of gmlRes.rows) {
    const r = applyDeptOverrideToRawRow(raw);
    const w = str(r['Work Email']);
    const p = str(r['Personal Email']);
    const name = str(r['Name']);
    if (!name || (!w && !p)) continue;
    const onCurrentUpload = str(r['last_seen_upload_id']) === currentUploadId;
    const rawOff = toDay(str(r['off_boarded_at']));
    const off = sanitizeOffboardDay(rawOff);
    if (rawOff && !off) {
      // Stamped, but the date claims the FUTURE — a hand-typo'd year defeats
      // every recency window at once, because they are all lower-bound checks
      // (franm@'s sheet row says 2027-04-20 and read as "relevant" to every
      // week for months). The stamp still says "offboarded", so keep the
      // person UNDATED, and only on evidence a typo can't fake: recent hours.
      if (hasRecentHours(name, [w, p])) {
        cands.push({
          name,
          department: str(r['Department']),
          work_email: w,
          personal_email: p,
          alternate_work_email: str(r['Alternate Work Email']),
          alternate_work_email_2: str(r['Alternate Work Email 2']),
          start_date: str(r['Start Date']),
          off: null,
          off_boarded_reason: str(r['off_boarded_reason']),
          on_current_upload: onCurrentUpload,
        });
      }
    } else if (off) {
      // Flavor 1/3: stamped row.
      if (off >= cutoff) {
        cands.push({
          name,
          department: str(r['Department']),
          work_email: w,
          personal_email: p,
          alternate_work_email: str(r['Alternate Work Email']),
          alternate_work_email_2: str(r['Alternate Work Email 2']),
          start_date: str(r['Start Date']),
          off,
          off_boarded_reason: str(r['off_boarded_reason']),
          on_current_upload: onCurrentUpload,
        });
      }
    } else if (!onCurrentUpload) {
      // Flavor 4: fell off the sheet unstamped. Only counts as "offboarded"
      // when they were logging hours in the last two timesheets — that both
      // filters out non-sheet people (devs/founders with no Hubstaff) and
      // dates the departure as recent enough to matter. Hub rows under an
      // ACTIVE person's email never qualify: a stale row name-matching an
      // active hour-logger is a dupe/lookalike of that active person, not a
      // leaver (the active-name guard below drops most of these anyway).
      if (hasRecentHours(name, [w, p])) {
        cands.push({
          name,
          department: str(r['Department']),
          work_email: w,
          personal_email: p,
          alternate_work_email: str(r['Alternate Work Email']),
          alternate_work_email_2: str(r['Alternate Work Email 2']),
          start_date: str(r['Start Date']),
          off: null,
          off_boarded_reason: null,
          // Flavor 4 IS "stale upload id" — never the current upload.
          on_current_upload: false,
        });
      }
    }
  }

  for (const r of queueRows) {
    const name = str(r['employee_name']);
    const w = str(r['employee_work_email']);
    const p = str(r['employee_personal_email']) ?? str(r['employee_email']);
    if (!name || (!w && !p)) continue;
    // decided_at is server-stamped so a future value should be impossible —
    // but the same rule applies everywhere: a date that fails sanitization may
    // not vouch for a candidate; only recent hours may.
    const rawOff = toDay(str(r['decided_at']));
    const off = sanitizeOffboardDay(rawOff);
    if (rawOff && !off && !hasRecentHours(name, [w, p])) continue;
    cands.push({
      name,
      department: str(r['department']),
      work_email: w,
      personal_email: p,
      alternate_work_email: null,
      alternate_work_email_2: null,
      start_date: null,
      off,
      off_boarded_reason: null,
      on_current_upload: false,
    });
  }

  for (const r of sheetRows) {
    const name = str(r['name']);
    const w = str(r['work_email']);
    const p = str(r['personal_email']);
    if (!name || (!w && !p)) continue;
    // THE franm@ path. offboarded_sheet is a snapshot of a hand-edited Google
    // Sheet tab (replaceOffboardedSheetSnapshot re-copies it every sync), so a
    // typo'd cell lands here verbatim and outlives any DB-side correction.
    // A future-dated row may only stay a candidate on recent-hours evidence —
    // franm@ (2027-04-20, real last hours 2026-04-19) has none, so her row
    // stops producing a person at all instead of riding every surface to 2027.
    const rawOff = toDay(str(r['off_boarded_at']));
    const off = sanitizeOffboardDay(rawOff);
    if (rawOff && !off && !hasRecentHours(name, [w, p])) continue;
    cands.push({
      name,
      department: str(r['department']),
      work_email: w,
      personal_email: p,
      alternate_work_email: null,
      alternate_work_email_2: null,
      start_date: null,
      off,
      off_boarded_reason: null,
      on_current_upload: false,
    });
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
    } else if (c.on_current_upload && !g.on_current_upload) {
      // PROMOTION. The same person routinely carries several master rows (the
      // sheet has duplicate person rows, and a transfer or re-add mints a new
      // one). Filling identity fields first-non-null-wins over arbitrary page
      // order meant a RETIRED row could describe someone who is described
      // differently by the row the sheet still carries — and department is not
      // cosmetic here: it selects the pay week, the HSL weekend premium, the OT
      // convention, and whether "Pay this week" filters the person out of
      // dispatch entirely. The row on the CURRENT upload is what the roster
      // says today, so it wins outright for everything that describes WHO the
      // person is. (vano@simple.biz carried a retired "Sales" row and a live
      // "Lead Gen" row, with off_boarded_at stamped on BOTH — the upload id is
      // the only thing that separates them.)
      g.on_current_upload = true;
      g.name = c.name;
      g.department = c.department;
      g.start_date = c.start_date;
      g.alternate_work_email = c.alternate_work_email;
      g.alternate_work_email_2 = c.alternate_work_email_2;
      g.work_email = c.work_email ?? g.work_email;
      g.personal_email = c.personal_email ?? g.personal_email;
      g.off_boarded_reason = c.off_boarded_reason ?? g.off_boarded_reason;
      if (c.off && (!g.off || c.off > g.off)) g.off = c.off;
    } else {
      g.department = g.department ?? c.department;
      g.work_email = g.work_email ?? c.work_email;
      g.personal_email = g.personal_email ?? c.personal_email;
      g.alternate_work_email = g.alternate_work_email ?? c.alternate_work_email;
      g.alternate_work_email_2 = g.alternate_work_email_2 ?? c.alternate_work_email_2;
      g.start_date = g.start_date ?? c.start_date;
      g.off_boarded_reason = g.off_boarded_reason ?? c.off_boarded_reason;
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
      off_boarded_reason: g.off_boarded_reason,
      hubstaff_email,
      last_hours_week_start: hubstaff_email ? hubWeekByEmail.get(hubstaff_email) ?? null : null,
      alternate_work_email: g.alternate_work_email,
      alternate_work_email_2: g.alternate_work_email_2,
      start_date: g.start_date,
    });
  }

  // Most recent departures first; undated (just fell off the sheet) count as
  // the most recent of all. Alphabetical within a day.
  people.sort(
    (a, b) =>
      (b.off_boarded_at ?? '9999-99-99').localeCompare(a.off_boarded_at ?? '9999-99-99') ||
      a.name.localeCompare(b.name),
  );
  // Headroom cap. This started as a picker-sized limit, but the list now also
  // decides PAY: the Payroll Wizard's final-pay overlay reads it to resolve a
  // leaver's department, and truncation would silently hand someone back the
  // stale key this list exists to correct. Callers week-scope AFTER this slice,
  // so a heavy offboarding fortnight could otherwise push a still-owed person
  // out. At 289/300 the old cap was eleven departures from doing exactly that.
  // The 90-day window is the real bound; this is only a runaway guard.
  const CAP = 1000;
  if (people.length > CAP) {
    console.warn(`[recently-offboarded] ${people.length} leavers in ${days}d — truncating to ${CAP}.`);
  }
  return { people: people.slice(0, CAP), hoursWeekFloor, error: null };
}
