import 'server-only';

import { buildIdCard, type IdCard } from './id-card';
import {
  findRosterRowByEmail,
  getEmployeeMasterRecord,
  getEmployees,
} from '@/lib/supabase/employees';
import { getProfilePhotoUrlForEmail } from '@/lib/supabase/employee-profile-photo';

/**
 * One person's Employee ID card, resolved on the server for Admin Penny.
 *
 * It reads exactly what the Employee portal's Profile reads for the badge, in the
 * same precedence, so the card Penny opens is the card the employee sees:
 *
 *  1. the ACTIVE roster row (`getEmployees` + `findRosterRowByEmail`, the match
 *     `/api/employees?email=` makes) — preferred because its `employee_id` is
 *     numbered against every same-month starter;
 *  2. the `global_master_list` record, as the identity fallback for people off the
 *     latest upload and as the roster-address supplement (`full_address` and the
 *     flat columns). Never `employee_ids.full_address` — see employee-id-card.md;
 *  3. the photo: upload → Google SSO (`getProfilePhotoUrlForEmail`, which is what
 *     an elevated `?email=` preview shows), then the row's own photo column.
 *
 * Fails CLOSED. A failed roster or master read is `read_failed`, never a badge:
 * a degraded read would print "Not on file" over an address that IS on file, or a
 * single-row placeholder serial over the real one. Neither read ever resolves an
 * off-boarded row (work emails are recycled), so a leaver is `not_on_roster` —
 * they have no badge to draw.
 */
export type IdCardResolution =
  | { ok: true; card: IdCard }
  | { ok: false; reason: 'not_on_roster' }
  | { ok: false; reason: 'read_failed'; message: string };

export async function resolveIdCardForEmail(email: string): Promise<IdCardResolution> {
  const roster = await getEmployees();
  if (roster.error) return { ok: false, reason: 'read_failed', message: roster.error };
  const me = findRosterRowByEmail(roster.employees, email);

  const record = await getEmployeeMasterRecord(email);
  if (record.error) return { ok: false, reason: 'read_failed', message: record.error };
  const masterRecord = record.employee;

  // The Profile's own merge: the roster row wins, the master record fills the
  // address columns the active view may predate.
  const master = me
    ? {
        ...me,
        street: me.street ?? masterRecord?.street ?? null,
        city: me.city ?? masterRecord?.city ?? null,
        province: me.province ?? masterRecord?.province ?? null,
        postal_code: me.postal_code ?? masterRecord?.postal_code ?? null,
        full_address: me.full_address ?? masterRecord?.full_address ?? null,
      }
    : masterRecord;
  if (!master) return { ok: false, reason: 'not_on_roster' };

  const photoUrl =
    (await getProfilePhotoUrlForEmail(email))?.trim() || master.profile_photo_url?.trim() || null;

  return {
    ok: true,
    card: buildIdCard({
      name: master.name ?? null,
      workEmail: master.work_email ?? null,
      fallbackEmail: email,
      department: master.department ?? null,
      fullAddress: master.full_address ?? null,
      street: master.street ?? null,
      city: master.city ?? null,
      province: master.province ?? null,
      postalCode: master.postal_code ?? null,
      startDate: master.start_date ?? null,
      employeeId: master.employee_id ?? null,
      photoUrl,
      // The Google picture the Profile passes here is the SIGNED-IN viewer's own
      // session image, valid only on their own portal. An admin viewing someone
      // else has no such value — the stored Google URL already reached
      // `photoUrl` through getProfilePhotoUrlForEmail's fallback.
      googlePhotoUrl: null,
    }),
  };
}
