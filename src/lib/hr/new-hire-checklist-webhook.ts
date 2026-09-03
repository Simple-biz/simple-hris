import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import { isLeadGenDepartment } from "@/lib/hr/offboard-webhooks";
import {
  describeOrientationShift,
  type OrientationResolution,
} from "@/lib/hr/orientation-date";
import type {
  HrChecklistPeriod,
  HrNewHireChecklistRow,
} from "@/lib/supabase/hr-new-hire-checklist";

/**
 * Fires when HR clicks "Lock in" on the New Hire Checklist tab: POSTs the
 * week's freshly-persisted hires to n8n so each one gets the onboarding welcome
 * email (docs/features/onboarding-welcome.html).
 *
 * ONE POST containing ALL hires as a `rows[]` array (so the whole week arrives
 * in a single webhook event — the n8n *test* URL only captures one request, so
 * per-hire POSTs would drop every hire but the first). CRUCIALLY, each row is
 * SELF-CONTAINED: the welcome-email's week-level fields (`start_date`,
 * `orientation_date`, `orientation_weekday`, `zoom_link`) are baked into every
 * row alongside the hire's own fields + a derived `first_name`. That way an n8n
 * "Split Out" on `body.rows` yields one item per hire with EVERY field at the
 * item root — Gmail then maps `{{ $json.personal_email }}`, `{{ $json.first_name }}`,
 * etc. with no array index and no `body` prefix. No `cell_edits` / timestamp
 * noise is sent.
 *
 * LEAD GEN ONLY (2026-08-24). This email IS the Lead Gen orientation invite —
 * it carries the orientation Zoom link, and orientation is a Lead Gen ritual.
 * Hires in every other department are WITHHELD from `rows[]` right here, at the
 * sender, so the scope holds even if the n8n filter is edited away in the cloud
 * UI. The gate is `isLeadGenDepartment` — the SAME predicate that gates the
 * CallTools-creation webhook on orientation attendance — so both orientation
 * surfaces agree on exactly who counts as Lead Gen. A blank or unrecognised
 * department resolves to no key and is therefore withheld: fail closed. Every
 * withheld hire comes back through `skipped` (reason "not_lead_gen") so HR is
 * told who got nothing — a withheld hire is never a silent drop.
 *
 * (2026-08-21: an HSL hire on the 2026-08-23 week received the Zoom link
 * because this sender shipped all 79 rows and the flow had no filter.)
 *
 * n8n flow: Webhook → Split Out (Fields To Split Out = `body.rows`) → Filter
 * (Lead Gen only, second layer) → Gmail.
 *
 * URL resolution goes through the Admin -> Webhooks slug registry
 * (resolveWebhookUrl) so the endpoint can be rotated from the UI without a
 * redeploy; it falls back to the env var, then the hardcoded default below.
 */
export const NEW_HIRE_CHECKLIST_LOCK_SLUG = "new_hire_checklist_lock";

const DEFAULT_URL =
  "https://simpledotbiz.app.n8n.cloud/webhook-test/609dd382-6214-41c7-8a16-ed94a0b84110";

/** One hire, flattened to its current values (no edit history) + `first_name`. */
type CleanHire = {
  id: string;
  position: number;
  name: string | null;
  first_name: string | null;
  personal_email: string | null;
  location: string | null;
  phone_number: string | null;
  date_of_interview: string | null;
  source: string | null;
  hired_by: string | null;
  department: string | null;
  country: string | null;
};

/**
 * Friendly greeting name from a checklist `name`, which is stored surname-first
 * as `Surname, First Middle "Nickname"` (e.g. `Aclan, Venus Faith Agnes "Vee"`).
 * Preference order:
 *   1. the quoted nickname  -> "Vee"   (handles straight and curly quotes)
 *   2. the first given name after the comma -> "Venus"
 *   3. the first whitespace token (plain "Maria Santos" -> "Maria")
 */
function firstNameOf(name: string | null): string | null {
  const t = (name ?? "").trim();
  if (!t) return null;
  // Quote chars built from \u escapes (ASCII-only source) so the regex can't be
  // mangled by an encoding round-trip: “ ” are the curly quotes.
  const q = "[\"\\u201C\\u201D]";
  const nick = t.match(new RegExp(`${q}\\s*([^"\\u201C\\u201D]+?)\\s*${q}`));
  if (nick && nick[1]) return nick[1].trim();
  if (t.includes(",")) {
    const after = (t.split(",")[1] ?? "").trim();
    const first = after.split(/\s+/)[0];
    if (first) return first;
  }
  return t.split(/\s+/)[0] ?? null;
}

// Matches one plausible email address inside an arbitrary string. Deliberately
// stricter than "anything@anything": requires a dotted TLD so a truncated cell
// like "annalizaalgadepe420" or "juan@gmail" never reaches Gmail's To header.
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Best-effort cleanup of a checklist `personal_email` cell. HR sometimes pastes
 * sourcing notes into the cell ("addr@gmail.com (Facebook)") — Gmail then 400s
 * the whole n8n run with "Invalid To header" and every hire after that row gets
 * no welcome email (the 2026-08-02 week died at item 40 exactly this way).
 * Returns the first thing that looks like a real address, or null when the cell
 * has none (`changed` = we salvaged it out of surrounding junk).
 */
export function sanitizePersonalEmail(raw: string | null): {
  email: string | null;
  changed: boolean;
} {
  const t = (raw ?? "").trim();
  if (!t) return { email: null, changed: false };
  const m = t.match(EMAIL_IN_TEXT);
  if (!m) return { email: null, changed: false };
  return { email: m[0], changed: m[0] !== t };
}

function toCleanHire(row: HrNewHireChecklistRow, email: string | null): CleanHire {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    first_name: firstNameOf(row.name),
    personal_email: email,
    location: row.location,
    phone_number: row.phone_number,
    date_of_interview: row.date_of_interview,
    source: row.source,
    hired_by: row.hired_by,
    department: row.department,
    country: row.country,
  };
}

// ── Start-week / orientation fields for the welcome email ──────────────────
// The orientation day is NOT derived here. It comes from the shared, tested
// resolver in `@/lib/hr/orientation-date`, which the Lock-in dialog's
// "Orientation date:" line calls too — the email and the confirmation HR reads
// before sending must never be able to disagree. See that file for the rule
// (Monday by default; an enabled US holiday advances to the next weekday).
//
// start_date, orientation_date and orientation_weekday ALL key off the one
// resolved date: the email prints "your official start date" directly above the
// orientation row and calls it "your first day", so they are one day by
// construction. Splitting them ships a self-contradictory email.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD -> MM/DD/YYYY (the format the welcome email prints). */
function usDate(iso: string | null): string | null {
  if (!iso || !ISO_DATE.test(iso)) return null;
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/**
 * The orientation Zoom join link (constant across hires). Not checklist data —
 * override it without a redeploy via the N8N_ORIENTATION_ZOOM_LINK env var.
 * Default is the bare join URL for meeting 313 618 3188 (passcode dsZeA8 in the
 * email body). TODO: replace with the exact join URL Kaner provides.
 */
const ORIENTATION_ZOOM_LINK =
  process.env.N8N_ORIENTATION_ZOOM_LINK?.trim() ||
  "https://zoom.us/j/3136183188";

function resolveUrl(): Promise<string> {
  return resolveWebhookUrl(NEW_HIRE_CHECKLIST_LOCK_SLUG, {
    envVars: ["N8N_NEW_HIRE_CHECKLIST_WEBHOOK_URL"],
    defaultUrl: DEFAULT_URL,
  }).then((u) => u ?? DEFAULT_URL);
}

/**
 * Why a hire was left out of the send:
 *   "not_lead_gen"   — their department is not Lead Gen (orientation is Lead Gen
 *                      only), or the cell is blank / unrecognised. Expected, not
 *                      an error: nothing to fix unless the department is wrong.
 *   "invalid_email"  — the `personal_email` cell holds no usable address (see
 *                      sanitizePersonalEmail). HR must fix the cell and resend.
 */
export type LockWebhookSkipReason = "not_lead_gen" | "invalid_email";

/** A hire left out of the payload, with the reason HR needs to act on it. */
export type LockWebhookSkippedRow = {
  id: string;
  name: string | null;
  personal_email: string | null;
  department: string | null;
  reason: LockWebhookSkipReason;
};

/** What the send actually told hires, so the lock response / audit can say it. */
export type LockWebhookOrientation = {
  /** ISO date orientation was announced for, or null when it could not be resolved. */
  date: string | null;
  /** e.g. "Tuesday". */
  weekday: string | null;
  /** True when a holiday pushed it off the default Monday. */
  shifted: boolean;
  /** Human reason, e.g. "Moved from Monday (Sep 7) — Labor Day". Null when unshifted. */
  reason: string | null;
  /** Holidays stepped over, in order. */
  skippedHolidays: { date: string; name: string }[];
};

export type NewHireChecklistLockWebhookResult = {
  /** True once we attempted the POST (false = no sendable hires / no URL). */
  fired: boolean;
  /** Hires included in the payload (skipped rows excluded). */
  count: number;
  /** HTTP status of the POST (null if it threw / wasn't sent). */
  status: number | null;
  /** Failure message, if any (for surfacing / logging). */
  error: string | null;
  /** Hires that got NO welcome email because their address was unusable. */
  skipped: LockWebhookSkippedRow[];
  /** The orientation day this send announced (null date = unresolved, nothing sent). */
  orientation: LockWebhookOrientation;
};

/** Flatten a resolution into the result/audit shape. */
export function summarizeOrientation(res: OrientationResolution): LockWebhookOrientation {
  if (!res.ok) {
    return {
      date: null,
      weekday: null,
      shifted: false,
      reason: res.reason,
      skippedHolidays: res.skipped.map((s) => ({ date: s.date, name: s.name })),
    };
  }
  return {
    date: res.date,
    weekday: res.weekday,
    shifted: res.shifted,
    reason: describeOrientationShift(res),
    skippedHolidays: res.skipped.map((s) => ({ date: s.date, name: s.name })),
  };
}

/** POST a JSON body; best-effort, never throws. 25s timeout. */
async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(`[new-hire-checklist] lock webhook (${url}) returned ${res.status}`);
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[new-hire-checklist] lock webhook threw: ${msg}`);
    return { ok: false, status: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pure payload assembly for the lock webhook: sanitizes every row's
 * `personal_email` (see sanitizePersonalEmail) and leaves out rows with no
 * usable address — one bad cell must never 400 the Gmail node and strand every
 * hire queued behind it. Skipped rows come back separately so the lock UI can
 * tell HR exactly who got nothing. `hire_index` stays the row's 1-based place
 * in the FULL week (skips included) so a partial resend still lines up with
 * n8n's item numbering from the original run.
 */
export function buildLockWebhookPayload(args: {
  period: HrChecklistPeriod | null;
  periodStart: string;
  periodEnd: string | null;
  rows: HrNewHireChecklistRow[];
  lockedBy: string | null;
  /**
   * The week's orientation day, already resolved against the holiday calendar
   * by the caller (see `resolveOrientationDate`). Passed IN rather than derived
   * here so this function stays pure and testable, and so the date the dialog
   * showed HR is provably the date that gets emailed.
   */
  orientation: Extract<OrientationResolution, { ok: true }>;
}): { payload: Record<string, unknown>; skipped: LockWebhookSkippedRow[] } {
  const orientIso = args.orientation.date;

  // Welcome-email fields — same for every hire this week. Baked into EACH row
  // (below) so a Split Out yields self-contained per-hire items, and also kept
  // at the top level for reference.
  const emailFields = {
    start_date: usDate(orientIso),                       // {{ start_date }}        MM/DD/YYYY
    orientation_date: usDate(orientIso),                 // {{ orientation_date }}  MM/DD/YYYY
    orientation_weekday: args.orientation.weekday,       // {{ orientation_weekday }}
    zoom_link: ORIENTATION_ZOOM_LINK,                    // {{ zoom_link }}
  };

  // Diagnostics for n8n / the webhook log — NOT used by the email template.
  // They record why the date is what it is, so a shifted week is self-evident
  // in the captured payload without re-deriving anything.
  const orientationMeta = {
    orientation_shifted: args.orientation.shifted,
    orientation_default_date: usDate(args.orientation.baseDate),
    orientation_shift_reason: describeOrientationShift(args.orientation),
  };

  // One self-contained item per sendable hire: the hire's own fields + the
  // shared email/week fields, so `body.rows` splits into ready-to-send items.
  const skipped: LockWebhookSkippedRow[] = [];
  const rows: Record<string, unknown>[] = [];
  args.rows.forEach((row, i) => {
    // Department gate FIRST: a non-Lead-Gen hire is withheld whatever their
    // email cell looks like, and reporting "not_lead_gen" (rather than an email
    // complaint) is what tells HR there is nothing to fix.
    if (!isLeadGenDepartment(row.department)) {
      skipped.push({
        id: row.id,
        name: row.name,
        personal_email: row.personal_email,
        department: row.department,
        reason: "not_lead_gen",
      });
      return;
    }
    const { email } = sanitizePersonalEmail(row.personal_email);
    if (!email) {
      skipped.push({
        id: row.id,
        name: row.name,
        personal_email: row.personal_email,
        department: row.department,
        reason: "invalid_email",
      });
      return;
    }
    rows.push({
      ...toCleanHire(row, email),
      ...emailFields,
      // Explicit, already-decided flag for n8n: the flow's Filter node reads
      // this rather than re-deriving Lead Gen from the department string.
      lead_gen: true,
      hire_index: i + 1,
    });
  });

  const payload = {
    event: "new_hire_checklist.locked",
    period_start: args.periodStart,
    period_end: args.period?.period_end ?? args.periodEnd ?? null,
    status: args.period?.status ?? "locked",
    locked_at: args.period?.locked_at ?? null,
    locked_by: args.period?.locked_by ?? args.lockedBy ?? null,
    row_count: rows.length,
    ...emailFields,
    ...orientationMeta,
    rows,
  };
  return { payload, skipped };
}

/**
 * Fires ONE webhook POST for the locked week, carrying every sendable hire as
 * a self-contained row in `rows[]` (see the file header for the shape + n8n
 * Split Out flow). Rows without a usable email are excluded and reported via
 * `skipped`. Never throws — the DB write is the source of truth, so the
 * webhook is a best-effort side-effect and a failure never blocks the lock.
 *
 * The caller resolves the orientation day and hands it in. An UNRESOLVED
 * orientation (`ok: false` — an unreadable holiday calendar, or a week whose
 * every weekday is a holiday) sends NOTHING and reports the reason. Falling
 * back to the plain Monday would mail the exact date this feature exists to
 * avoid, and silently: the whole point is that nobody is told to attend
 * orientation on a holiday. Nothing was sent, so the week can simply be
 * reopened and re-locked once the calendar is fixed — that is safe here
 * precisely because no hire received a first email to be duplicated.
 */
export async function fireNewHireChecklistLockWebhook(args: {
  period: HrChecklistPeriod | null;
  periodStart: string;
  periodEnd: string | null;
  rows: HrNewHireChecklistRow[];
  lockedBy: string | null;
  orientation: OrientationResolution;
}): Promise<NewHireChecklistLockWebhookResult> {
  if (args.rows.length === 0) {
    return {
      fired: false,
      count: 0,
      status: null,
      error: null,
      skipped: [],
      orientation: summarizeOrientation(args.orientation),
    };
  }

  if (!args.orientation.ok) {
    const why =
      args.orientation.reason === "no_weekday_left"
        ? `every weekday of the week is a holiday (${args.orientation.skipped
            .map((s) => s.name)
            .join(", ")}) — pick the orientation date by hand`
        : args.orientation.reason === "calendar_unavailable"
          ? "the holiday calendar could not be read, so the orientation date is unknown"
          : "the week's period start is not a valid date";
    console.error(`[new-hire-checklist] orientation unresolved, NOTHING sent: ${why}`);
    return {
      fired: false,
      count: 0,
      status: null,
      error: `No orientation email sent — ${why}.`,
      skipped: [],
      orientation: summarizeOrientation(args.orientation),
    };
  }

  const orientation = summarizeOrientation(args.orientation);
  if (orientation.shifted) {
    console.warn(
      `[new-hire-checklist] orientation for ${args.periodStart} announced as ` +
        `${orientation.weekday} ${orientation.date} — ${orientation.reason}`,
    );
  }

  const { payload, skipped } = buildLockWebhookPayload({
    ...args,
    orientation: args.orientation,
  });
  const count = (payload.rows as unknown[]).length;
  const badEmail = skipped.filter((s) => s.reason === "invalid_email");
  const offDept = skipped.filter((s) => s.reason === "not_lead_gen");
  if (badEmail.length > 0) {
    console.warn(
      `[new-hire-checklist] ${badEmail.length} hire(s) skipped for unusable email:`,
      badEmail.map((s) => `${s.name ?? s.id} <${s.personal_email ?? ""}>`).join("; "),
    );
  }
  if (offDept.length > 0) {
    console.warn(
      `[new-hire-checklist] ${offDept.length} hire(s) withheld from the orientation email (not Lead Gen):`,
      offDept.map((s) => `${s.name ?? s.id} [${s.department ?? "no department"}]`).join("; "),
    );
  }
  if (count === 0) {
    return { fired: false, count: 0, status: null, error: null, skipped, orientation };
  }

  let url: string;
  try {
    url = await resolveUrl();
  } catch (e) {
    return {
      fired: false,
      count,
      status: null,
      error: e instanceof Error ? e.message : String(e),
      skipped,
      orientation,
    };
  }

  const res = await postJson(url, payload);
  return { fired: true, count, status: res.status, error: res.error, skipped, orientation };
}
