import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { recordNotifyFailure } from './notify-failure-audit';
import type { GiftSubmissionChannel } from '@/lib/gift-tracker/gift-live';

/**
 * "Somebody filled in their gift delivery details" → the Gift Tracker's people.
 *
 * Kane, 2026-09-22, on who should hear it: *"HR Dashboard people with HR - Gift
 * Tracker Access"*. So the recipients are the holders of the `hr / gift_tracker`
 * grant — NOT a role list. Every other HR fan-out in this codebase resolves
 * `recipientsForRoles(['hr_coordinator','admin'])`, and copying that here would
 * have notified HR coordinators who cannot open the tab while missing the
 * delegated people who can.
 *
 * ONE TYPE FOR ALL THREE CHANNELS. The public link, the employee dashboard card
 * and a staff entry are the same piece of news to the same people; which surface
 * it came from is a detail on the row, not a different notification. The
 * "Recently filled / updated" sub-tab is where the channel is read.
 *
 * BEST-EFFORT, BUT NEVER SILENT. A notify failure must not fail somebody's
 * address submission — that rule is not being changed. What is not acceptable is
 * the failure being INVISIBLE: `gift_shipping.submitted` is CHECK-constrained by
 * `employee_notifications_type_check`, so until
 * `references/sql/alter/2026-09-22_add_gift_shipping_notification_type.sql` is
 * applied every insert here is rejected and looks exactly like "nobody
 * submitted". `kpi.scored` shipped that way for three days and `pab.*` for
 * seventeen. So every failure goes through `recordNotifyFailure`, which writes
 * `notification.insert_failed` into `audit_log`.
 */

/** Anything above `hidden` can open the tab, so anything above `hidden` hears it. */
const AUDIBLE_ACCESS = new Set(['view', 'edit']);

function norm(v: unknown): string | null {
  const t = String(v ?? '').trim().toLowerCase();
  return t || null;
}

/**
 * Who holds `hr / gift_tracker`, plus admins.
 *
 * Admins are included because `requireFeatureAccess` short-circuits for them
 * (`authorize-feature.ts:56`) — they can open the tab without a grant row, so
 * leaving them out would mean the people with the broadest access are the only
 * ones never told.
 *
 * Grants are keyed on whatever work address the person was granted under, which
 * may be an alias. Each is bridged back to the master row's primary work email
 * so one human cannot be notified twice under two addresses, and so a grant on
 * an alternate address still lands.
 */
export interface GrantRow {
  work_email?: string | null;
  access?: string | null;
}

export interface AliasRow {
  work_email?: string | null;
  personal_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
}

/**
 * The fold, kept pure so the rules above are testable without a database: a
 * `hidden` grant is silent, an aliased grant lands on the master row's primary
 * address, and one human appears exactly once however many addresses reach them.
 */
export function foldRecipients(args: {
  grants: readonly GrantRow[];
  admins: readonly { work_email?: string | null }[];
  employees: readonly AliasRow[];
}): string[] {
  const primaryByAlias = new Map<string, string>();
  for (const e of args.employees) {
    const primary = norm(e.work_email);
    if (!primary) continue;
    for (const raw of [e.work_email, e.alternate_work_email, e.alternate_work_email_2, e.personal_email]) {
      const key = norm(raw);
      if (key && !primaryByAlias.has(key)) primaryByAlias.set(key, primary);
    }
  }

  const out = new Set<string>();
  const add = (raw: unknown) => {
    const key = norm(raw);
    if (!key) return;
    out.add(primaryByAlias.get(key) ?? key);
  };

  for (const g of args.grants) {
    if (!AUDIBLE_ACCESS.has(String(g.access ?? '').trim().toLowerCase())) continue;
    add(g.work_email);
  }
  for (const a of args.admins) add(a.work_email);

  return Array.from(out);
}

export async function resolveGiftTrackerRecipients(): Promise<string[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];

  const [{ data: grants }, { data: admins }, { employees }] = await Promise.all([
    supabase
      .from('employee_feature_permissions')
      .select('work_email, access')
      .eq('feature', 'gift_tracker')
      .eq('view_key', 'hr')
      .is('revoked_at', null),
    supabase.from('employee_roles').select('work_email').eq('role', 'admin').is('revoked_at', null),
    getEmployeesForAuthorizedServerRoute(),
  ]);

  return foldRecipients({
    grants: (grants ?? []) as GrantRow[],
    admins: (admins ?? []) as Array<{ work_email?: string | null }>,
    employees,
  });
}

export interface GiftShippingNotifyArgs {
  /** Which surface wrote it. */
  channel: GiftSubmissionChannel;
  /** The submitter's display name, when the roster knows one. */
  employeeName: string | null;
  /** The submitter's work email, for the message and the details blob. */
  workEmail: string | null;
  /** Milestone indexes written by this save. `readonly` because nothing here
   *  mutates it — the caller keeps ownership of its own array. */
  milestones: readonly number[];
  /** True when this save also named somebody else to receive the parcel. */
  hasAlternateRecipient: boolean;
  /** Whether the row already existed — drives "updated" vs "filled in". */
  isUpdate: boolean;
}

/** Human copy for each surface. The channel is stated because "who is actually
 *  using the link" is the question the tab was built to answer. */
const CHANNEL_LABEL: Record<GiftSubmissionChannel, string> = {
  external_link: 'the public gift link',
  employee_self: 'their Employee dashboard',
  staff: 'the Gift Tracker',
};

export function buildGiftShippingMessage(args: GiftShippingNotifyArgs): string {
  const who = args.employeeName?.trim() || args.workEmail || 'Someone';
  const verb = args.isUpdate ? 'updated their' : 'filled in their';
  const count = args.milestones.length;
  const gifts = count > 1 ? `${count} gifts` : 'gift';
  const spouse = args.hasAlternateRecipient ? ', naming somebody else to receive it' : '';
  return `${who} ${verb} ${gifts} delivery details through ${CHANNEL_LABEL[args.channel]}${spouse}. See Gift Tracker → Recently filled / updated.`;
}

/**
 * Drop the notification into every Gift Tracker holder's bell.
 *
 * NEVER awaited on the request path by its callers (`void` it) and never throws:
 * a bell is not worth failing somebody's address submission over.
 *
 * NOTE THE AUDIT RULE THIS INHERITS: the details blob carries the milestone
 * numbers, the channel and a BOOLEAN for the alternate recipient — never the
 * address, never the recipient's name, never their number. The named person does
 * not work here and never agreed to appear in our trail, and a notification is
 * read by more people than the shipping list is. Same rule both write routes
 * already follow for `audit_log`.
 */
export async function notifyGiftShippingSubmitted(args: GiftShippingNotifyArgs): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) return;

    const recipients = await resolveGiftTrackerRecipients();
    if (recipients.length === 0) return;

    const { error } = await supabase.from('employee_notifications').insert(
      recipients.map((to) => ({
        recipient_email: to,
        type: 'gift_shipping.submitted',
        tone: 'neutral',
        title: args.isUpdate ? 'Gift address updated' : 'New gift address',
        message: buildGiftShippingMessage(args),
        details: {
          channel: args.channel,
          work_email: args.workEmail,
          milestones: args.milestones,
          has_alternate_recipient: args.hasAlternateRecipient,
          is_update: args.isUpdate,
        },
      })),
    );

    if (error) {
      await recordNotifyFailure({
        notificationType: 'gift_shipping.submitted',
        origin: 'gift-shipping-submitted',
        error,
        details: {
          channel: args.channel,
          work_email: args.workEmail,
          milestones: args.milestones,
          recipients: recipients.length,
        },
      });
    }
  } catch (error) {
    await recordNotifyFailure({
      notificationType: 'gift_shipping.submitted',
      origin: 'gift-shipping-submitted',
      error,
      details: { channel: args.channel, work_email: args.workEmail },
    }).catch(() => undefined);
  }
}
