import { createSupabaseServiceRoleClient } from './server';
import { masterListDisplayName } from '@/lib/name/display-name';
import { toTitleCaseName } from '@/lib/text/sanitize-name';

/**
 * Canonical master-list "Name". A value already in surname-first form — it
 * carries a comma, e.g. `Reroma, Jan Kane "Kane"` composed by the People
 * profile parts editor — is kept verbatim (only Unicode-folded / re-cased), so
 * an explicit go-by nickname survives instead of being re-derived. A plain
 * legal "First Middle Last [Suffix]" (no comma) is converted to the
 * surname-first quoted form. `masterListDisplayName` expects a LEGAL name and
 * would mangle an already-surname-first string (it takes the trailing quoted
 * go-by as the surname), so the comma short-circuit is load-bearing.
 */
function canonicalMasterName(raw: string): string {
  const s = toTitleCaseName(raw);
  if (!s || s.includes('@') || s.includes(',')) return s;
  return masterListDisplayName(s);
}

/**
 * Single-row identity editor for `global_master_list`, powering the
 * People -> View Modal profile editor. Kept out of global-master-list-db.ts so
 * that file stays focused on the bulk CSV/Sheet sync engine.
 *
 * Writes are targeted by the row's primary key `id` (unambiguous even when the
 * Work Email itself is being changed). The "Name" column is forced through
 * `masterListDisplayName` so an in-app rename lands in the same surname-first
 * canonical form the promote path and the Sheet round-trip expect (a raw name
 * would desync the payroll name-token matcher). A collision precheck guards the
 * partial unique index `global_master_list_work_email_dept_uniq` (one active row
 * per lower(Work Email)+lower(Department)) before touching identity keys.
 */

function getMasterTableName(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || 'global_master_list';
}

/** Editable master-list fields. Any key left `undefined` is not written; a
 *  `null` / '' value clears the column. Keys are snake_case; the DB write maps
 *  them to the real (mostly quoted mixed-case) column names. */
export type MasterProfilePatch = {
  name?: string | null;
  department?: string | null;
  work_email?: string | null;
  personal_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
  start_date?: string | null;
  phone_number?: string | null;
  location?: string | null;
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  full_address?: string | null;
};

/** The fresh master fields returned after an update, for the client to merge
 *  into its in-memory roster row (rate/hours/banking are left untouched). */
export type MasterProfileFields = {
  id: string | null;
  employee_id: string | null;
  name: string | null;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  alternate_work_emails: string[];
  /** The two alternate-email SLOTS as stored. `alternate_work_emails` above is
   *  the de-duplicated display list, so it cannot answer "which slot changed" —
   *  these keep the per-slot values an audit diff needs. */
  alternate_work_email: string | null;
  alternate_work_email_2: string | null;
  start_date: string | null;
  phone_number: string | null;
  location: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  full_address: string | null;
};

export type UpdateMasterProfileResult =
  | {
      ok: true;
      master: MasterProfileFields;
      /** The row as it was BEFORE this write, so callers can audit real
       *  before→after values. The master list keeps no version history, so an
       *  unaudited rename is otherwise unrecoverable. */
      previous: MasterProfileFields;
    }
  | { ok: false; error: string; code: 'not_found' | 'collision' | 'db' | 'config' | 'invalid' };

const SELECT_COLS =
  'id,employee_id,"Name","Department","Personal Email","Work Email",' +
  '"Alternate Work Email","Alternate Work Email 2","Start Date",' +
  '"Phone Number","Location",street,city,province,postal_code,full_address';

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function normKey(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/** Escape SQL LIKE/ILIKE metacharacters so a value with '_' or '%' (both legal
 *  in email local-parts) is matched literally, not as a wildcard. */
function likeEscape(v: string): string {
  return v.replace(/([\\%_])/g, '\\$1');
}

/** Map a raw DB row to the flat fields the client merges. */
function mapMaster(row: Record<string, unknown>): MasterProfileFields {
  const work = str(row['Work Email']);
  const alt1 = str(row['Alternate Work Email']);
  const alt2 = str(row['Alternate Work Email 2']);
  // Dedup case-insensitively (keep first occurrence) and drop the primary — so a
  // "Kev@" / "kev@" pair doesn't render as two distinct alternates.
  const alternates: string[] = [];
  const seenAlt = new Set<string>();
  for (const a of [alt1, alt2]) {
    if (!a) continue;
    const key = normKey(a);
    if (key === normKey(work) || seenAlt.has(key)) continue;
    seenAlt.add(key);
    alternates.push(a);
  }
  return {
    id: row.id != null ? String(row.id) : null,
    employee_id: str(row.employee_id),
    name: str(row['Name']),
    department: str(row['Department']),
    work_email: work,
    personal_email: str(row['Personal Email']),
    alternate_work_emails: alternates,
    alternate_work_email: alt1,
    alternate_work_email_2: alt2,
    start_date: str(row['Start Date']),
    phone_number: str(row['Phone Number']),
    location: str(row['Location']),
    street: str(row.street),
    city: str(row.city),
    province: str(row.province),
    postal_code: str(row.postal_code),
    full_address: str(row.full_address),
  };
}

export async function updateMasterListProfile(
  id: string,
  patch: MasterProfilePatch,
): Promise<UpdateMasterProfileResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, error: 'Supabase not configured', code: 'config' };
  const table = getMasterTableName();

  // 1. Load the current identity so we can (a) confirm the row exists & is
  //    active and (b) tell whether the edit actually changes the unique key.
  //    Select every editable column (not just the unique-key ones) so the
  //    caller can audit what each field changed FROM.
  const { data: current, error: curErr } = await supabase
    .from(table)
    .select(`${SELECT_COLS},off_boarded_at`)
    .eq('id', id)
    .maybeSingle();
  if (curErr) return { ok: false, error: curErr.message, code: 'db' };
  if (!current || (current as { off_boarded_at?: string | null }).off_boarded_at) {
    return { ok: false, error: 'Employee record not found (or off-boarded).', code: 'not_found' };
  }
  const previous = mapMaster(current as unknown as Record<string, unknown>);

  const curWork = str((current as Record<string, unknown>)['Work Email']);
  const curDept = str((current as Record<string, unknown>)['Department']);
  const nextWork = patch.work_email !== undefined ? str(patch.work_email) : curWork;
  const nextDept = patch.department !== undefined ? str(patch.department) : curDept;

  // Refuse to blank the identity keys (Name / Work Email / Department). They anchor
  // the roster, the (Work Email, Department) unique key, and every email-keyed join;
  // clearing one silently corrupts identity, so reject rather than write an empty.
  if (patch.name !== undefined && !String(patch.name ?? '').trim()) {
    return { ok: false, code: 'invalid', error: 'Name cannot be blank.' };
  }
  if (patch.work_email !== undefined && !nextWork) {
    return { ok: false, code: 'invalid', error: 'Work email cannot be blank.' };
  }
  if (patch.department !== undefined && !nextDept) {
    return { ok: false, code: 'invalid', error: 'Department cannot be blank.' };
  }

  // 2. Collision precheck for the partial unique index (only fires when the
  //    resulting Work Email is non-empty AND the (work, dept) key actually
  //    changed). Catches a duplicate before the DB rejects it, so we can return
  //    a friendly message instead of a raw 23505.
  const keyChanged = normKey(nextWork) !== normKey(curWork) || normKey(nextDept) !== normKey(curDept);
  // The partial unique index only covers non-empty (Work Email, Department); when
  // either is blank the DB's 23505 catch below is the backstop.
  if (keyChanged && nextWork && nextDept) {
    const { data: clash, error: clashErr } = await supabase
      .from(table)
      .select('id')
      .ilike('"Work Email"', likeEscape(nextWork))
      .ilike('"Department"', likeEscape(nextDept))
      .neq('id', id)
      .is('off_boarded_at', null)
      .limit(1);
    if (clashErr) return { ok: false, error: clashErr.message, code: 'db' };
    if (clash && clash.length > 0) {
      return {
        ok: false,
        code: 'collision',
        error: `Another active employee already uses ${nextWork}${
          nextDept ? ` in ${nextDept}` : ''
        }. Change the work email or department first.`,
      };
    }
  }

  // 3. Build the update payload — only keys present in the patch, mapped to the
  //    real column names. "Name" is canonicalized to surname-first form.
  const payload: Record<string, string | null> = {};
  const set = (col: string, v: string | null | undefined) => {
    if (v !== undefined) payload[col] = v == null ? null : String(v).trim() || null;
  };
  if (patch.name !== undefined) {
    payload['Name'] = patch.name == null || !patch.name.trim() ? null : canonicalMasterName(patch.name);
  }
  set('Department', patch.department);
  set('Work Email', patch.work_email);
  set('Personal Email', patch.personal_email);
  set('Alternate Work Email', patch.alternate_work_email);
  set('Alternate Work Email 2', patch.alternate_work_email_2);
  set('Start Date', patch.start_date);
  set('Phone Number', patch.phone_number);
  set('Location', patch.location);
  set('street', patch.street);
  set('city', patch.city);
  set('province', patch.province);
  set('postal_code', patch.postal_code);
  set('full_address', patch.full_address);

  if (Object.keys(payload).length === 0) {
    // Nothing to change — return the current row so the caller is a no-op.
    const { data: row, error } = await supabase.from(table).select(SELECT_COLS).eq('id', id).maybeSingle();
    if (error || !row) return { ok: false, error: error?.message ?? 'not found', code: 'db' };
    return { ok: true, master: mapMaster(row as unknown as Record<string, unknown>), previous };
  }

  const { data: updated, error: updErr } = await supabase
    .from(table)
    .update(payload)
    .eq('id', id)
    .is('off_boarded_at', null)
    .select(SELECT_COLS)
    .maybeSingle();

  if (updErr) {
    // 23505 = the unique index the precheck couldn't win a race against.
    const isUnique = /duplicate key|unique constraint|23505/i.test(updErr.message);
    return {
      ok: false,
      code: isUnique ? 'collision' : 'db',
      error: isUnique
        ? 'That work email + department is already taken by another active employee.'
        : updErr.message,
    };
  }
  if (!updated) return { ok: false, error: 'Employee record not found (or off-boarded).', code: 'not_found' };

  return { ok: true, master: mapMaster(updated as unknown as Record<string, unknown>), previous };
}
