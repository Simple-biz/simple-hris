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

function toCleanHire(row: HrNewHireChecklistRow): CleanHire {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    first_name: firstNameOf(row.name),
    personal_email: row.personal_email,
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

export type NewHireChecklistLockWebhookResult = {
  /** True once we attempted the POST (false = no hires / no URL). */
  fired: boolean;
  /** Hires included in the payload. */
  count: number;
  /** HTTP status of the POST (null if it threw / wasn't sent). */
  status: number | null;
  /** Failure message, if any (for surfacing / logging). */
  error: string | null;
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
 * Fires ONE webhook POST for the locked week, carrying every hire as a
 * self-contained row in `rows[]` (see the file header for the shape + n8n
 * Split Out flow). Never throws — the DB write is the source of truth, so the
 * webhook is a best-effort side-effect and a failure never blocks the lock.
 */
export async function fireNewHireChecklistLockWebhook(args: {
  period: HrChecklistPeriod | null;
  periodStart: string;
  periodEnd: string | null;
  rows: HrNewHireChecklistRow[];
  lockedBy: string | null;
}): Promise<NewHireChecklistLockWebhookResult> {
  const count = args.rows.length;
  if (count === 0) return { fired: false, count: 0, status: null, error: null };

  let url: string;
  try {
    url = await resolveUrl();
  } catch (e) {
    return { fired: false, count, status: null, error: e instanceof Error ? e.message : String(e) };
  }

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

  // One self-contained item per hire: the hire's own fields + the shared
  // email/week fields, so `body.rows` splits cleanly into ready-to-send items.
  const rows = args.rows.map((row, i) => ({
    ...toCleanHire(row),
    ...emailFields,
    hire_index: i + 1,
  }));

  const payload = {
    event: "new_hire_checklist.locked",
    period_start: args.periodStart,
    period_end: args.period?.period_end ?? args.periodEnd ?? null,
    status: args.period?.status ?? "locked",
    locked_at: args.period?.locked_at ?? null,
    locked_by: args.period?.locked_by ?? args.lockedBy ?? null,
    row_count: count,
    ...emailFields,
    rows,
  };

  const res = await postJson(url, payload);
  return { fired: true, count, status: res.status, error: res.error };
}
