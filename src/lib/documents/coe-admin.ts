// Accounting-initiated Certificate of Engagement — the PURE rules.
//
// The Signing Queue's "Generate COE" flow lets an accounting rep issue and sign
// a COE on behalf of an employee who would struggle to request it themselves.
// The population rule is Kane's (2026-09-01): **active people from the Global
// Master List only** — the GML's own verdict (`fetchGmlStatusMap`: any unstamped
// row carrying the work email counts active; a stamped duplicate never shadows
// the live row).
//
// WORK EMAIL IDENTIFIES; a name or personal email only ever SEARCHES — the same
// G1 rule Termination Docs pinned (one personal inbox backs several master
// identities), so candidates without a work email are dropped and the generate
// endpoint accepts nothing but a work email.
//
// Unlike the Payment Catalog's keep-leaning offboard guards, the gate here
// fails CLOSED: a false "active" issues a signed certificate asserting current
// engagement, so refusing is always the cheap direction — a status-map read
// error refuses, a person absent from the map refuses, a stamped person
// refuses.
//
// This module is imported by `npm test` (node --import tsx --test), so it must
// stay free of 'server-only' imports; the reads live in ./coe-admin-search.ts.

import { normEmail } from '@/lib/email/norm-email';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

/** A query under this length runs NO read — `%a%` is a table dump, not a search. */
export const COE_SEARCH_MIN_QUERY = 2;

/** Candidates returned per search. Over the cap the response says `truncated`
 *  rather than silently dropping rows — a row a rep cannot see reads as "this
 *  person is not active". */
export const COE_SEARCH_CANDIDATE_CAP = 30;

/** Structurally identical to `GmlEmailStatus` (src/lib/roster/gml-status.ts),
 *  restated here so this module never imports a 'server-only' file. */
export interface CoeGmlStatus {
  active: boolean;
  offBoardedAt: string | null;
  offBoardedReason: string | null;
}

/** One `global_master_list` row as the search passes observed it. */
export interface CoeCandidateObservation {
  workEmail: string | null;
  name: string | null;
  departmentRaw: string | null;
  /** `last_seen_upload_id` as a number — newer rows carry the fresher display
   *  fields when one work email owns several rows. Unparseable sorts oldest. */
  uploadSeq: number;
}

/** What the picker shows. `workEmail` is the identity; everything else is
 *  display only. */
export interface CoeSearchCandidate {
  workEmail: string;
  name: string | null;
  /** Human label — raw `hsl:*` slugs never reach a screen (formatDeptLabel). */
  department: string | null;
}

/**
 * Dedupe the raw observations into active candidates.
 *
 * - rows without a normalized work email are dropped (nothing to identify by);
 * - one candidate per work email — the observation with the highest uploadSeq
 *   supplies the display fields, and blanks are backfilled from older rows;
 * - only work emails the GML status map marks ACTIVE survive;
 * - sorted by name (then email) so the picker reads alphabetically.
 */
export function foldCoeCandidates(
  observations: readonly CoeCandidateObservation[],
  gmlStatus: ReadonlyMap<string, CoeGmlStatus>,
): CoeSearchCandidate[] {
  const best = new Map<string, CoeCandidateObservation & { workEmail: string }>();
  for (const obs of observations) {
    const email = normEmail(obs.workEmail ?? '');
    if (!email) continue;
    const cur = best.get(email);
    if (!cur) {
      best.set(email, { ...obs, workEmail: email });
      continue;
    }
    if (obs.uploadSeq > cur.uploadSeq) {
      best.set(email, {
        workEmail: email,
        name: obs.name?.trim() || cur.name,
        departmentRaw: obs.departmentRaw?.trim() || cur.departmentRaw,
        uploadSeq: obs.uploadSeq,
      });
    } else {
      // Older row only ever fills holes the newer one left blank.
      if (!cur.name && obs.name?.trim()) cur.name = obs.name.trim();
      if (!cur.departmentRaw && obs.departmentRaw?.trim()) cur.departmentRaw = obs.departmentRaw.trim();
    }
  }

  const out: CoeSearchCandidate[] = [];
  for (const obs of best.values()) {
    // Active people only — the whole population rule. A missing entry means no
    // GML row carries this email at all (shouldn't happen for rows read FROM
    // the GML, but a race with a sync can produce it); it is not proof of
    // activity, so it drops.
    if (gmlStatus.get(obs.workEmail)?.active !== true) continue;
    const dept = obs.departmentRaw?.trim() || null;
    out.push({
      workEmail: obs.workEmail,
      name: obs.name?.trim() || null,
      department: dept ? formatDeptLabel(dept) : null,
    });
  }

  out.sort((a, b) => {
    const an = (a.name ?? a.workEmail).toLowerCase();
    const bn = (b.name ?? b.workEmail).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : a.workEmail.localeCompare(b.workEmail);
  });
  return out;
}

/** Why the active gate refused — `status` is the HTTP status the route answers
 *  with, `code` a stable discriminator for the dialog. */
export interface CoeActiveGateRejection {
  status: number;
  code: 'roster_unavailable' | 'not_on_gml' | 'not_active';
  message: string;
}

export type CoeActiveGateResult =
  | { ok: true }
  | { ok: false; rejection: CoeActiveGateRejection };

/**
 * The generate/preview-side re-check of the population rule, judged at request
 * time against the live status map — never against what the picker showed
 * minutes earlier. FAILS CLOSED on every non-active arm (see the file header).
 */
export function decideCoeActiveGate(params: {
  status: CoeGmlStatus | undefined;
  statusError: string | null;
}): CoeActiveGateResult {
  // Error FIRST: a broken read is a config/infra failure, and reading it as
  // "not on the list" would tell the rep a real employee doesn't exist.
  if (params.statusError) {
    return {
      ok: false,
      rejection: {
        status: 500,
        code: 'roster_unavailable',
        message: `Couldn't verify the roster (${params.statusError}) — try again`,
      },
    };
  }
  if (!params.status) {
    return {
      ok: false,
      rejection: {
        status: 422,
        code: 'not_on_gml',
        message: 'This email is not on the Global Master List — a COE can only be generated for an active GML person.',
      },
    };
  }
  if (!params.status.active) {
    const when = params.status.offBoardedAt ? ` (off-boarded ${params.status.offBoardedAt}${
      params.status.offBoardedReason ? `, ${params.status.offBoardedReason}` : ''
    })` : '';
    return {
      ok: false,
      rejection: {
        status: 422,
        code: 'not_active',
        message: `This person is not active on the Global Master List${when} — a Certificate of Engagement asserts current engagement, so it can't be issued for them.`,
      },
    };
  }
  return { ok: true };
}
