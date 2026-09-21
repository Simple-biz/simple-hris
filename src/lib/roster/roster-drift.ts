/**
 * Do the HRIS's two answers to "who is active" still agree?
 *
 * Until 2026-09-21 there were two definitions and nothing compared them:
 *
 *   - `active_employees`            — unstamped AND on the current upload
 *   - the external API / Integrations — unstamped, full stop
 *
 * They differed by 508 rows, and the silence is what let it run: Admin →
 * Integrations reported 1,723 while HR → Global Master List reported 1,215, and
 * no surface in the app was in a position to notice. Kane opened it as *"the OMS
 * pulled 1667 not 1143 … lets fix this data once and for all"*.
 *
 * Once `active_employees` drops the upload gate (spec step 5) the two become one
 * query and this verdict should read zero forever. Until then it measures the
 * residue the reconcile deliberately left for HR.
 *
 * Pure so it can be tested; the Supabase read lives in `diagnostics-probes.ts`.
 */

export type RosterDriftInput = {
  /** Rows with `off_boarded_at IS NULL` — what the external API serves. */
  activeRows: number;
  /** Rows on `active_employees` — what every HR screen shows. */
  viewRows: number;
  /** People on the API's set but not the view's, alias-aware. */
  unexplained: number;
};

export type RosterDriftVerdict = {
  status: 'healthy' | 'warning' | 'critical';
  summary: string;
  details: string[];
};

const n = (v: number) => v.toLocaleString('en-US');

export function judgeRosterDrift(input: RosterDriftInput): RosterDriftVerdict {
  const { activeRows, viewRows, unexplained } = input;

  // `active_employees` is a strict SUBSET of the unstamped rows by construction.
  // More rows in the subset than the superset means the read is wrong, and a
  // tidy "no drift" would bury it.
  if (viewRows > activeRows) {
    return {
      status: 'critical',
      summary: `Impossible roster: the active view holds ${n(viewRows)} rows but only ${n(activeRows)} are unstamped.`,
      details: [
        'active_employees is a subset of global_master_list WHERE off_boarded_at IS NULL.',
        'A larger subset means one of the two reads is broken, not that the roster grew.',
      ],
    };
  }

  // 0 === 0 is arithmetically no drift, and is also exactly the 2026-08-03
  // incident shape: the view returned zero rows with HTTP 200 and the wizard
  // re-labelled 422 people "Unassigned".
  if (activeRows === 0 || viewRows === 0) {
    return {
      status: 'critical',
      summary: 'No active employees on the roster — this is not "no drift".',
      details: [
        'Either no upload is flagged is_current, or the view is unreadable by this client.',
        'An empty roster reads as HTTP 200 with no error; it must never pass as healthy.',
      ],
    };
  }

  const gap = activeRows - viewRows;
  if (gap === 0 && unexplained === 0) {
    return {
      status: 'healthy',
      summary: `Both definitions of "active" agree: ${n(viewRows)} people.`,
      details: [
        'The external API and HR → Global Master List are answering from the same set.',
      ],
    };
  }

  // Deliberately not a threshold. One corpse is one person the external API is
  // wrong about, and the 508-row gap started as one.
  const status: RosterDriftVerdict['status'] = gap > 50 || unexplained > 50 ? 'critical' : 'warning';
  return {
    status,
    summary:
      `The external API serves ${n(gap)} row${gap === 1 ? '' : 's'} more than HR → Global Master List` +
      (unexplained ? ` — ${n(unexplained)} people it cannot account for.` : '.'),
    details: [
      `unstamped rows ${n(activeRows)} · active_employees ${n(viewRows)} · unexplained people ${n(unexplained)}`,
      'A transfer that forks a row is the usual cause — see docs/features/gml-roster-source-of-truth.md.',
      'Rehearse scripts/reconcile-gml-active-only.mts to see the split before writing anything.',
    ],
  };
}
