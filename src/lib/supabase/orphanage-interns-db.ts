import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import { maskAccountLast4 } from '@/lib/payroll/mask-account';
import { isInternEmail } from '@/lib/interns/intern-email';
import { normEmail } from '@/lib/email/norm-email';
import { internRateForDay } from '@/lib/interns/intern-week-pay';
import { composeFullName } from '@/lib/hr/work-email';
import type {
  InternStatus,
  OrphanageInternListItem,
  OrphanageInternRateRow,
  OrphanageInternRow,
} from '@/lib/interns/intern-types';

/**
 * Orphanage intern profiles + their DATED rates.
 *
 * Interns are NOT on global_master_list (Sheet-synced full replace — a hand row
 * dies at the next sync) and NOT in employee_hourly_rates (the rates CSV still
 * writes pay tables). Identity is the @pathway.ph email; every personal-data and
 * bank change happens on the Orphanage dashboard ONLY (Kane 2026-09-02), so the
 * only writers here are the orphanage-gated routes under /api/orphanage-interns.
 *
 * Migration: references/sql/migrate/2026-09-02_orphanage_interns.sql.
 */

const INTERN_COLS =
  'id, email, first_name, middle_name, last_name, name_extension, full_name, personal_email, phone, orphanage_id, status, started_on, ended_on, weekly_cap_hours, daily_cap_hours, pab_bonus_php, orphanage_share_pct, bank_name, bank_account_name, bank_account_number, swift_code, note, created_by, created_at, updated_at';
const RATE_COLS = 'id, intern_id, rate_php, effective_from, set_by, created_at';

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapIntern(r: Record<string, unknown>): OrphanageInternRow {
  return {
    id: String(r.id),
    email: String(r.email ?? ''),
    first_name: String(r.first_name ?? ''),
    middle_name: (r.middle_name as string | null) ?? null,
    last_name: String(r.last_name ?? ''),
    name_extension: (r.name_extension as string | null) ?? null,
    full_name: String(r.full_name ?? ''),
    personal_email: (r.personal_email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    orphanage_id: (r.orphanage_id as string | null) ?? null,
    status: ((r.status as string) ?? 'active') as InternStatus,
    started_on: (r.started_on as string | null) ?? null,
    ended_on: (r.ended_on as string | null) ?? null,
    weekly_cap_hours: num(r.weekly_cap_hours),
    daily_cap_hours: num(r.daily_cap_hours),
    pab_bonus_php: num(r.pab_bonus_php),
    orphanage_share_pct: num(r.orphanage_share_pct),
    bank_name: String(r.bank_name ?? ''),
    bank_account_name: String(r.bank_account_name ?? ''),
    bank_account_number: String(r.bank_account_number ?? ''),
    swift_code: String(r.swift_code ?? ''),
    note: (r.note as string | null) ?? null,
    created_by: (r.created_by as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

function mapRate(r: Record<string, unknown>): OrphanageInternRateRow {
  return {
    id: String(r.id),
    intern_id: String(r.intern_id),
    rate_php: num(r.rate_php),
    effective_from: String(r.effective_from ?? ''),
    set_by: (r.set_by as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
  };
}

/** Every rate row, grouped by intern. Paged — a growing history must never truncate a rate away. */
export async function listInternRates(internIds?: string[]): Promise<{ byIntern: Map<string, OrphanageInternRateRow[]>; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { byIntern: new Map(), error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) => {
    let q = supabase.from('orphanage_intern_rates').select(RATE_COLS).order('intern_id').order('effective_from', { ascending: false }).order('id').range(from, to);
    if (internIds && internIds.length > 0) q = q.in('intern_id', internIds);
    return q;
  });
  if (error) return { byIntern: new Map(), error };
  const byIntern = new Map<string, OrphanageInternRateRow[]>();
  for (const r of rows.map(mapRate)) {
    const list = byIntern.get(r.intern_id) ?? [];
    list.push(r);
    byIntern.set(r.intern_id, list);
  }
  return { byIntern, error: null };
}

/** Every intern (active by default), with the current rate and the account masked to last 4. */
export async function listInterns(opts: { includeEnded?: boolean } = {}): Promise<{ items: OrphanageInternListItem[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { items: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) => {
    let q = supabase.from('orphanage_interns').select(INTERN_COLS).order('full_name').order('id').range(from, to);
    if (!opts.includeEnded) q = q.eq('status', 'active');
    return q;
  });
  if (error) return { items: [], error };
  const interns = rows.map(mapIntern);
  const { byIntern, error: rErr } = await listInternRates(interns.map((i) => i.id));
  if (rErr) return { items: [], error: rErr };
  const today = new Date().toISOString().slice(0, 10);
  return { items: interns.map((i) => toListItem(i, byIntern.get(i.id) ?? [], today)), error: null };
}

export function toListItem(i: OrphanageInternRow, rates: OrphanageInternRateRow[], todayIso: string): OrphanageInternListItem {
  const rateRows = rates.map((r) => ({ ratePhp: r.rate_php, effectiveFrom: r.effective_from }));
  const current = internRateForDay(rateRows, todayIso);
  const currentRow = current == null ? null : rates.filter((r) => r.rate_php === current && r.effective_from <= todayIso).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;
  const { bank_account_number, ...rest } = i;
  return {
    ...rest,
    bank_account_last4: maskAccountLast4(bank_account_number),
    current_rate_php: current,
    current_rate_effective_from: currentRow?.effective_from ?? null,
  };
}

/** One intern with the FULL bank details and the whole rate history — the edit read. */
export async function getInternById(id: string): Promise<{ intern: OrphanageInternRow | null; rates: OrphanageInternRateRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { intern: null, rates: [], error: 'Supabase not configured' };
  const { data, error } = await supabase.from('orphanage_interns').select(INTERN_COLS).eq('id', id).maybeSingle();
  if (error) return { intern: null, rates: [], error: error.message };
  if (!data) return { intern: null, rates: [], error: null };
  const { byIntern, error: rErr } = await listInternRates([id]);
  if (rErr) return { intern: null, rates: [], error: rErr };
  return { intern: mapIntern(data as Record<string, unknown>), rates: byIntern.get(id) ?? [], error: null };
}

/** Interns by email (normalized), for the wizard's row → profile join. Paged. */
export async function listInternsByEmail(): Promise<{ byEmail: Map<string, OrphanageInternRow>; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { byEmail: new Map(), error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_interns').select(INTERN_COLS).order('id').range(from, to),
  );
  if (error) return { byEmail: new Map(), error };
  const byEmail = new Map<string, OrphanageInternRow>();
  for (const r of rows.map(mapIntern)) {
    const k = normEmail(r.email);
    if (k) byEmail.set(k, r);
  }
  return { byEmail, error: null };
}

export interface InternProfileInput {
  email: string;
  /** Name parts — first + last required; full_name is COMPOSED, never sent. */
  first_name: string;
  middle_name?: string | null;
  last_name: string;
  name_extension?: string | null;
  personal_email?: string | null;
  phone?: string | null;
  orphanage_id?: string | null;
  status?: InternStatus;
  started_on?: string | null;
  ended_on?: string | null;
  weekly_cap_hours?: number;
  daily_cap_hours?: number;
  pab_bonus_php?: number;
  orphanage_share_pct?: number;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  swift_code?: string | null;
  note?: string | null;
}

/** Shared validation for create + update. Returns the reason, or null when valid. */
export function validateInternProfile(input: Partial<InternProfileInput>, forCreate: boolean): string | null {
  if (forCreate || input.email !== undefined) {
    const e = normEmail(input.email ?? '');
    if (!e || !isInternEmail(e)) return 'email must be an @pathway.ph address';
  }
  if (forCreate || input.first_name !== undefined) {
    if (!(input.first_name ?? '').trim()) return 'first_name is required';
  }
  if (forCreate || input.last_name !== undefined) {
    if (!(input.last_name ?? '').trim()) return 'last_name is required';
  }
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'ended') return "status must be 'active' or 'ended'";
  for (const k of ['weekly_cap_hours', 'daily_cap_hours'] as const) {
    if (input[k] !== undefined && !(Number(input[k]) > 0)) return `${k} must be positive`;
  }
  if (input.pab_bonus_php !== undefined && !(Number(input.pab_bonus_php) >= 0)) return 'pab_bonus_php must be zero or more';
  if (input.orphanage_share_pct !== undefined) {
    const p = Number(input.orphanage_share_pct);
    if (!(p >= 0 && p <= 100)) return 'orphanage_share_pct must be between 0 and 100';
  }
  for (const k of ['started_on', 'ended_on'] as const) {
    const v = input[k];
    if (v != null && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${k} must be YYYY-MM-DD`;
  }
  return null;
}

function toDbPatch(input: Partial<InternProfileInput>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (input.email !== undefined) p.email = normEmail(input.email);
  if (input.first_name !== undefined) p.first_name = input.first_name.trim();
  if (input.middle_name !== undefined) p.middle_name = input.middle_name?.trim() || null;
  if (input.last_name !== undefined) p.last_name = input.last_name.trim();
  if (input.name_extension !== undefined) p.name_extension = input.name_extension?.trim() || null;
  if (input.personal_email !== undefined) p.personal_email = input.personal_email?.trim() || null;
  if (input.phone !== undefined) p.phone = input.phone?.trim() || null;
  if (input.orphanage_id !== undefined) p.orphanage_id = input.orphanage_id || null;
  if (input.status !== undefined) p.status = input.status;
  if (input.started_on !== undefined) p.started_on = input.started_on || null;
  if (input.ended_on !== undefined) p.ended_on = input.ended_on || null;
  if (input.weekly_cap_hours !== undefined) p.weekly_cap_hours = Number(input.weekly_cap_hours);
  if (input.daily_cap_hours !== undefined) p.daily_cap_hours = Number(input.daily_cap_hours);
  if (input.pab_bonus_php !== undefined) p.pab_bonus_php = Number(input.pab_bonus_php);
  if (input.orphanage_share_pct !== undefined) p.orphanage_share_pct = Number(input.orphanage_share_pct);
  if (input.bank_name !== undefined) p.bank_name = input.bank_name?.trim() ?? '';
  if (input.bank_account_name !== undefined) p.bank_account_name = input.bank_account_name?.trim() ?? '';
  if (input.bank_account_number !== undefined) p.bank_account_number = input.bank_account_number?.trim() ?? '';
  if (input.swift_code !== undefined) p.swift_code = input.swift_code?.trim() ?? '';
  if (input.note !== undefined) p.note = input.note?.trim() || null;
  return p;
}

export async function createIntern(
  input: InternProfileInput,
  createdBy: string | null,
): Promise<{ intern: OrphanageInternRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { intern: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_interns')
    .insert({
      ...toDbPatch(input),
      // Composed exactly like Simple's onboarding: first + last + extension, NEVER the middle name.
      full_name: composeFullName(input.first_name, input.last_name, input.name_extension),
      created_by: createdBy,
    })
    .select(INTERN_COLS)
    .single();
  if (error) return { intern: null, error: error.message };
  return { intern: mapIntern(data as Record<string, unknown>), error: null };
}

export async function updateIntern(
  id: string,
  input: Partial<InternProfileInput>,
): Promise<{ intern: OrphanageInternRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { intern: null, error: 'Supabase not configured' };
  const patch = toDbPatch(input);
  if (Object.keys(patch).length === 0) return { intern: null, error: 'Nothing to update' };
  const NAME_PARTS = ['first_name', 'middle_name', 'last_name', 'name_extension'] as const;
  if (NAME_PARTS.some((k) => k in patch)) {
    // A part changed → recompose full_name from the MERGED parts (the client may
    // send only the part it edited). Middle name is deliberately left out.
    const { data: cur, error: curErr } = await supabase.from('orphanage_interns').select('first_name, last_name, name_extension').eq('id', id).maybeSingle();
    if (curErr) return { intern: null, error: curErr.message };
    if (!cur) return { intern: null, error: 'Not found' };
    const c = cur as { first_name: string; last_name: string; name_extension: string | null };
    patch.full_name = composeFullName(
      (patch.first_name as string | undefined) ?? c.first_name,
      (patch.last_name as string | undefined) ?? c.last_name,
      patch.name_extension !== undefined ? (patch.name_extension as string | null) : c.name_extension,
    );
  }
  const { data, error } = await supabase.from('orphanage_interns').update(patch).eq('id', id).select(INTERN_COLS).single();
  if (error) return { intern: null, error: error.message };
  return { intern: mapIntern(data as Record<string, unknown>), error: null };
}

/** How many locked weeks reference this intern — a delete is refused while any exist. */
export async function countInternPayRows(internId: string): Promise<{ count: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { count: 0, error: 'Supabase not configured' };
  const { count, error } = await supabase.from('orphanage_intern_pay').select('id', { count: 'exact', head: true }).eq('intern_id', internId);
  if (error) return { count: 0, error: error.message };
  return { count: count ?? 0, error: null };
}

export async function deleteIntern(id: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase.from('orphanage_interns').delete().eq('id', id);
  return { error: error ? error.message : null };
}

/** Append a dated rate. Never edits history — a rate is a fact about a day. */
export async function addInternRate(
  internId: string,
  ratePhp: number,
  effectiveFrom: string,
  setBy: string | null,
): Promise<{ rate: OrphanageInternRateRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rate: null, error: 'Supabase not configured' };
  if (!(ratePhp > 0)) return { rate: null, error: 'rate_php must be positive' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { rate: null, error: 'effective_from must be YYYY-MM-DD' };
  const { data, error } = await supabase
    .from('orphanage_intern_rates')
    .insert({ intern_id: internId, rate_php: ratePhp, effective_from: effectiveFrom, set_by: setBy })
    .select(RATE_COLS)
    .single();
  if (error) return { rate: null, error: error.message };
  return { rate: mapRate(data as Record<string, unknown>), error: null };
}
