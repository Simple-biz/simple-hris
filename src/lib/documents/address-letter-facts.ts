// Proof of Residential Address letter — the facts, resolved server-side.
//
// Everything the letter states comes from here; the client supplies nothing but
// the work email it picked and, separately, the blanks the rep typed (validated by
// applyLetterFills in ./address-letter.ts). Identity facts reuse the COE's own
// composers so the two documents can never name a person differently:
// `coeWorkerName` (legal name, nickname dropped, malformed rows refused),
// `formatCoeStartDate`, and `formatDeptLabel` (a raw `hsl:*` key never prints).
//
// ONBOARDING FORMS ARE MATCHED BY THE MASTER ROW'S PERSONAL EMAIL ONLY — never by
// a work email. Work addresses have been re-issued to new hires
// ([[recycled-work-email-same-dept-promote]]), so a form filed under a work email
// can belong to its previous holder. Measured 2026-10-06 over the 458 active people
// whose address would come from a form: 457 match by personal email; the one that
// matched only by work email carried a DIFFERENT personal email, i.e. was exactly
// that wrong-person case.

import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { escapeLikePattern } from '@/lib/db/like-escape';
import { normEmail } from '@/lib/email/norm-email';
import { coeWorkerName, formatCoeStartDate } from './coe-facts';
import {
  letterBlanks,
  pickLetterAddress,
  type AddressLetterFactsResult,
  type SubmissionAddressRow,
} from './address-letter';

/** The submission columns that hold the hire's OWN personal email. */
const SUBMISSION_PERSONAL_COLUMNS = ['email', 'invite_personal_email'] as const;

const SUBMISSION_SELECT =
  'id,created_at,country,address_street,address_city,address_province,address_state,address_postal_code';

interface RawSubmission {
  id: number | string;
  created_at: string | null;
  country: string | null;
  address_street: string | null;
  address_city: string | null;
  address_province: string | null;
  address_state: string | null;
  address_postal_code: string | null;
}

/** Every onboarding submission filed under `personalEmail`. A targeted read (one
 *  `.ilike` per column, escaped — never `.or()`), so it never meets the 1000-row cap. */
async function fetchSubmissionsFor(
  personalEmail: string,
): Promise<{ rows: SubmissionAddressRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase service-role client unavailable' };

  const results = await Promise.all(
    SUBMISSION_PERSONAL_COLUMNS.map((column) =>
      supabase
        .from('hr_onboarding_submissions')
        .select(SUBMISSION_SELECT)
        .ilike(column, escapeLikePattern(personalEmail))
        .limit(50),
    ),
  );

  const seen = new Set<string>();
  const rows: SubmissionAddressRow[] = [];
  for (const { data, error } of results) {
    // A failed read is an error, never "no form on file" — that would hand the
    // rep a blank to type over an address we actually hold.
    if (error) return { rows: [], error: `Could not read the onboarding forms: ${error.message}` };
    for (const raw of (data ?? []) as RawSubmission[]) {
      const key = String(raw.id);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        createdAt: raw.created_at,
        street: raw.address_street,
        city: raw.address_city,
        province: raw.address_province,
        state: raw.address_state,
        postalCode: raw.address_postal_code,
        country: raw.country,
      });
    }
  }
  return { rows, error: null };
}

/**
 * Resolve everything the Proof of Residential Address letter prints for one
 * worker, by work email. Blank address fields are NOT a refusal — they come back
 * in `blanks` for the rep to type. Identity facts the letter cannot do without
 * (the name, the start date, the team) refuse instead of printing a dash.
 */
export async function resolveAddressLetterFacts(email: string): Promise<AddressLetterFactsResult> {
  const norm = normEmail(email) ?? email.trim().toLowerCase();
  if (!norm) return { facts: null, blocked: null, error: 'Missing employee email' };

  const { employee: master, error: masterErr } = await getEmployeeMasterRecord(norm);
  if (masterErr) return { facts: null, blocked: null, error: masterErr };
  if (!master) {
    return {
      facts: null,
      blocked: {
        code: 'no_master',
        message: 'This person has no live record on the master list, so the letter cannot state who they are.',
      },
      error: null,
    };
  }

  const workerName = coeWorkerName(master.name);
  if (!workerName) {
    return {
      facts: null,
      blocked: {
        code: 'bad_name',
        message:
          'Their name is not recorded in a usable form on the master list, and the letter has to state it exactly. Ask HR to correct the roster name first.',
      },
      error: null,
    };
  }
  const startDateRaw = master.start_date?.trim() || '';
  const startDateLabel = startDateRaw ? formatCoeStartDate(startDateRaw) : null;
  if (!startDateRaw || !startDateLabel) {
    return {
      facts: null,
      blocked: {
        code: 'no_start_date',
        message:
          'Their engagement start date is not on file, and the letter states "contracted with Simple since". Ask HR to add it first.',
      },
      error: null,
    };
  }
  // Unconditional — a no-op on non-HSL labels ([[dept-label-display-sweep]]).
  const team = formatDeptLabel(master.department);
  if (!team) {
    return {
      facts: null,
      blocked: {
        code: 'no_department',
        message: 'Their team is not recorded on the master list, and the letter names it. Ask HR to set it first.',
      },
      error: null,
    };
  }

  const personal = normEmail(master.personal_email);
  const subs = personal ? await fetchSubmissionsFor(personal) : { rows: [], error: null };
  if (subs.error) return { facts: null, blocked: null, error: subs.error };

  const picked = pickLetterAddress(
    {
      fullAddress: master.full_address,
      street: master.street,
      city: master.city,
      province: master.province,
      postalCode: master.postal_code,
    },
    subs.rows,
  );

  return {
    facts: {
      workerName,
      workEmail: normEmail(master.work_email) ?? norm,
      employeeId: master.employee_id?.trim() || null,
      team,
      startDateLabel,
      startDateRaw,
      address: picked.address,
      addressSource: picked.addressSource,
      addressSourceDetail: picked.addressSourceDetail,
      countrySource: picked.countrySource,
      blanks: letterBlanks(picked.address),
    },
    blocked: null,
    error: null,
  };
}
