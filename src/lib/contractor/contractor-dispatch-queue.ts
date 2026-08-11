import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExcludedRow, ExclusionReason, ProcessorId, QueueRow } from '@/components/payroll-clerk/mock-queue';
import { parseCyclePeriodFromFile, processorIdFromBankPreferred } from '@/components/payroll-clerk/mock-queue';
import { buildPayoutDetails, isKnownProcessor, type IdsRow } from '@/lib/payroll/urgent-payout-details';
import { isInvoiceInPeriod } from '@/lib/contractor/invoice-period';
import { normalizeCurrency } from '@/lib/contractor-currency';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';

/**
 * Contractors as Payment Dispatch payees.
 *
 * Payment Dispatch's own queue is RATES-driven — `buildQueueFromRates` iterates
 * `employee_hourly_rates` and joins Hubstaff hours — so a contractor who bills by
 * invoice can never appear through it (41 of the 44 contractor-role holders have
 * no rate row and no hours). This module is the second payee source, merged into
 * the queue by `useDispatchQueue` the way the Urgent queue merges its own rows.
 *
 * Deliberate design points:
 *
 * - ONE ROW PER APPROVED INVOICE, id = `invoice:<uuid>`. Aggregating per person
 *   would make it impossible to settle one of Claire's seven approved invoices
 *   without hiding the other six, because the existing already-paid filter is
 *   keyed per (recipient_email, cycle).
 * - SCOPED TO THE PAY PERIOD. Only invoices whose billing date falls inside the
 *   cycle's Sun–Sat window reach this queue at all — see the window filter in
 *   {@link loadContractorDispatchRows}. Approval carries no pay-week, so without
 *   it every still-unsettled approved invoice ever filed showed up as payable in
 *   the current week (Claire's back catalogue, ~US$8.2k dated May–June, sat in
 *   the USD tab). Those invoices do not belong to this run and are not shown here
 *   in any form; the Payroll Wizard's Contractors step remains the place where
 *   every invoice, in-period or not, is listed and reviewable.
 * - APPROVED = PAYABLE, and only while unsettled (`dispatch_id` NULL). A pending
 *   invoice is money Accounting has not authorized, so it is read but surfaced
 *   only as an unpayable `pending_approval` row in Excluded — the clerk sees the
 *   week's filed invoices without being able to pay unauthorized money. An
 *   invoice whose claim leaked (`dispatch_claimed_at` set, `dispatch_id` still
 *   NULL) is likewise shown only as an unpayable `claim_stuck` row.
 * - BANK INFO COMES FROM `employee_ids` FIRST. All 18 invoices carry
 *   `payment_method = NULL` and `contractor_profiles` is nearly empty, while
 *   `employee_ids` holds real details for 7 of the 8 invoicing contractors — so
 *   employee_ids → contractor_profiles → the invoice's own payment_method JSON.
 * - The wizard's per-department "Pay this week" toggle is NOT applied here, which
 *   mirrors employee rows exactly: that toggle filters inside the Payroll Wizard
 *   and has never gated the dispatch queue. The department is still resolved so
 *   it shows on the row and in the Excluded tab's department filter.
 * - ACH maps to the `wires` tab. ACH is deliberately invoice-only and absent from
 *   the shared ProcessorId union, so a US-rail contractor lands with the manual
 *   wires payments rather than nowhere at all.
 */

export interface ContractorDispatchQueueResult {
  active: QueueRow[];
  excluded: ExcludedRow[];
  /**
   * HARD FAILURE: the contractor half could not be loaded (migration missing, cycle
   * unresolved, read failed), so approved invoices are genuinely NOT in the queue.
   * Without it that state is indistinguishable from "no approved invoices" — real
   * money silently absent from a queue that looks perfectly healthy.
   */
  notice?: string | null;
  /**
   * ADVISORY on an otherwise SUCCESSFUL load — e.g. some invoices are stuck
   * mid-dispatch. Kept separate from {@link notice} because the two need opposite
   * copy: saying "invoices could not be loaded" over a successful load that DID
   * list payable rows would tell the clerk the exact opposite of the truth.
   */
  advisory?: string | null;
  /**
   * Lowercased emails holding an un-revoked `contractor` role. Used to badge
   * hourly-payroll rows (e.g. thea@, issa@ — contractors who DO log Hubstaff
   * hours and already flow through the normal queue).
   */
  contractorEmails: string[];
}

/** `contractor_invoices` columns this module reads. */
const INVOICE_COLUMNS =
  'id, contractor_email, invoice_number, invoice_date, due_date, total, currency, status, payment_method, from_name, from_entity_name, created_at, dispatch_id, dispatch_claimed_at';

/**
 * employee_ids columns: the payout pre-fill set plus the three the dispatch
 * precedence needs on top of it (`bank_preferred` is step 1 of the chain and is
 * NOT in the Urgent queue's IDS_COLUMNS).
 */
const IDS_COLUMNS =
  'work_email, personal_email, name, bank_preferred, preferred_processor, preferred_bank_slot, bank_name, account_holder_name, account_number, routing_number, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email, wise_tag, phone_number, swift_code, full_address';

export type IdsRowPlus = IdsRow & {
  personal_email: string | null;
  name: string | null;
  bank_preferred: string | null;
};

export type InvoiceRow = {
  id: string;
  contractor_email: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | string | null;
  currency: string | null;
  status: string | null;
  payment_method: { region?: string; processor?: string; fields?: Record<string, string> } | null;
  from_name: string | null;
  from_entity_name: string | null;
  created_at: string | null;
  /** Set once a Mark Paid has claimed this invoice; see `strandedIds`. */
  dispatch_claimed_at?: string | null;
};

export type ProfileRow = Record<string, string | null> & { contractor_email: string };

/** Everything {@link buildContractorRows} needs, so the row shaping stays pure + testable. */
export interface ContractorRowInputs {
  invoices: InvoiceRow[];
  idsByEmail: Map<string, IdsRowPlus>;
  profileByEmail: Map<string, ProfileRow>;
  deptByEmail: Map<string, string | null>;
  nameByEmail: Map<string, string | null>;
  /** USD→PHP. 0 = unknown; the converted side is then left null rather than guessed. */
  fxRate: number;
  /**
   * Invoice ids whose claim leaked (dispatch_claimed_at set, dispatch_id null).
   * Rendered unpayable-but-visible rather than dropped.
   */
  strandedIds?: Set<string>;
  /**
   * Invoice ids still awaiting Accounting approval (`status = 'pending'`).
   * Rendered unpayable-but-visible in Excluded so the week's filed invoices
   * appear in Payment Dispatch before approval.
   */
  pendingApprovalIds?: Set<string>;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
const round2 = (n: number): number => Math.round(n * 100) / 100;

function pickFirst(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

const PAGE = 1000;

/**
 * Paginated select — the contractor tables are small today, but employee_ids and
 * active_employees are not, and PostgREST caps a response at 1000 rows.
 *
 * Takes a range-applying callback rather than a query-builder wrapper: chaining
 * `.eq()/.is()/.or()` onto a stored builder type sends TS into an
 * excessively-deep instantiation, so each call site builds its own query.
 */
async function paginate<T>(
  label: string,
  run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await withRetry(label, () => run(from, from + PAGE - 1));
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * Retry a Supabase read twice on a THROWN error (`TypeError: fetch failed` is a
 * real, observed flake against this project). A returned `error` is a genuine
 * query problem and is passed straight back to the caller, not retried.
 *
 * This matters most for the cycle lookup below: it fails CLOSED (no contractor
 * rows), so a single network blip would silently empty the contractor half of the
 * queue while employee rows rendered normally.
 */
async function withRetry<T>(label: string, run: () => PromiseLike<T>): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error(`${label}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/**
 * The invoice's `payment_method.fields` keys are NOT column names — the builder
 * uses short form keys ('swift', 'address', 'accountName'). Translate to the
 * payout-detail shape so a rail configured only on the invoice still pre-fills
 * Mark Paid. Inverse of `prefillFieldsFromProfile`.
 */
function detailsFromInvoiceFields(
  processor: string | null | undefined,
  fields: Record<string, string> | undefined,
): Partial<QueueRow['details']> {
  if (!fields) return {};
  const g = (k: string) => pickFirst(fields[k]);
  switch (processor) {
    case 'hurupay':
      return { hurupay_email: g('email') };
    case 'higlobe':
      return { higlobe_email: g('email'), higlobe_account_name: g('accountName') };
    case 'wires':
      return {
        account_holder_name: g('accountHolder'),
        bank_name: g('bankName'),
        account_number: g('accountNumber'),
        swift_code: g('swift'),
        full_address: g('address'),
      };
    case 'ach':
      // No ACH tab exists; surface the US details in the wires fields so the
      // clerk can still see who/where to pay.
      return {
        account_holder_name: g('accountHolder'),
        bank_name: g('bankName'),
        account_number: g('accountNumber'),
        swift_code: g('routingNumber'),
      };
    default:
      return {};
  }
}

/** Same precedence as `buildQueueFromRates`, extended past employee_ids for contractors. */
function resolveContractorProcessor(
  ids: IdsRowPlus | undefined,
  profile: ProfileRow | undefined,
  invoiceProcessor: string | null | undefined,
): ProcessorId | null {
  const bankPreferred = norm(ids?.bank_preferred);
  const idsProcessor = norm(ids?.preferred_processor);
  const profileProcessor = norm(profile?.preferred_processor);
  const invoiceRail = norm(invoiceProcessor) === 'ach' ? 'wires' : norm(invoiceProcessor);
  return (
    (isKnownProcessor(bankPreferred) ? bankPreferred : null) ??
    (isKnownProcessor(idsProcessor) ? idsProcessor : null) ??
    // employee_ids.bank_preferred also holds free-text wire codes ("x1161").
    processorIdFromBankPreferred(ids?.bank_preferred) ??
    (isKnownProcessor(profileProcessor) ? profileProcessor : null) ??
    (isKnownProcessor(invoiceRail) ? invoiceRail : null)
  );
}

/**
 * Builds the contractor half of the dispatch queue for `sourceFile`.
 *
 * `fxRate` is USD→PHP, passed through from `/api/payroll-current-pay` so the
 * contractor rows use the exact rate the rest of the screen shows. When it is
 * unavailable (0), the invoice's own currency is still populated and the
 * converted side is left null rather than guessed.
 *
 * Returns empty rows (but still the role set, for badging) when `sourceFile` is
 * not the current cycle: approval carries no pay-week, so showing today's
 * approved invoices while the clerk reviews a closed week would misrepresent
 * them as owed in that week. Within the current cycle, invoices are further
 * narrowed to those billed inside its Sun–Sat window — see the window filter
 * below and the module header.
 */
export async function loadContractorDispatchRows(
  supabase: SupabaseClient,
  opts: { sourceFile: string | null; fxRate: number },
): Promise<ContractorDispatchQueueResult> {
  const contractorEmails = await loadContractorRoleEmails(supabase);

  const { data: currentUpload } = await withRetry('hubstaff_uploads', () =>
    supabase.from('hubstaff_uploads').select('source_file').eq('is_current', true).limit(1).maybeSingle(),
  );
  const currentSourceFile = (currentUpload as { source_file?: string } | null)?.source_file ?? null;
  const viewing = opts.sourceFile?.trim() || null;
  if (!currentSourceFile) {
    // Could not resolve the live cycle — fail CLOSED (no rows) but SAY SO, since
    // approved invoices do exist and are simply not being shown.
    return {
      active: [],
      excluded: [],
      contractorEmails,
      notice: 'Could not resolve the current pay cycle, so contractor invoices are not shown.',
    };
  }
  // Viewing a closed week: approval carries no pay-week, so showing today's approved
  // invoices there would misrepresent them as owed in that week. Silent by design.
  if (viewing && viewing !== currentSourceFile) {
    return { active: [], excluded: [], contractorEmails };
  }

  // Before add_contractor_dispatch_link.sql has been applied, dispatch_id /
  // dispatch_claimed_at do not exist and this query 42703s. Degrade to "no
  // contractor rows" rather than failing the whole call, so the contractor-role
  // badges on hourly rows still work and the clerk sees a normal queue.
  let invoices: InvoiceRow[];
  try {
    invoices = (
      await paginate<InvoiceRow>('contractor_invoices', (from, to) =>
        supabase
          .from('contractor_invoices')
          .select(INVOICE_COLUMNS)
          .in('status', ['pending', 'approved'])
          .is('dispatch_id', null)
          .range(from, to),
      )
    ).filter((i) => norm(i.contractor_email));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[contractor-dispatch-queue] invoice read failed — run references/sql/alter/add_contractor_dispatch_link.sql', msg);
    return {
      active: [],
      excluded: [],
      contractorEmails,
      notice: /dispatch_id|dispatch_claimed_at/.test(msg)
        ? 'Contractor payments are not enabled yet — run references/sql/alter/add_contractor_dispatch_link.sql (node scripts/apply-contractor-dispatch-migration.mjs).'
        : `Contractor invoices could not be read: ${msg}`,
    };
  }

  if (invoices.length === 0) return { active: [], excluded: [], contractorEmails };

  // A claim with no dispatch_id means a Mark Paid stamped the claim and then failed
  // to write the money row AND failed to release it. Such an invoice is NOT payable
  // (paying it could double-pay if a row was in fact written), but it must not be
  // INVISIBLE either — that is how an owed invoice quietly disappears. Surfaced as
  // an unpayable Excluded row instead.
  const isStranded = (i: InvoiceRow) => !!i.dispatch_claimed_at;

  // ── Pay-period window ─────────────────────────────────────────────────────
  // Only invoices billed inside this cycle's Sun–Sat window belong to this
  // payroll run; everything else is dropped outright (not moved to Excluded —
  // an invoice from another period has no business on this screen). A filename
  // with no parseable range yields nulls, and `isInvoiceInPeriod` then admits
  // everything: a window we could not derive must never become a filter.
  //
  // The ONE exception is a stranded claim: that invoice records a Mark Paid
  // that half-failed, so it is an integrity alarm rather than a payable row,
  // and losing it because of its date is exactly how a double-payment gets
  // discovered by accident later.
  const cycleWindow = parseCyclePeriodFromFile(currentSourceFile);
  invoices = invoices.filter((i) => isInvoiceInPeriod(i, cycleWindow.start, cycleWindow.end) || isStranded(i));
  if (invoices.length === 0) return { active: [], excluded: [], contractorEmails };

  const strandedIds = new Set(invoices.filter(isStranded).map((i) => i.id));

  // Awaiting Accounting approval — visible in Excluded, never payable.
  const pendingApprovalIds = new Set(
    invoices.filter((i) => i.status === 'pending' && !isStranded(i)).map((i) => i.id),
  );

  const emails = [...new Set(invoices.map((i) => norm(i.contractor_email)))];

  // employee_ids — matched on work_email OR personal_email, mirroring the
  // dispatch queue's own index (work email wins; personal only fills a gap).
  const emailList = emails.join(',');
  const idsRows = await paginate<IdsRowPlus>('employee_ids', (from, to) =>
    supabase
      .from('employee_ids')
      .select(IDS_COLUMNS)
      .or(`work_email.in.(${emailList}),personal_email.in.(${emailList})`)
      .range(from, to),
  );
  const idsByEmail = new Map<string, IdsRowPlus>();
  for (const r of idsRows) {
    const we = norm(r.work_email);
    const pe = norm(r.personal_email);
    if (we) idsByEmail.set(we, r);
    if (pe && !idsByEmail.has(pe)) idsByEmail.set(pe, r);
  }

  const profiles = await paginate<ProfileRow>('contractor_profiles', (from, to) =>
    supabase.from('contractor_profiles').select('*').in('contractor_email', emails).range(from, to),
  );
  const profileByEmail = new Map(profiles.map((p) => [norm(p.contractor_email), p]));

  // Department for display + the Excluded tab's department filter. Contractors
  // have no rates row, so the master list is the only source.
  const master = await paginate<Record<string, unknown>>('active_employees', (from, to) =>
    supabase
      .from('active_employees')
      .select('"Name", "Work Email", "Personal Email", "Department"')
      .range(from, to),
  );
  const deptByEmail = new Map<string, string | null>();
  const nameByEmail = new Map<string, string | null>();
  for (const r of master) {
    const dept = (r['Department'] as string | null) ?? null;
    const name = (r['Name'] as string | null) ?? null;
    for (const key of [norm(r['Work Email'] as string | null), norm(r['Personal Email'] as string | null)]) {
      if (!key) continue;
      if (!deptByEmail.has(key)) deptByEmail.set(key, dept);
      if (!nameByEmail.has(key)) nameByEmail.set(key, name);
    }
  }

  const { active, excluded } = buildContractorRows({
    invoices,
    idsByEmail,
    profileByEmail,
    deptByEmail,
    nameByEmail,
    fxRate: opts.fxRate,
    strandedIds,
    pendingApprovalIds,
  });
  const advisories = [
    strandedIds.size
      ? `${strandedIds.size} approved invoice(s) are stuck mid-dispatch — claimed but no payment recorded. They are listed in Excluded under "Stuck mid-dispatch". Every OTHER approved invoice is listed here as normal.`
      : null,
    pendingApprovalIds.size
      ? `${pendingApprovalIds.size} contractor invoice(s) are awaiting Accounting approval — listed in Excluded under "Awaiting approval". They become payable once approved in the Payroll Wizard's Contractors step.`
      : null,
  ].filter(Boolean);
  return {
    active,
    excluded,
    contractorEmails,
    advisory: advisories.length ? advisories.join(' ') : null,
  };
}

/**
 * Pure row shaping: invoices + the joined lookups → dispatch rows. Split out from
 * the fetching so it can be exercised against real data without the migration
 * being applied (scripts/smoke-contractor-dispatch-queue.mts).
 */
export function buildContractorRows(
  input: ContractorRowInputs,
): { active: QueueRow[]; excluded: ExcludedRow[] } {
  const { invoices, idsByEmail, profileByEmail, deptByEmail, nameByEmail } = input;
  const stranded = input.strandedIds ?? new Set<string>();
  const pendingApproval = input.pendingApprovalIds ?? new Set<string>();
  const fx = input.fxRate > 0 ? input.fxRate : 0;
  const active: QueueRow[] = [];
  const excluded: ExcludedRow[] = [];

  for (const inv of invoices) {
    const email = norm(inv.contractor_email);
    const ids = idsByEmail.get(email);
    const profile = profileByEmail.get(email);
    const rail = inv.payment_method?.processor ?? null;
    const processor = resolveContractorProcessor(ids, profile, rail);

    const name =
      pickFirst(
        ids?.name,
        nameByEmail.get(email),
        profile?.display_name,
        inv.from_name,
        inv.from_entity_name,
      ) ??
      email.split('@')[0]?.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ??
      email;

    const currency = normalizeCurrency(inv.currency);
    const total = Number(inv.total ?? 0);
    // Only USD and PHP are priced here. COP is a real contractor currency
    // (settable in Admin → Roles and in the Contractor Profile) and the PHP arm
    // below would price 4,000,000 COP as ₱4,000,000 (~US$68,965) on a PHP rail, so
    // a COP invoice is surfaced as unpayable instead of silently mispriced. Plumb
    // usdToCop (already computed in useDispatchQueue) if COP contractors appear.
    const unsupportedCurrency = currency !== 'USD' && currency !== 'PHP';
    const amountUSD = currency === 'USD' ? round2(total) : fx > 0 ? round2(total / fx) : null;
    const amountPHP = currency === 'USD' ? (fx > 0 ? round2(total * fx) : null) : round2(total);

    const deptRaw = deptByEmail.get(email) ?? null;
    const departmentKey = normalizeDeptToKey(deptRaw);
    const departmentName =
      (departmentKey ? (DEPARTMENTS.find((d) => d.key === departmentKey)?.name ?? null) : null) ??
      (deptRaw?.trim() || null);

    // employee_ids first, then the contractor profile, then the invoice JSON.
    // Gap-fill in strict priority order. `buildPayoutDetails` returns `undefined`
    // for blank fields, so this must be an explicit fill — spreading would let a
    // later source's `undefined` erase an earlier source's real value.
    const details: QueueRow['details'] = { ...buildPayoutDetails(ids, inv.contractor_email?.trim() || email) };
    const fallbacks: Array<Partial<QueueRow['details']>> = [
      profile ? buildPayoutDetails(profile as unknown as IdsRow, email) : {},
      detailsFromInvoiceFields(rail, inv.payment_method?.fields),
    ];
    for (const src of fallbacks) {
      for (const [k, v] of Object.entries(src)) {
        const key = k as keyof QueueRow['details'];
        if (!details[key] && v) details[key] = String(v);
      }
    }
    details.email = inv.contractor_email?.trim() || email;

    const bankPreferredRaw = pickFirst(ids?.bank_preferred, ids?.preferred_processor, profile?.preferred_processor, rail) ?? null;
    const invoiceNumber = inv.invoice_number?.trim() || null;

    if (!processor || unsupportedCurrency || stranded.has(inv.id) || pendingApproval.has(inv.id)) {
      // Same gate employees get: no resolvable rail → visible in Excluded, not
      // payable. (`accounting@simple.biz` has no employee_ids row at all.)
      // An unsupported currency lands here too rather than being mispriced.
      // A stuck claim outranks everything; a pending invoice shows "Awaiting
      // approval" PLUS "No bank preferred" when its rail is also unresolved, so
      // approving it doesn't surprise-swap the row's reason.
      const reasons: ExclusionReason[] = stranded.has(inv.id)
        ? ['claim_stuck']
        : [
            ...(pendingApproval.has(inv.id) ? (['pending_approval'] as const) : []),
            ...(!processor || unsupportedCurrency ? (['no_bank'] as const) : []),
          ];
      excluded.push({
        id: `invoice:${inv.id}`,
        name,
        email: inv.contractor_email?.trim() || email,
        totalHours: null,
        amountUSD: unsupportedCurrency ? null : amountUSD,
        amountPHP: unsupportedCurrency ? null : amountPHP,
        amountCOP: null,
        bankPreferredRaw,
        reasons,
        departmentKey,
        departmentName,
        payeeKind: 'contractor',
        contractorInvoiceId: inv.id,
        invoiceNumber,
        payable: null,
      });
      continue;
    }

    active.push({
      id: `invoice:${inv.id}`,
      processor,
      name,
      email: inv.contractor_email?.trim() || email,
      amountUSD,
      amountPHP,
      amountCOP: null,
      // USD invoices route to the USD tab exactly like USD-paid employees.
      payCurrency: currency === 'USD' ? 'USD' : 'PHP',
      // An invoice is a single billed total — there is no regular/OT split or
      // bonus structure to break out, and no Payroll Wizard carrier prices it, so
      // `valuesSource` is deliberately absent (the wizard-values overlay skips
      // contractor rows entirely, or it could overwrite an invoice with an hourly
      // final for a person who holds both identities).
      initialPayUSD: null,
      initialPayPHP: null,
      pabBonusPHP: 0,
      techBonusPHP: 0,
      bonusTotalPHP: 0,
      orphanagePayPHP: 0,
      mesaDeductionPHP: 0,
      mesaDisbursementPHP: 0,
      totalHours: null,
      otHours: null,
      bankPreferredRaw,
      departmentKey,
      departmentName,
      payeeKind: 'contractor',
      contractorInvoiceId: inv.id,
      invoiceNumber,
      details,
    });
  }

  return { active, excluded };
}

/** Every un-revoked `contractor` role holder, lowercased. Best-effort. */
export async function loadContractorRoleEmails(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('employee_roles')
    .select('work_email')
    .eq('role', 'contractor')
    .is('revoked_at', null);
  if (error) return [];
  return [...new Set(((data ?? []) as { work_email: string | null }[]).map((r) => norm(r.work_email)).filter(Boolean))];
}
