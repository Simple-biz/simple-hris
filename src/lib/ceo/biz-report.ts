/**
 * Shared report spec for Penny AI downloadable reports.
 *
 * The chat assistant produces a report by emitting a fenced ```biz-report block
 * containing JSON in this shape (see the chat route's system prompt). The same
 * shape is consumed in two places, so it lives here as the single contract:
 *   - the client renderer (`ceo-chat-message.tsx`) turns it into a download card
 *   - the PDF endpoint (`/api/ceo/reports/pdf`) renders it to a PDF
 *
 * Because the JSON is model-authored AND flows through a user-callable endpoint,
 * {@link parseBizReport} is intentionally defensive: it coerces, caps every
 * length/count, drops anything malformed, and returns `null` rather than trust
 * the input. Keep this module free of server-only imports so the client bundle
 * can use the types + parser.
 */

export const BIZ_REPORT_FENCE = 'biz-report';

export type ReportAlign = 'left' | 'right' | 'center';

export interface ReportTextSection {
  type: 'text';
  heading?: string;
  body: string;
}

export interface ReportMetricsSection {
  type: 'metrics';
  heading?: string;
  items: { label: string; value: string }[];
}

export interface ReportTableSection {
  type: 'table';
  heading?: string;
  columns: string[];
  rows: string[][];
  aligns?: ReportAlign[];
}

export interface ReportPerson {
  name: string;
  /** Work or personal email — the server resolves the employee's uploaded
   *  profile photo from this (the model never passes a photo URL itself). */
  email?: string;
  /** A short line under the name, e.g. "22.5 OT hrs · ₱18,400.00". */
  detail?: string;
}

export interface ReportRosterSection {
  type: 'roster';
  heading?: string;
  people: ReportPerson[];
}

export type ReportSection =
  | ReportTextSection
  | ReportMetricsSection
  | ReportTableSection
  | ReportRosterSection;

export interface BizReport {
  title: string;
  /** Usually the period the report covers, e.g. "Apr 12 – Apr 18, 2026". */
  subtitle?: string;
  sections: ReportSection[];
}

// ── caps (defensive; the input is model/user supplied) ───────────────────────
const MAX_TITLE = 160;
const MAX_SUBTITLE = 220;
const MAX_HEADING = 160;
const MAX_SECTIONS = 24;
const MAX_BODY = 6000;
const MAX_METRICS = 40;
const MAX_COLUMNS = 12;
const MAX_ROWS = 300;
const MAX_CELL = 240;
const MAX_LABEL = 120;

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return '';
}

function clip(v: unknown, max: number): string {
  const s = asString(v).replace(/\s+$/g, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function asAlign(v: unknown): ReportAlign {
  return v === 'right' || v === 'center' ? v : 'left';
}

function normalizeSection(raw: unknown): ReportSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const heading = s.heading != null ? clip(s.heading, MAX_HEADING) : undefined;

  if (s.type === 'text') {
    const body = clip(s.body, MAX_BODY);
    if (!body) return null;
    return { type: 'text', heading, body };
  }

  if (s.type === 'metrics') {
    const itemsRaw = Array.isArray(s.items) ? s.items.slice(0, MAX_METRICS) : [];
    const items = itemsRaw
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return { label: clip(o.label, MAX_LABEL), value: clip(o.value, MAX_LABEL) };
      })
      .filter((it) => it.label || it.value);
    if (items.length === 0) return null;
    return { type: 'metrics', heading, items };
  }

  if (s.type === 'roster') {
    const peopleRaw = Array.isArray(s.people) ? s.people.slice(0, MAX_ROWS) : [];
    const people = peopleRaw
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        const name = clip(o.name, MAX_LABEL);
        const emailRaw = asString(o.email).trim().toLowerCase();
        const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : undefined;
        const detail = o.detail != null ? clip(o.detail, MAX_CELL) : undefined;
        return { name, email, detail };
      })
      .filter((p) => p.name || p.email);
    if (people.length === 0) return null;
    return { type: 'roster', heading, people };
  }

  if (s.type === 'table') {
    const columns = (Array.isArray(s.columns) ? s.columns : [])
      .slice(0, MAX_COLUMNS)
      .map((c) => clip(c, MAX_CELL));
    if (columns.length === 0) return null;
    const rows = (Array.isArray(s.rows) ? s.rows : [])
      .slice(0, MAX_ROWS)
      .map((r) =>
        (Array.isArray(r) ? r : [r])
          .slice(0, columns.length)
          .map((cell) => clip(cell, MAX_CELL)),
      );
    const aligns = (Array.isArray(s.aligns) ? s.aligns : [])
      .slice(0, columns.length)
      .map(asAlign);
    return { type: 'table', heading, columns, rows, aligns: aligns.length ? aligns : undefined };
  }

  return null;
}

/**
 * Validate + normalize an unknown value into a {@link BizReport}, or `null` if
 * it isn't usable. Accepts either a parsed object or a raw JSON string.
 */
export function parseBizReport(input: unknown): BizReport | null {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const title = clip(o.title, MAX_TITLE) || 'Report';
  const subtitle = o.subtitle != null ? clip(o.subtitle, MAX_SUBTITLE) || undefined : undefined;

  const sections = (Array.isArray(o.sections) ? o.sections : [])
    .slice(0, MAX_SECTIONS)
    .map(normalizeSection)
    .filter((s): s is ReportSection => s != null);

  if (sections.length === 0) return null;
  return { title, subtitle, sections };
}

/** A filesystem-safe download filename for a report (without extension). */
export function bizReportSlug(report: BizReport): string {
  const base = report.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'penny-ai-report';
}
