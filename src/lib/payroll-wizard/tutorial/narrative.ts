/**
 * [WIZARD-TUTORIAL] Processing Narrative — deterministic, templated rendering
 * of a payroll week's audit events into sessions and sentences.
 *
 * The trail window is the CALENDAR Sun–Sat week (Kane, 2026-08-17) — not the
 * cycle and not the lock lifetime — precisely so every Start/Stop toggle is
 * auditable against the week itself: turning processing off does NOT end the
 * week's trail; it keeps collecting until the next Sunday begins.
 *
 * Everything here is pure. Events come from `audit_log` via
 * /api/payroll-wizard/audit-week; nothing is ever persisted by this feature —
 * the cycle close-out stays the only per-cycle record (cycle-closeout.md).
 */

export type NarrativeEventInput = {
  id: string;
  created_at: string;
  user_name: string;
  user_role: string;
  action: string;
  resource: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
};

// ── Week window (Sun 00:00 local → next Sun 00:00 local) ────────────────────

export type PayrollWeekWindow = {
  /** Inclusive instant, ISO. */
  startIso: string;
  /** Exclusive instant, ISO. */
  endIso: string;
  /** Local date-only bounds for labels, YYYY-MM-DD (Sunday / Saturday). */
  startDateIso: string;
  endDateIso: string;
};

function toLocalDateOnlyIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The Sun–Sat payroll week containing `d`, in the machine's local timezone. */
export function payrollWeekWindowFor(d: Date): PayrollWeekWindow {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const saturday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startDateIso: toLocalDateOnlyIso(start),
    endDateIso: toLocalDateOnlyIso(saturday),
  };
}

/** Shift a window by whole weeks (negative = into the past). */
export function shiftWeekWindow(w: PayrollWeekWindow, deltaWeeks: number): PayrollWeekWindow {
  const start = new Date(w.startIso);
  return payrollWeekWindowFor(
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + deltaWeeks * 7 + 1),
  );
}

// ── Narrative model ──────────────────────────────────────────────────────────

export type NarrativeToggle = {
  at: string;
  by: string;
  kind: 'started' | 'stopped';
};

export type NarrativeSegment = {
  /** 1-based session number; null for the "processing off" gaps between them. */
  session: number | null;
  /** Opening sentence ("Kane started processing …") or gap heading. */
  heading: string;
  /** Templated summary sentences for the events inside this segment. */
  lines: string[];
  eventCount: number;
};

export type ProcessingNarrative = {
  weekLabel: string;
  toggles: NarrativeToggle[];
  segments: NarrativeSegment[];
  totalEvents: number;
  /** True when a session opened inside the window and never closed in it. */
  hasOpenSession: boolean;
};

export type TimeFormatter = (iso: string) => string;

/** Local-time default: "Tue, Aug 11, 9:04 AM". Injectable for tests. */
export const defaultTimeFormatter: TimeFormatter = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

// ── Sentence templates ───────────────────────────────────────────────────────

function firstName(userName: string): string {
  const trimmed = (userName ?? '').trim();
  if (!trimmed || trimmed === 'anonymous') return 'Someone';
  const beforeAt = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  return beforeAt.split(/\s+/)[0];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function detailStr(details: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!details) return null;
  for (const k of keys) {
    const v = details[k];
    if (v != null && (typeof v === 'string' || typeof v === 'number')) return String(v);
  }
  return null;
}

/** Category buckets that aggregate into one sentence per segment. */
const EDIT_ACTIONS = new Set(['wizard.edited', 'wizard.bonus_edited', 'wizard.addition_edited']);
const READINESS_ACTIONS = new Set([
  'payroll.rate.set',
  'payroll.kpi.marked_ready',
  'payroll.kpi.locked',
  'payroll.kpi.reopened',
  'payroll.bank.exempted',
  'payroll.bank.exemption_undone',
]);
const ORPHANAGE_ACTIONS = new Set([
  'orphanage.budget_decided',
  'orphanage_budget.approved',
  'orphanage_budget.rejected',
  'orphanage.dispatched',
]);
const GIFT_ACTIONS = new Set(['tenure.gift_decided', 'gift.payment_edited']);

/**
 * Render one segment's events into templated sentences. Aggregates chatty
 * categories (edits) into counts; keeps money-moving events one line each.
 */
function renderSegmentLines(
  events: NarrativeEventInput[],
  fmt: TimeFormatter,
): string[] {
  const lines: string[] = [];

  const edits = events.filter((e) => EDIT_ACTIONS.has(e.action));
  if (edits.length > 0) {
    const editors = [...new Set(edits.map((e) => firstName(e.user_name)))];
    const people = [
      ...new Set(
        edits
          .map((e) => detailStr(e.details, 'employee_email', 'recipient_email') ?? e.resource_id)
          .filter((v): v is string => !!v),
      ),
    ];
    const who = editors.join(', ');
    const touch =
      people.length > 0
        ? ` touching ${people.length} ${people.length === 1 ? 'person' : 'people'}`
        : '';
    lines.push(`${who} made ${plural(edits.length, 'pay edit')}${touch} (bonuses, additions, adjustments).`);
  }

  const readiness = events.filter((e) => READINESS_ACTIONS.has(e.action));
  if (readiness.length > 0) {
    lines.push(`${plural(readiness.length, 'readiness fix')} (rates set, KPI locks, bank exemptions).`);
  }

  for (const e of events) {
    const who = firstName(e.user_name);
    const at = fmt(e.created_at);
    switch (e.action) {
      case 'wizard.opened':
        lines.push(`${who} opened the wizard (${at}).`);
        break;
      case 'wizard.cycle_selected': {
        const file = detailStr(e.details, 'source_file') ?? e.resource_id ?? 'another cycle';
        lines.push(`${who} switched the active cycle to ${file} (${at}).`);
        break;
      }
      case 'wizard.fx_rate_changed': {
        const oldV = detailStr(e.details, 'old_value', 'previous_value');
        const newV = detailStr(e.details, 'new_value', 'fx_rate');
        lines.push(
          newV
            ? `${who} changed the FX rate${oldV ? ` from ${oldV}` : ''} to ${newV} (${at}).`
            : `${who} changed the FX rate (${at}).`,
        );
        break;
      }
      case 'contractor.decided': {
        const status = detailStr(e.details, 'new_status', 'status') ?? 'decided';
        lines.push(`${who} ${status} a contractor invoice (${at}).`);
        break;
      }
      case 'contractor.retracted':
        lines.push(`${who} retracted a contractor decision (${at}).`);
        break;
      case 'payment.dispatched': {
        const count = detailStr(e.details, 'count', 'payee_count');
        lines.push(
          count
            ? `${who} dispatched payments — ${plural(Number(count), 'payee')} (${at}).`
            : `${who} dispatched payments (${at}).`,
        );
        break;
      }
      case 'payment.undone':
        lines.push(`${who} undid a payment (${at}).`);
        break;
      case 'paystubs.dispatched':
        lines.push(`${who} dispatched paystubs (${at}).`);
        break;
      default:
        break;
    }
  }

  const orphanage = events.filter((e) => ORPHANAGE_ACTIONS.has(e.action));
  if (orphanage.length > 0) {
    lines.push(`${plural(orphanage.length, 'orphanage decision')}.`);
  }
  const gifts = events.filter((e) => GIFT_ACTIONS.has(e.action));
  if (gifts.length > 0) {
    lines.push(`${plural(gifts.length, 'tenure-gift decision')}.`);
  }

  const known = new Set([
    ...EDIT_ACTIONS,
    ...READINESS_ACTIONS,
    ...ORPHANAGE_ACTIONS,
    ...GIFT_ACTIONS,
    'wizard.opened',
    'wizard.cycle_selected',
    'wizard.fx_rate_changed',
    'contractor.decided',
    'contractor.retracted',
    'payment.dispatched',
    'payment.undone',
    'paystubs.dispatched',
    'dispatch.lock_acquired',
    'dispatch.lock_released',
  ]);
  const other = events.filter((e) => !known.has(e.action));
  if (other.length > 0) {
    lines.push(`${plural(other.length, 'other recorded event')}.`);
  }

  return lines;
}

/**
 * Build the week's narrative: lock sessions in order, with "processing off"
 * segments for anything recorded outside a session — the trail never stops
 * when processing does.
 */
export function buildProcessingNarrative(
  events: NarrativeEventInput[],
  window: PayrollWeekWindow,
  formatTime: TimeFormatter = defaultTimeFormatter,
): ProcessingNarrative {
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const toggles: NarrativeToggle[] = sorted
    .filter((e) => e.action === 'dispatch.lock_acquired' || e.action === 'dispatch.lock_released')
    .map((e) => ({
      at: e.created_at,
      by: firstName(e.user_name),
      kind: e.action === 'dispatch.lock_acquired' ? ('started' as const) : ('stopped' as const),
    }));

  const segments: NarrativeSegment[] = [];
  let buffer: NarrativeEventInput[] = [];
  let sessionNumber = 0;
  let inSession = false;
  let currentHeading = 'Before processing started';

  const flush = (headingSuffix = '') => {
    if (buffer.length === 0 && !inSession) return;
    segments.push({
      session: inSession ? sessionNumber : null,
      heading: `${currentHeading}${headingSuffix}`,
      lines: renderSegmentLines(buffer, formatTime),
      eventCount: buffer.length,
    });
    buffer = [];
  };

  for (const e of sorted) {
    if (e.action === 'dispatch.lock_acquired') {
      flush();
      sessionNumber += 1;
      inSession = true;
      currentHeading = `Session ${sessionNumber} — ${firstName(e.user_name)} started processing (${formatTime(e.created_at)})`;
      continue;
    }
    if (e.action === 'dispatch.lock_released') {
      buffer.push(e);
      // Close the session: render its body, then open an "off" gap.
      segments.push({
        session: sessionNumber,
        heading: `${currentHeading} · stopped by ${firstName(e.user_name)} (${formatTime(e.created_at)})`,
        lines: renderSegmentLines(
          buffer.filter((x) => x.action !== 'dispatch.lock_released'),
          formatTime,
        ),
        eventCount: buffer.length - 1,
      });
      buffer = [];
      inSession = false;
      currentHeading = 'With processing off — the trail keeps recording until the next week';
      continue;
    }
    buffer.push(e);
  }
  flush(inSession ? ' · still running' : '');

  const hasOpenSession = inSession;

  return {
    weekLabel: `Week of ${window.startDateIso} (Sun) – ${window.endDateIso} (Sat)`,
    toggles,
    segments: segments.filter((s) => s.eventCount > 0 || s.session != null),
    totalEvents: sorted.length,
    hasOpenSession,
  };
}
