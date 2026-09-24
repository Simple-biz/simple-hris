/**
 * Gift Tracker → Orders: approved submissions → priced order lines → invoice.
 *
 * Governing doc: docs/features/gift-tracker-orders.md. Client-safe and pure; the
 * lock route runs the SAME `resolveOrderLines` server-side against the database's
 * own submissions and catalog, so the browser never decides a price.
 *
 * The rules a future edit is most likely to break:
 *  - An order is OPEN iff its submission is `approved` and no LIVE (unreleased)
 *    order line holds it. Approval month is irrelevant (Kane, 2026-09-23).
 *  - The gift comes from the anniversary TIER (`gift_items`), never from the
 *    vestigial `gift_name` / `gift_catalog_item_id` / `gift_price_php` columns.
 *  - A line with no price, no variant, or no size CANNOT be locked. It is never
 *    printed as ₱0 and never guessed.
 *  - Money is integer centavos end to end; pesos exist only when formatted.
 */
import { GIFT_JOINER, tierGiftItems } from './anniversary-items';
import { milestoneLabel } from '@/lib/gift-milestones';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface OrderCatalogItem {
  id: string;
  item: string;
  description: string;
  price_php: number;
  /** Apparel: the employee's size is part of what the vendor makes. Absent on
   *  rows saved before 2026-09-23 — see `isSizedItem` for the inference. */
  sized?: boolean;
}

export interface OrderTier {
  year: number;
  month_label: string;
  gift: string;
  gift_items?: string[] | null;
}

export interface OrderSubmission {
  id: string;
  personal_email: string;
  milestone_index: number;
  milestone_date: string;
  status: string;
  apparel_size: string;
  preferred_delivery_location: string;
  active_contact_number: string;
  recipient_name: string;
  recipient_relationship: string;
  recipient_contact: string;
  decided_by: string | null;
  decided_at: string | null;
}

/** `${submissionId}::${item lower-case}` — one line per gift item per submission. */
export function orderLineKey(submissionId: string, item: string): string {
  return `${submissionId}::${item.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** The shipping form's chip → the words Gift items uses for the same size. */
const SIZE_ALIASES: Record<string, string[]> = {
  XS: ['xs', 'extra small'],
  S: ['s', 'small'],
  M: ['m', 'medium'],
  L: ['l', 'large'],
  XL: ['xl', 'extra large'],
  '2XL': ['2xl', 'xxl'],
  '3XL': ['3xl', 'xxxl'],
};

/** Canonical chip ('M') for anything a person or a description calls a size, else null. */
export function canonicalSize(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  for (const [chip, words] of Object.entries(SIZE_ALIASES)) {
    if (words.includes(v)) return chip;
  }
  return null;
}

/** Display order for sizes on the invoice (XS … 3XL, then anything else). */
export function sizeRank(size: string): number {
  const order = Object.keys(SIZE_ALIASES);
  const i = order.indexOf(canonicalSize(size) ?? '');
  return i === -1 ? order.length : i;
}

/**
 * Is `name` an apparel item whose size the vendor needs?
 * Explicit `sized` on any of its rows wins. Otherwise inferred, NARROWLY: rows
 * that are all sizes AND include a size only clothing comes in (XS, XL, 2XL,
 * 3XL). "Small/Medium/Large" alone is NOT enough — the live Tote Bag rows read
 * exactly that, and a tote must not take the employee's shirt size. A
 * single-row jacket is not inferable, which is why Gift items carries the
 * explicit Sized toggle.
 */
const APPAREL_ONLY_SIZES = new Set(['XS', 'XL', '2XL', '3XL']);
export function isSizedItem(rows: OrderCatalogItem[]): boolean {
  if (rows.some((r) => r.sized === true)) return true;
  if (rows.some((r) => r.sized === false)) return false;
  const sizes = rows.map((r) => canonicalSize(r.description));
  return (
    rows.length > 1 &&
    sizes.every((s) => s !== null) &&
    sizes.some((s) => s !== null && APPAREL_ONLY_SIZES.has(s))
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type OrderLineProblem =
  | 'no_tier_gift' // the milestone's tier names no gift
  | 'off_catalog' // the tier names something Gift items does not have
  | 'needs_variant' // several rows, nothing picks one
  | 'needs_size' // apparel with no size on the submission
  | 'no_price'; // the chosen row has no price (0 or blank) in Gift items

export const ORDER_PROBLEM_LABEL: Record<OrderLineProblem, string> = {
  no_tier_gift: 'No gift set for this milestone in Anniversary Gifts',
  off_catalog: 'Gift is not in Gift items',
  needs_variant: 'Pick which one',
  needs_size: 'No shirt size on the submission',
  no_price: 'No price in Gift items',
};

export interface OrderLine {
  key: string;
  submissionId: string;
  personalEmail: string;
  milestoneIndex: number;
  milestoneDate: string;
  /** Catalog spelling when matched, else the tier's. */
  item: string;
  /** What prints in the Size column ('' when the item has none). */
  size: string;
  catalogItemId: string | null;
  unitCentavos: number | null;
  /** Rows HR can pick between when `problem === 'needs_variant'` (or to change a pick). */
  variantOptions: OrderCatalogItem[];
  problem: OrderLineProblem | null;
  submission: OrderSubmission;
}

/** Pesos → integer centavos. A non-positive or non-finite price is "no price". */
export function toCentavos(pesos: unknown): number | null {
  const n = typeof pesos === 'number' ? pesos : Number(pesos);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** The tier a milestone falls on: index N is the N×6-month gift, year N/2. */
export function tierForMilestone(tiers: OrderTier[], milestoneIndex: number): OrderTier | null {
  const year = milestoneIndex / 2;
  return tiers.find((t) => Math.abs(Number(t.year) - year) < 1e-6) ?? null;
}

export interface ResolveInput {
  submissions: OrderSubmission[];
  catalog: OrderCatalogItem[];
  tiers: OrderTier[];
  /** Line keys already on a LIVE order — those gifts are not open. */
  lockedKeys: ReadonlySet<string>;
  /** HR's variant picks: line key → catalog row id. */
  variantChoices?: Readonly<Record<string, string>>;
}

/**
 * Every OPEN order line: one per gift item per approved, not-yet-locked submission.
 * A submission whose tier names no gift still yields ONE line (problem
 * `no_tier_gift`) so it is visible rather than silently absent from Orders.
 */
export function resolveOrderLines(input: ResolveInput): OrderLine[] {
  const choices = input.variantChoices ?? {};
  const byName = new Map<string, OrderCatalogItem[]>();
  for (const row of input.catalog) {
    const name = row.item.trim().toLowerCase();
    if (!name) continue;
    const arr = byName.get(name) ?? [];
    arr.push(row);
    byName.set(name, arr);
  }

  const out: OrderLine[] = [];
  for (const sub of input.submissions) {
    if (sub.status !== 'approved') continue;
    const tier = tierForMilestone(input.tiers, sub.milestone_index);
    const names = tier ? tierGiftItems(tier) : [];

    const base = {
      submissionId: sub.id,
      personalEmail: sub.personal_email.trim().toLowerCase(),
      milestoneIndex: sub.milestone_index,
      milestoneDate: sub.milestone_date,
      submission: sub,
    };

    if (names.length === 0) {
      const key = orderLineKey(sub.id, '(no gift)');
      if (input.lockedKeys.has(key)) continue;
      out.push({
        ...base,
        key,
        item: tier?.gift?.trim() || '—',
        size: '',
        catalogItemId: null,
        unitCentavos: null,
        variantOptions: [],
        problem: 'no_tier_gift',
      });
      continue;
    }

    for (const name of names) {
      const key = orderLineKey(sub.id, name);
      if (input.lockedKeys.has(key)) continue;
      const rows = byName.get(name.toLowerCase()) ?? [];
      if (rows.length === 0) {
        out.push({ ...base, key, item: name, size: '', catalogItemId: null, unitCentavos: null, variantOptions: [], problem: 'off_catalog' });
        continue;
      }

      const sized = isSizedItem(rows);
      const personSize = canonicalSize(sub.apparel_size);
      let chosen: OrderCatalogItem | null = null;
      const picked = choices[key];
      if (picked) chosen = rows.find((r) => r.id === picked) ?? null;
      if (!chosen && rows.length === 1) chosen = rows[0];
      if (!chosen && sized && personSize) {
        const bySize = rows.filter((r) => canonicalSize(r.description) === personSize);
        if (bySize.length === 1) chosen = bySize[0];
      }

      const item = rows[0].item.trim();
      const variantOptions = rows.length > 1 ? rows : [];
      if (!chosen) {
        out.push({
          ...base,
          key,
          item,
          size: sized ? personSize ?? '' : '',
          catalogItemId: null,
          unitCentavos: null,
          variantOptions,
          problem: sized && !personSize ? 'needs_size' : 'needs_variant',
        });
        continue;
      }

      // Size: apparel prints the person's size; a size-named variant prints its
      // own; anything else prints the variant's description when there was a
      // choice to make (Tote Bag "Medium") and nothing when there was not.
      const variantSize = canonicalSize(chosen.description);
      const size = sized
        ? personSize ?? variantSize ?? ''
        : rows.length > 1
          ? chosen.description.trim()
          : '';
      const unit = toCentavos(chosen.price_php);
      const problem: OrderLineProblem | null =
        sized && !size ? 'needs_size' : unit === null ? 'no_price' : null;
      out.push({ ...base, key, item, size, catalogItemId: chosen.id, unitCentavos: unit, variantOptions, problem });
    }
  }
  return out.sort(
    (a, b) =>
      a.milestoneDate.localeCompare(b.milestoneDate) ||
      a.personalEmail.localeCompare(b.personalEmail) ||
      a.item.localeCompare(b.item),
  );
}

/**
 * How many gifts are OPEN — distinct submissions with at least one open line,
 * blocked ones included. The same unit the Open orders list counts, and what
 * the Orders tab badge shows.
 */
export function countOpenOrders(lines: OrderLine[]): number {
  return new Set(lines.map((l) => l.submissionId)).size;
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

/** One row a vendor reads: this item, this size, this many, at this price. */
export interface InvoiceGroup {
  item: string;
  size: string;
  qty: number;
  unitCentavos: number;
  amountCentavos: number;
}

/** Who each gift goes to — the packing list under the priced summary. */
export interface InvoiceRecipient {
  name: string;
  personalEmail: string;
  milestone: string;
  items: string;
  shipTo: string;
  contact: string;
  receivedBy: string;
}

/** The invoice as it is LOCKED. Stored verbatim in `gift_orders.snapshot`. */
export interface InvoiceSnapshot {
  version: 1;
  groups: InvoiceGroup[];
  recipients: InvoiceRecipient[];
  totalCentavos: number;
  qtyTotal: number;
  giftCount: number;
}

/** Lines the lock writes (the shape `gift_order_lock` takes). */
export interface LockLine {
  submission_id: string;
  personal_email: string;
  milestone_index: number;
  item: string;
  size: string;
  unit_centavos: number;
  qty: number;
}

/** Only lines with no problem can be invoiced. Throws if handed one that has. */
export function buildInvoice(
  lines: OrderLine[],
  nameOf: (personalEmail: string) => string | null,
): { snapshot: InvoiceSnapshot; lockLines: LockLine[] } {
  const groups = new Map<string, InvoiceGroup>();
  const lockLines: LockLine[] = [];
  const perSubmission = new Map<string, OrderLine[]>();

  for (const l of lines) {
    if (l.problem !== null || l.unitCentavos === null) {
      throw new Error(`Order line ${l.key} cannot be invoiced: ${l.problem ?? 'no price'}`);
    }
    const gk = `${l.item.toLowerCase()}|${l.size.toLowerCase()}|${l.unitCentavos}`;
    const g = groups.get(gk) ?? { item: l.item, size: l.size, qty: 0, unitCentavos: l.unitCentavos, amountCentavos: 0 };
    g.qty += 1;
    g.amountCentavos += l.unitCentavos;
    groups.set(gk, g);
    lockLines.push({
      submission_id: l.submissionId,
      personal_email: l.personalEmail,
      milestone_index: l.milestoneIndex,
      item: l.item,
      size: l.size,
      unit_centavos: l.unitCentavos,
      qty: 1,
    });
    const arr = perSubmission.get(l.submissionId) ?? [];
    arr.push(l);
    perSubmission.set(l.submissionId, arr);
  }

  const recipients: InvoiceRecipient[] = [];
  for (const ls of perSubmission.values()) {
    const s = ls[0].submission;
    const alt = s.recipient_name.trim();
    recipients.push({
      name: nameOf(ls[0].personalEmail) ?? ls[0].personalEmail,
      personalEmail: ls[0].personalEmail,
      milestone: `${milestoneLabel(s.milestone_index)} (#${s.milestone_index})`,
      items: ls.map((l) => (l.size ? `${l.item} (${l.size})` : l.item)).join(GIFT_JOINER),
      shipTo: s.preferred_delivery_location.trim(),
      contact: s.active_contact_number.trim(),
      receivedBy: alt
        ? `${alt}${s.recipient_relationship ? ` (${s.recipient_relationship})` : ''}${s.recipient_contact ? ` · ${s.recipient_contact}` : ''}`
        : '',
    });
  }
  recipients.sort((a, b) => a.name.localeCompare(b.name));

  const sortedGroups = [...groups.values()].sort(
    (a, b) => a.item.localeCompare(b.item) || sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size),
  );
  const totalCentavos = sortedGroups.reduce((n, g) => n + g.amountCentavos, 0);
  const qtyTotal = sortedGroups.reduce((n, g) => n + g.qty, 0);
  return {
    snapshot: { version: 1, groups: sortedGroups, recipients, totalCentavos, qtyTotal, giftCount: perSubmission.size },
    lockLines,
  };
}

/** ₱1,234.50 — the only place centavos become pesos. */
export function formatPhp(centavos: number): string {
  const sign = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}₱${pesos}.${cents}`;
}
