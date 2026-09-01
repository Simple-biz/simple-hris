import 'server-only';

/**
 * Person search for the Signing Queue's "Generate COE" dialog: one rep-typed
 * fragment in, a set of ACTIVE Global Master List candidates out.
 *
 * The population rule is Kane's (2026-09-01): active GML people only. The
 * verdict is the GML's own — `fetchGmlStatusMap` (any unstamped row carrying
 * the work email counts active; a stamped duplicate never shadows the live
 * row). A status-map read failure returns an ERROR and no candidates, because
 * this surface issues signed certificates of current engagement and must fail
 * closed — the opposite trade from the Payment Catalog's keep-leaning guards.
 *
 * WORK EMAIL IDENTIFIES; a name or personal email only SEARCHES (Termination
 * Docs' G1): the fold drops rows without a work email, and the generate route
 * accepts nothing but a work email.
 *
 * No `.or()` anywhere — PostgREST mis-splits logical-filter strings on the dots
 * in email values, and it cannot reference a quoted column at all. ONE `.ilike`
 * per column, every value through `escapeLikePattern` (`_`/`%` are wildcards).
 * Every read is paged via `selectAllPaged`: PostgREST truncates at db.max-rows
 * (1000) EVEN WITH `.range()`.
 *
 * The pure fold + gate live in ./coe-admin.ts, which `npm test` imports.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { normEmail } from '@/lib/email/norm-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import { escapeLikePattern } from './termination/reason-key';
import {
  COE_SEARCH_CANDIDATE_CAP,
  COE_SEARCH_MIN_QUERY,
  foldCoeCandidates,
  type CoeCandidateObservation,
  type CoeSearchCandidate,
} from './coe-admin';

type Row = Record<string, unknown>;

/** Verbatim projection — `global_master_list` is a sheet import, so its columns
 *  are quoted and capitalised; a rename here silently 400s the query. */
const MASTER_SELECT = 'id,"Name","Work Email","Personal Email","Department",last_seen_upload_id';

/** Most whitespace-separated words honoured in a name query; every word is
 *  ANDed so more words only NARROW, and the cap stops a pasted paragraph from
 *  building an unbounded filter chain (same rule as termination-search). */
const MAX_NAME_TOKENS = 6;

function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s : null;
}

/** `last_seen_upload_id` is numeric; an unparseable one sorts oldest. */
function uploadSeq(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface CoeSearchResult {
  candidates: CoeSearchCandidate[];
  /** Distinct active identities that matched BEFORE the cap. */
  matched: number;
  truncated: boolean;
  /** true when the query was under the minimum and NO read ran. */
  tooShort: boolean;
  error: string | null;
}

export async function searchCoeCandidates(query: string): Promise<CoeSearchResult> {
  const empty = { candidates: [], matched: 0, truncated: false };
  const q = normEmail(query);
  if (!q) return { ...empty, tooShort: false, error: null };
  if (q.length < COE_SEARCH_MIN_QUERY) return { ...empty, tooShort: true, error: null };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ...empty, tooShort: false, error: 'Supabase not configured' };

  const pat = containsPattern(q);
  const nameTokens = q.split(/\s+/).filter(Boolean).slice(0, MAX_NAME_TOKENS).map(containsPattern);
  // A name pass with an empty token list would carry no filter at all and drain
  // the table; `q` is non-empty here, this keeps that true whatever the
  // normalization becomes.
  const namePats = nameTokens.length > 0 ? nameTokens : [pat];

  const [workPass, personalPass, namePass, gml] = await Promise.all([
    selectAllPaged<Row>((from, to) =>
      supabase
        .from('global_master_list')
        .select(MASTER_SELECT)
        .ilike('"Work Email"', pat)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    selectAllPaged<Row>((from, to) =>
      supabase
        .from('global_master_list')
        .select(MASTER_SELECT)
        .ilike('"Personal Email"', pat)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    selectAllPaged<Row>((from, to) => {
      let qb = supabase.from('global_master_list').select(MASTER_SELECT);
      for (const p of namePats) qb = qb.ilike('"Name"', p);
      return qb.order('id', { ascending: true }).range(from, to);
    }),
    fetchGmlStatusMap(),
  ]);

  // Fail closed, whole-read: without the status map there is no active verdict,
  // and answering with unvetted candidates would offer certificates for people
  // who may have left. Partial pass failures also refuse — a missing pass makes
  // "no match" indistinguishable from "not searched".
  const readErr = workPass.error ?? personalPass.error ?? namePass.error ?? gml.error;
  if (readErr) return { ...empty, tooShort: false, error: readErr };

  const observations: CoeCandidateObservation[] = [];
  for (const rows of [workPass.rows, personalPass.rows, namePass.rows]) {
    for (const r of rows) {
      observations.push({
        workEmail: normEmail(str(r['Work Email'])),
        name: str(r['Name']),
        departmentRaw: str(r['Department']),
        uploadSeq: uploadSeq(r['last_seen_upload_id']),
      });
    }
  }

  const all = foldCoeCandidates(observations, gml.map);
  const truncated = all.length > COE_SEARCH_CANDIDATE_CAP;
  return {
    candidates: truncated ? all.slice(0, COE_SEARCH_CANDIDATE_CAP) : all,
    matched: all.length,
    truncated,
    tooShort: false,
    error: null,
  };
}
