import 'server-only';

/** [TERMINATION-DOCS]
 * Person search for the Termination Docs tab: one rep-typed fragment in, a SET
 * of candidate identities out.
 *
 * A rep holding a reference request has a NAME. The person may have left in
 * 2023, their address may be one nobody remembers, and the whole point of this
 * tab is that they can still be found — so this search matches a PARTIAL value
 * (`%fragment%`) across every name and email column of all three carriers, not
 * just a full address typed exactly. An exact address is a special case of that.
 *
 * PERSONAL EMAIL SEARCHES; WORK EMAIL IDENTIFIES (G1) — and so does a NAME. One
 * inbox backs several master identities — `carla@simple.biz` (active) and
 * `carlath@simple.biz` (resigned 2026-06-03) share `carlathomas0112@gmail.com`
 * (src/lib/roster/offboard-evidence.ts:41-48) — and one surname backs many more,
 * so this module never collapses a query to one person. It returns every
 * candidate it can see, each stamped with the refusal `resolveTerminationFacts`
 * will apply, and the rep picks. The identity that comes back is ALWAYS the work
 * email carried by the matched row; a name or a personal address is only ever
 * how the row was FOUND, never a fact the document derives anything from.
 *
 * No `.or()` anywhere: PostgREST parses a logical-filter string as
 * `column.op.value` and our email values contain dots, so the parser mis-splits
 * and reports a bogus "column does not exist"
 * (src/lib/supabase/global-master-list-db.ts:1359-1373). ONE `.ilike` per
 * column instead, every value through `escapeLikePattern` — unescaped, `_` is
 * an ILIKE single-char wildcard and `a_b@x.com` matches `axb@x.com`, a
 * DIFFERENT PERSON, and `%` typed by the rep would match everything.
 *
 * Two limits, both of which SPEAK rather than truncate silently:
 *   · a query under TERMINATION_SEARCH_MIN_QUERY characters runs NO read and
 *     comes back `tooShort` — `%a%` is a table dump, not a search;
 *   · a result set over TERMINATION_SEARCH_CANDIDATE_CAP identities comes back
 *     capped AND `truncated`, because a row a rep cannot see reads as "this
 *     person was never offboarded".
 *
 * Every read is paged: PostgREST truncates at db.max-rows (1000) EVEN WITH
 * `.range()`, and a truncated candidate set is indistinguishable from "this
 * person does not exist".
 *
 * This module is the READS only. The union and the refusal stamping live in the
 * pure `./termination-arbitration`, which `npm test` can import (a
 * `server-only` module cannot be).
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import {
  TERMINATION_SEARCH_CANDIDATE_CAP,
  TERMINATION_SEARCH_MIN_QUERY,
  type TerminationSearchCandidate,
  type TerminationSearchMatchedColumn,
} from './types';
import { escapeLikePattern } from './reason-key';
import {
  buildTerminationCandidates,
  type TerminationCandidateObservation,
} from './termination-arbitration';

type Row = Record<string, unknown>;

/** The four `global_master_list` email columns a rep may legitimately type.
 *  Each gets its OWN paged pass — see the `.or()` note in the file header. */
const MASTER_EMAIL_COLUMNS = [
  'Work Email',
  'Personal Email',
  'Alternate Work Email',
  'Alternate Work Email 2',
] as const;

/** Verbatim projection. `global_master_list` is a CSV/sheet import, so its
 *  columns are quoted and capitalised; a rename here silently 400s the query. */
const MASTER_SELECT =
  'id,"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Start Date",off_boarded_at,off_boarded_reason,last_seen_upload_id';

const SHEET_SELECT =
  'id,personal_email,work_email,name,department,start_date,off_boarded_at,off_boarded_reason,origin';

const QUEUE_SELECT =
  'employee_name,employee_email,employee_work_email,employee_personal_email,department,decided_at,reason';

function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
}

/** `last_seen_upload_id` is numeric; an unparseable one sorts oldest, the same
 *  coercion Payroll Readiness uses (payroll-readiness.ts:794). */
function uploadSeq(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Most whitespace-separated words honoured in a name query. Every word is
 *  ANDed, so more words can only NARROW the result; the cap exists so a pasted
 *  paragraph cannot build an unbounded filter chain. */
const MAX_NAME_TOKENS = 6;

/** `%fragment%`, LIKE-escaped. The escape is not optional: `_` and `%` are ILIKE
 *  wildcards and both occur in real addresses and pasted text. */
function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

export interface TerminationSearchResult {
  candidates: TerminationSearchCandidate[];
  /** Distinct identities that matched BEFORE the cap. */
  matched: number;
  /** true when `matched` exceeded the cap and `candidates` is a prefix of it. */
  truncated: boolean;
  /** true when the query was too short to run a partial search at all. */
  tooShort: boolean;
  degraded: string[];
  error: string | null;
}

export async function searchTerminationCandidates(
  query: string,
): Promise<TerminationSearchResult> {
  const empty = { candidates: [], matched: 0, truncated: false, degraded: [] };
  const q = normEmail(query);
  if (!q) return { ...empty, tooShort: false, error: null };
  // A one- or two-character fragment matches most of the master list. Answering
  // it with a capped page would tell the rep "narrow this" only by accident; say
  // it outright instead.
  if (q.length < TERMINATION_SEARCH_MIN_QUERY) {
    return { ...empty, tooShort: true, error: null };
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return { ...empty, tooShort: false, error: 'Supabase not configured' };
  }

  /** The whole query, as one fragment: what an address (or a single word) is. */
  const pat = containsPattern(q);
  /** Each word, ANDed: "carla thomas" has to find "Thomas, Carla" too — the
   *  master Name column is Last-comma-First for most of the table. */
  const nameTokens = q.split(/\s+/).filter(Boolean).slice(0, MAX_NAME_TOKENS).map(containsPattern);
  /** A name pass with an EMPTY token list would carry no filter at all and drain
   *  the whole table. `q` is non-empty and trimmed here, so there is always at
   *  least one token; this keeps that true whatever `q`'s normalization becomes. */
  const namePats = nameTokens.length > 0 ? nameTokens : [pat];

  const degraded: string[] = [];
  /** Every read failure is BOTH surfaced to the rep and returned; never swallowed. */
  const note = (what: string, err: string | null): void => {
    if (err) degraded.push(`${what}: ${err}`);
  };

  const masterEmailPasses = await Promise.all(
    MASTER_EMAIL_COLUMNS.map((col) =>
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('global_master_list')
          .select(MASTER_SELECT)
          .ilike(`"${col}"`, pat)
          .order('id', { ascending: true })
          .range(from, to),
      ).then((res) => ({ col, ...res })),
    ),
  );

  const [
    masterName,
    sheetWork,
    sheetPersonal,
    sheetName,
    queuePersonal,
    queueEmail,
    queueWork,
    queueName,
  ] = await Promise.all([
      // The NAME pass. Every word ANDed on the ONE column — chained `.ilike`s,
      // never `.or()`.
      selectAllPaged<Row>((from, to) => {
        let qb = supabase.from('global_master_list').select(MASTER_SELECT);
        for (const p of namePats) qb = qb.ilike('"Name"', p);
        return qb.order('id', { ascending: true }).range(from, to);
      }),
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('offboarded_sheet')
          .select(SHEET_SELECT)
          .ilike('work_email', pat)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('offboarded_sheet')
          .select(SHEET_SELECT)
          .ilike('personal_email', pat)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      selectAllPaged<Row>((from, to) => {
        let qb = supabase.from('offboarded_sheet').select(SHEET_SELECT);
        for (const p of namePats) qb = qb.ilike('name', p);
        return qb.order('id', { ascending: true }).range(from, to);
      }),
      // `offboarding_queue.employee_email` AND `employee_personal_email` both hold
      // PERSONAL addresses on every completed row (460/460, measured 2026-08-21),
      // so both are SEARCH keys; only `employee_work_email` is harvested as an
      // identity, whichever column the query actually matched.
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('offboarding_queue')
          .select(QUEUE_SELECT)
          .eq('status', 'completed')
          .ilike('employee_personal_email', pat)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('offboarding_queue')
          .select(QUEUE_SELECT)
          .eq('status', 'completed')
          .ilike('employee_email', pat)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      selectAllPaged<Row>((from, to) =>
        supabase
          .from('offboarding_queue')
          .select(QUEUE_SELECT)
          .eq('status', 'completed')
          .ilike('employee_work_email', pat)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      selectAllPaged<Row>((from, to) => {
        let qb = supabase
          .from('offboarding_queue')
          .select(QUEUE_SELECT)
          .eq('status', 'completed');
        for (const p of namePats) qb = qb.ilike('employee_name', p);
        return qb.order('id', { ascending: true }).range(from, to);
      }),
    ]);

  const [upload, gml] = await Promise.all([
    supabase
      .from('master_list_uploads')
      .select('id')
      .eq('is_current', true)
      .then(({ data, error }) => ({
        // Exactly one row is the healthy shape; anything else means the roster
        // cannot say which upload is current, so no row gets promoted.
        id: !error && (data ?? []).length === 1 ? str((data ?? [])[0]?.id) : null,
        error: error?.message ?? null,
      })),
    fetchGmlStatusMap(),
  ]);

  for (const p of masterEmailPasses) note(`global_master_list."${p.col}"`, p.error);
  note('global_master_list."Name"', masterName.error);
  note('offboarded_sheet.work_email', sheetWork.error);
  note('offboarded_sheet.personal_email', sheetPersonal.error);
  note('offboarded_sheet.name', sheetName.error);
  note('offboarding_queue.employee_personal_email', queuePersonal.error);
  note('offboarding_queue.employee_email', queueEmail.error);
  note('offboarding_queue.employee_work_email', queueWork.error);
  note('offboarding_queue.employee_name', queueName.error);
  note('master_list_uploads', upload.error);
  note('global_master_list status map', gml.error);

  const observations: TerminationCandidateObservation[] = [];

  const masterPasses: Array<{ col: TerminationSearchMatchedColumn; rows: Row[] }> = [
    ...masterEmailPasses.map((p) => ({ col: p.col, rows: p.rows })),
    { col: 'Name', rows: masterName.rows },
  ];

  for (const pass of masterPasses) {
    for (const r of pass.rows) {
      observations.push({
        source: 'master',
        matchedColumn: pass.col,
        workEmail: normEmail(str(r['Work Email'])),
        personalEmail: normEmail(str(r['Personal Email'])),
        name: str(r['Name']),
        departmentRaw: str(r['Department']),
        rawOffDate: str(r['off_boarded_at']),
        rawReason: str(r['off_boarded_reason']),
        onCurrentUpload: upload.id !== null && str(r['last_seen_upload_id']) === upload.id,
        uploadSeq: uploadSeq(r['last_seen_upload_id']),
      });
    }
  }

  for (const [rows, col] of [
    [sheetWork.rows, 'offboarded_sheet.work_email'],
    [sheetPersonal.rows, 'offboarded_sheet.personal_email'],
    [sheetName.rows, 'offboarded_sheet.name'],
  ] as const) {
    for (const r of rows) {
      observations.push({
        source: 'sheet',
        matchedColumn: col,
        workEmail: normEmail(str(r['work_email'])),
        personalEmail: normEmail(str(r['personal_email'])),
        name: str(r['name']),
        departmentRaw: str(r['department']),
        rawOffDate: str(r['off_boarded_at']),
        rawReason: str(r['off_boarded_reason']),
        onCurrentUpload: false,
        uploadSeq: 0,
      });
    }
  }

  for (const [rows, col] of [
    [queuePersonal.rows, 'offboarding_queue.employee_personal_email'],
    [queueEmail.rows, 'offboarding_queue.employee_email'],
    [queueWork.rows, 'offboarding_queue.employee_work_email'],
    [queueName.rows, 'offboarding_queue.employee_name'],
  ] as const) {
    for (const r of rows) {
      const work = normEmail(str(r['employee_work_email']));
      // Only the work column is an identity here — whichever column the query
      // matched, the identity is `employee_work_email` — and a completed row
      // without one cannot name a person this feature may document.
      if (!work) continue;
      observations.push({
        source: 'queue',
        matchedColumn: col,
        workEmail: work,
        personalEmail: normEmail(str(r['employee_personal_email']) ?? str(r['employee_email'])),
        name: str(r['employee_name']),
        departmentRaw: str(r['department']),
        rawOffDate: str(r['decided_at']),
        rawReason: str(r['reason']),
        onCurrentUpload: false,
        uploadSeq: 0,
      });
    }
  }

  const all = buildTerminationCandidates({
    observations,
    gmlStatus: gml.map,
    gmlStatusError: gml.error,
  });

  // Capped, never silently: `buildTerminationCandidates` sorts newest-departure
  // first, so the cap keeps the rows a rep is likeliest to want AND the response
  // states that more exist.
  const truncated = all.length > TERMINATION_SEARCH_CANDIDATE_CAP;
  const candidates = truncated ? all.slice(0, TERMINATION_SEARCH_CANDIDATE_CAP) : all;

  return {
    candidates,
    matched: all.length,
    truncated,
    tooShort: false,
    degraded,
    error: degraded.length ? degraded.join('; ') : null,
  };
}
