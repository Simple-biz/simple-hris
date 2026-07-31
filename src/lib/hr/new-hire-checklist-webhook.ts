import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
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
 * n8n flow: Webhook → Split Out (Fields To Split Out = `body.rows`) → Gmail.
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
// The checklist week is Sun-anchored, so hires start (and orient) the MONDAY of
// that week. If the real start/orientation day ever moves, change ORIENT_OFFSET
// — start_date, orientation_date, and orientation_weekday all key off it.
const ORIENT_OFFSET_DAYS = 1;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shift a YYYY-MM-DD date by `n` days (UTC math, so no server-TZ drift). */
function addDaysIso(iso: string, n: number): string | null {
  if (!ISO_DATE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** Full weekday name for a YYYY-MM-DD date (e.g. "Monday"). */
function weekdayName(iso: string | null): string | null {
  if (!iso || !ISO_DATE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()] ?? null;
}

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

/** A hire left out of the payload because its email cell holds no usable address. */
export type LockWebhookSkippedRow = {
  id: string;
  name: string | null;
  personal_email: string | null;
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
};

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
}): { payload: Record<string, unknown>; skipped: LockWebhookSkippedRow[] } {
  // Hires start / orient the Monday of the Sun-anchored checklist week.
  const orientation = addDaysIso(args.periodStart, ORIENT_OFFSET_DAYS);

  // Welcome-email fields — same for every hire this week. Baked into EACH row
  // (below) so a Split Out yields self-contained per-hire items, and also kept
  // at the top level for reference.
  const emailFields = {
    start_date: usDate(orientation),               // {{ start_date }}        MM/DD/YYYY
    orientation_date: usDate(orientation),          // {{ orientation_date }}  MM/DD/YYYY
    orientation_weekday: weekdayName(orientation),  // {{ orientation_weekday }}
    zoom_link: ORIENTATION_ZOOM_LINK,               // {{ zoom_link }}
  };

  // One self-contained item per sendable hire: the hire's own fields + the
  // shared email/week fields, so `body.rows` splits into ready-to-send items.
  const skipped: LockWebhookSkippedRow[] = [];
  const rows: Record<string, unknown>[] = [];
  args.rows.forEach((row, i) => {
    const { email } = sanitizePersonalEmail(row.personal_email);
    if (!email) {
      skipped.push({ id: row.id, name: row.name, personal_email: row.personal_email });
      return;
    }
    rows.push({
      ...toCleanHire(row, email),
      ...emailFields,
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
 */
export async function fireNewHireChecklistLockWebhook(args: {
  period: HrChecklistPeriod | null;
  periodStart: string;
  periodEnd: string | null;
  rows: HrNewHireChecklistRow[];
  lockedBy: string | null;
}): Promise<NewHireChecklistLockWebhookResult> {
  if (args.rows.length === 0) {
    return { fired: false, count: 0, status: null, error: null, skipped: [] };
  }

  const { payload, skipped } = buildLockWebhookPayload(args);
  const count = (payload.rows as unknown[]).length;
  if (skipped.length > 0) {
    console.warn(
      `[new-hire-checklist] ${skipped.length} hire(s) skipped for unusable email:`,
      skipped.map((s) => `${s.name ?? s.id} <${s.personal_email ?? ""}>`).join("; "),
    );
  }
  if (count === 0) {
    return { fired: false, count: 0, status: null, error: null, skipped };
  }

  let url: string;
  try {
    url = await resolveUrl();
  } catch (e) {
    return { fired: false, count, status: null, error: e instanceof Error ? e.message : String(e), skipped };
  }

  const res = await postJson(url, payload);
  return { fired: true, count, status: res.status, error: res.error, skipped };
}
