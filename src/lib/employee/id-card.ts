import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { parseDateOnlyLocal } from '@/lib/date-only';

/**
 * View model for the Employee ID card (Employee portal -> Profile -> ID).
 *
 * Pure and DOM-free so the resolution rules can be unit-tested without React.
 * The card renders nothing it resolves itself: every value here comes off the
 * `global_master_list` row the Profile screen has already fetched.
 *
 * See docs/features/employee-id-card.md for the invariants this file carries.
 */

export type IdCardInput = {
  /** `global_master_list.name`. */
  name?: string | null;
  /** `global_master_list."Work Email"`. */
  workEmail?: string | null;
  /** The signed-in address — the last-resort identity when the master row is thin. */
  fallbackEmail?: string | null;
  /** RAW department cell. May be an `hsl:<key>` storage key; never render it directly. */
  department?: string | null;
  /** Address columns added 2026-05-02. `fullAddress` wins when present. */
  fullAddress?: string | null;
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  /** `global_master_list.start_date`. */
  startDate?: string | null;
  /** `global_master_list.employee_id` — `YYMM-NNNN`, derived from `start_date`. */
  employeeId?: string | null;
  /** Supabase Storage upload. */
  photoUrl?: string | null;
  /** Google SSO picture. Only valid for the signed-in viewer's own portal. */
  googlePhotoUrl?: string | null;
};

export type IdCard = {
  name: string;
  workEmail: string | null;
  /** Already passed through `formatDeptLabel` — safe to render. */
  department: string | null;
  address: string | null;
  startDate: string | null;
  /** `null` hides the footer serial entirely. */
  employeeId: string | null;
  initials: string;
  /** Ordered photo candidates: upload first, then Google SSO. Empty ⇒ initials. */
  photoSources: string[];
};

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s.length ? s : null;
};

/**
 * "mariaes@simple.biz" -> "Mariaes". Mirrors the shell's own fallback in
 * `EmployeeApp.tsx`, so a person with no master `name` reads the same on the
 * card as they do in the sidebar.
 */
export function nameFromEmail(email: string | null | undefined): string | null {
  const local = clean(email)?.split('@')[0];
  if (!local) return null;
  const spaced = local.replace(/[._]+/g, ' ').trim();
  if (!spaced) return null;
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Date shown on the card.
 *
 * `start_date` is a **DATE** column — a calendar day with no time and no zone.
 * `new Date('2024-05-06')` parses that as UTC midnight, so `toLocaleDateString`
 * renders **the day before** for any viewer west of UTC. On an identity document
 * that is not a rounding error, so this goes through `parseDateOnlyLocal`, which
 * is the project's standing rule for DATE columns.
 *
 * `EmployeeProfile.tsx`'s own `formatStartDate` still parses the naive way and is
 * off by one for those viewers — a pre-existing defect that also reaches pay dates
 * and resignation effective dates, so it is flagged rather than changed from here.
 * The presentation shape is deliberately identical, so once that is fixed the two
 * surfaces agree byte for byte.
 *
 * An unparseable value is passed through verbatim rather than blanked — a badly
 * typed sheet date is still evidence, and hiding it hides the ID's own origin.
 */
export function formatIdCardDate(raw: string | null | undefined): string | null {
  const s = clean(raw);
  if (!s) return null;
  const d = parseDateOnlyLocal(s);
  if (!d) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * `full_address` wins; otherwise the flat columns are joined in postal order.
 *
 * The Profile screen composes exactly this (`fullAddressDisplay`), and the card
 * must not invent a second shape — a person comparing the two would read the
 * difference as one of them being wrong.
 */
export function composeIdCardAddress(input: IdCardInput): string | null {
  const full = clean(input.fullAddress);
  if (full) return full;
  const parts = [input.street, input.city, input.province, input.postalCode]
    .map(clean)
    .filter((p): p is string => p !== null);
  return parts.length ? parts.join(', ') : null;
}

/** Up to two letters, from the display name, else the email. */
export function idCardInitials(name: string | null, email: string | null): string {
  const source = clean(name) ?? clean(email)?.split('@')[0] ?? '';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * Photo candidates in the order `EmployeeAvatar` uses: a manual upload is a user
 * choice and beats the automatic Google SSO picture. The card walks this list
 * with `onError` so a dead URL degrades to initials instead of a broken frame.
 */
export function idCardPhotoSources(input: IdCardInput): string[] {
  return [clean(input.photoUrl), clean(input.googlePhotoUrl)].filter(
    (u): u is string => u !== null,
  );
}

export function buildIdCard(input: IdCardInput): IdCard {
  const workEmail = clean(input.workEmail) ?? clean(input.fallbackEmail);
  const name = clean(input.name) ?? nameFromEmail(workEmail) ?? '—';
  // formatDeptLabel is unconditional — it is a no-op on non-HSL labels, and an
  // `hsl:*` storage key must never reach a human (hsl-subdepartments.md §12).
  const rawDept = clean(input.department);
  const department = rawDept ? clean(formatDeptLabel(rawDept)) : null;

  return {
    name,
    workEmail,
    department,
    address: composeIdCardAddress(input),
    startDate: formatIdCardDate(input.startDate),
    employeeId: clean(input.employeeId),
    initials: idCardInitials(clean(input.name), workEmail),
    photoSources: idCardPhotoSources(input),
  };
}
