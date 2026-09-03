// Payment Catalog → "Pay Processors" — the registry of every processor Accounting
// sends salaries FROM (Kolan, HiGlobe, Wise, Jeeves, the x1153 wire account, …).
//
// SOURCE OF TRUTH BY DECISION (Kane, 2026-09-03): this registry is where a
// processor is defined — its label, logo, classification and status. Payment
// Dispatch will soon read it to build one bucket per processor. Until that
// integration lands, ROUTING still reads the compile-time `ProcessorId` union
// and `WALLET_RAILS` in `employee-payment-processors.ts`, so a wired row whose
// classification disagrees with code is surfaced as DRIFT — never silently
// reconciled in either direction. See docs/features/payment-catalog-pay-processors.md.
//
// Classification (Kane's words):
//   one_to_one  "one to one like Kolan and HiGlobe" — a WALLET rail. Money lands in
//               the same wallet it is sent from, so the receiving channel and the
//               send-from rail are physically the same account (the 1:1 rule,
//               bank-preferred-routing.md §4).
//   multi_peer  "compatible with another bank, like multi peer" — a BANK rail such
//               as Wise: it can send into any receiving bank. A flag, not a list.
//
// Storage: ONE JSON array in `app_settings` (same shape of decision as the
// Department registry — no table, no migration). This module is CLIENT-SAFE:
// types + pure helpers only, no Supabase imports.

import {
  BANK_PREFERRED_OPTIONS,
  PROCESSOR_OPTIONS,
  WALLET_RAILS,
  isProcessorId,
  type ProcessorId,
} from '@/lib/employee-payment-processors';

/** app_settings key holding the JSON registry (array of PayProcessor). */
export const PAY_PROCESSORS_SETTING_KEY = 'payment_catalog.pay_processors.registry';

export const PAY_PROCESSOR_ROUTINGS = ['one_to_one', 'multi_peer'] as const;
export type PayProcessorRouting = (typeof PAY_PROCESSOR_ROUTINGS)[number];

export const PAY_PROCESSOR_STATUSES = ['active', 'retired'] as const;
export type PayProcessorStatus = (typeof PAY_PROCESSOR_STATUSES)[number];

export const PAY_PROCESSOR_ROUTING_LABEL: Record<PayProcessorRouting, string> = {
  one_to_one: 'One-to-one',
  multi_peer: 'Multi-peer',
};

/** Plain-words help for the classification radios and chips. */
export const PAY_PROCESSOR_ROUTING_HELP: Record<PayProcessorRouting, string> = {
  one_to_one:
    'A wallet. Money is sent from this processor into the SAME wallet the person receives on — like Kolan or HiGlobe. Nobody on this rail can be paid from a bank account.',
  multi_peer:
    'A bank rail. It can send into any receiving bank the person has — like Wise, Jeeves or the x1153 account.',
};

/**
 * A logo is either one of the brand assets already shipped in `public/`
 * (the code-seeded processors) or an image Accounting uploaded in the tab,
 * stored inline as a data URL so the feature needs no storage bucket.
 */
export type PayProcessorLogo =
  | { kind: 'public'; src: string }
  | { kind: 'data'; dataUrl: string; mime: string; bytes: number };

export interface PayProcessor {
  /**
   * Stable id. For code-wired processors this IS the `ProcessorId` — and
   * `'hurupay'` stays `'hurupay'` forever (label "Kolan"): it is the literal
   * stored in `employee_ids.bank_preferred` and the value the routing predicates
   * compare against. For processors created in the tab it is a slug of the label.
   */
  id: string;
  label: string;
  /** Short one-liner shown under the label ("Email only"). */
  blurb: string;
  routing: PayProcessorRouting;
  status: PayProcessorStatus;
  logo: PayProcessorLogo | null;
  /** Free text for Accounting (account holder, who owns the login, …). */
  notes: string;
  /**
   * True when Payment Dispatch / the pickers know this id in code. Derived from
   * `PROCESSOR_OPTIONS` on every read — NEVER trusted from the stored blob.
   */
  wiredInCode: boolean;
  createdBy: string | null;
  /** ISO timestamp. */
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

// ── Code seeds ───────────────────────────────────────────────────────────────

/**
 * Logo asset per wired processor, PLATED variant. This tab renders every logo on
 * `ProcessorLogo`'s 80×44 white plate, the same surface as the Payment Dispatch
 * cards, so it takes the same artwork `PROCESSOR_VISUALS` does — for Kolan that is
 * the dark LOCKUP `/Kolan.png`, not the `/kolan.svg` mark the bare pickers draw
 * (memory: hurupay-kolan-rebrand — "two Kolan assets, pinned per SURFACE").
 * Case-exact: prod static serving is case-sensitive, Windows is not. The test
 * beside this file checks every path against `readdirSync`.
 */
export const SEED_LOGO_SRC: Partial<Record<ProcessorId, string>> = {
  hurupay: '/Kolan.png',
  higlobe: '/higlobe.png',
  wise: '/wise.png',
  jeeves: '/jeeves.png',
};

/** The only `public`-kind logo paths a write may carry. */
export const ALLOWED_PUBLIC_LOGO_SRCS: ReadonlySet<string> = new Set(
  Object.values(SEED_LOGO_SRC).filter((s): s is string => typeof s === 'string'),
);

/**
 * Wepay is RETIRED (Kane, 2026-09-03: "we have to retire this Wepay thing"). Every
 * other wired processor is offered somewhere today — Kolan/HiGlobe/x1153 everywhere,
 * Wise and Jeeves as Bank Preferred send-from options — so they seed active.
 */
const SEED_RETIRED: ReadonlySet<ProcessorId> = new Set<ProcessorId>(['wepay']);

/** The classification CODE routes on for a wired id, or null for a custom id. */
export function codeRoutingFor(id: string): PayProcessorRouting | null {
  if (!isProcessorId(id)) return null;
  return (WALLET_RAILS as readonly ProcessorId[]).includes(id) ? 'one_to_one' : 'multi_peer';
}

/** The label the send-from dropdown already uses ("x1153" for wires, "Kolan" for
 *  hurupay), falling back to the processor option label. */
function seedLabelFor(id: ProcessorId): string {
  return (
    BANK_PREFERRED_OPTIONS.find((o) => o.id === id)?.label ??
    PROCESSOR_OPTIONS.find((p) => p.id === id)?.label ??
    id
  );
}

/** The epoch stamp seeds carry until someone edits them — "never saved". */
export const SEED_CREATED_AT = new Date(0).toISOString();

/**
 * One registry row per processor the code knows, exactly as the app treats it
 * today. These are what the tab shows before anyone has saved anything, and
 * what fills a gap when a wired id is missing from the stored blob.
 */
export function codeSeedProcessors(): PayProcessor[] {
  return PROCESSOR_OPTIONS.map((p) => {
    const src = SEED_LOGO_SRC[p.id];
    return {
      id: p.id,
      label: seedLabelFor(p.id),
      blurb: p.blurb,
      routing: codeRoutingFor(p.id) ?? 'multi_peer',
      status: SEED_RETIRED.has(p.id) ? 'retired' : 'active',
      logo: src ? { kind: 'public', src } : null,
      notes: '',
      wiredInCode: true,
      createdBy: null,
      createdAt: SEED_CREATED_AT,
      updatedBy: null,
      updatedAt: null,
    };
  });
}

/** Has this seed ever been saved? False until the first edit lands. */
export function isUnsavedSeed(p: PayProcessor): boolean {
  return p.wiredInCode && p.createdAt === SEED_CREATED_AT && p.updatedAt === null;
}

/**
 * Registry classification vs what code routes on. `null` = no drift (custom rows
 * have nothing to drift from). Non-null = the tab says one thing and Payment
 * Dispatch still does another — shown as a chip, never auto-resolved.
 */
export function routingDrift(
  p: Pick<PayProcessor, 'id' | 'routing'>,
): { code: PayProcessorRouting; registry: PayProcessorRouting } | null {
  const code = codeRoutingFor(p.id);
  if (!code || code === p.routing) return null;
  return { code, registry: p.routing };
}

/**
 * The list the tab shows: the STORED rows win (the registry is the source of
 * truth), code seeds fill in any wired id nobody has saved yet, and two fields
 * are always re-derived from code regardless of what the blob says —
 * `wiredInCode` (a stored row cannot promote itself to "wired") and the id's
 * membership in the seed set. Sorted: active before retired, then by label.
 */
export function mergeRegistryOverCode(stored: readonly PayProcessor[]): PayProcessor[] {
  const byId = new Map<string, PayProcessor>();
  for (const seed of codeSeedProcessors()) byId.set(seed.id, seed);
  for (const row of stored) {
    byId.set(row.id, { ...row, wiredInCode: isProcessorId(row.id) });
  }
  return [...byId.values()].sort(comparePayProcessors);
}

export function comparePayProcessors(a: PayProcessor, b: PayProcessor): number {
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
  return a.label.localeCompare(b.label);
}

// ── Ids ──────────────────────────────────────────────────────────────────────

/** "Pay Pal (PH)" → "pay_pal_ph". Same slug rule as department keys. */
export function slugifyProcessorId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── Validation ───────────────────────────────────────────────────────────────

export const PAY_PROCESSOR_LABEL_MAX = 40;
export const PAY_PROCESSOR_BLURB_MAX = 80;
export const PAY_PROCESSOR_NOTES_MAX = 500;
/** 150 KB — enough for any wordmark PNG/SVG, small enough that seven of them in
 *  one `app_settings` row stay well under a megabyte. */
export const PAY_PROCESSOR_LOGO_MAX_BYTES = 150 * 1024;
export const PAY_PROCESSOR_LOGO_MIMES = [
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/jpeg',
] as const;

/** What a create / edit request carries. Everything else is server-derived. */
export interface PayProcessorInput {
  label: string;
  blurb?: string;
  routing: PayProcessorRouting;
  status?: PayProcessorStatus;
  logo?: PayProcessorLogo | null;
  notes?: string;
}

export type Validation = { ok: true } | { ok: false; error: string };

/** Base64 payload length → decoded byte count (padding-aware). */
export function base64DecodedBytes(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Is this a logo the registry may store? A `public` logo must be one of the
 * shipped seed assets (never an arbitrary path). A `data` logo must be an
 * allow-listed image MIME, carry a matching `data:<mime>;base64,` prefix, and
 * decode to ≤150 KB — checked against the ACTUAL base64 length, not the
 * caller's `bytes` claim. SVG is allowed because the tab renders logos only
 * through `<img src>`, where an SVG cannot run script.
 */
export function validatePayProcessorLogo(logo: unknown): Validation {
  if (logo === null || logo === undefined) return { ok: true };
  if (typeof logo !== 'object') return { ok: false, error: 'Logo must be an object or null.' };
  const l = logo as Record<string, unknown>;
  if (l.kind === 'public') {
    return typeof l.src === 'string' && ALLOWED_PUBLIC_LOGO_SRCS.has(l.src)
      ? { ok: true }
      : { ok: false, error: 'Only the shipped brand assets may be referenced by path — upload a file instead.' };
  }
  if (l.kind === 'data') {
    const mime = typeof l.mime === 'string' ? l.mime : '';
    if (!(PAY_PROCESSOR_LOGO_MIMES as readonly string[]).includes(mime)) {
      return { ok: false, error: 'Logo must be a PNG, SVG, WebP or JPEG image.' };
    }
    const dataUrl = typeof l.dataUrl === 'string' ? l.dataUrl : '';
    const prefix = `data:${mime};base64,`;
    if (!dataUrl.startsWith(prefix)) {
      return { ok: false, error: 'Logo data does not match its declared image type.' };
    }
    const b64 = dataUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      return { ok: false, error: 'Logo data is not valid base64.' };
    }
    const actual = base64DecodedBytes(b64);
    if (actual === 0) return { ok: false, error: 'Logo file is empty.' };
    if (actual > PAY_PROCESSOR_LOGO_MAX_BYTES) {
      return { ok: false, error: `Logo must be ${PAY_PROCESSOR_LOGO_MAX_BYTES / 1024} KB or smaller.` };
    }
    if (typeof l.bytes !== 'number' || Math.abs(l.bytes - actual) > 3) {
      return { ok: false, error: 'Logo size does not match its data.' };
    }
    return { ok: true };
  }
  return { ok: false, error: 'Unknown logo kind.' };
}

/**
 * Validate a create/edit body. `existingIds` = every id already in the merged
 * registry (stored + code seeds). On CREATE the label's slug must be new; on
 * EDIT the row keeps its id, so only the label itself is checked.
 */
export function validatePayProcessorInput(
  input: unknown,
  mode: 'create' | 'edit',
  existingIds: ReadonlySet<string>,
): Validation {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid body.' };
  const r = input as Record<string, unknown>;

  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label) return { ok: false, error: 'Give the processor a name.' };
  if (label.length > PAY_PROCESSOR_LABEL_MAX) {
    return { ok: false, error: `Name must be ${PAY_PROCESSOR_LABEL_MAX} characters or fewer.` };
  }
  if (mode === 'create') {
    const id = slugifyProcessorId(label);
    if (!id) return { ok: false, error: 'Name needs at least one letter or number.' };
    if (existingIds.has(id)) return { ok: false, error: `"${label}" already exists in the registry.` };
  }

  if (!(PAY_PROCESSOR_ROUTINGS as readonly string[]).includes(String(r.routing))) {
    return { ok: false, error: 'Pick a classification: One-to-one or Multi-peer.' };
  }
  if (r.status !== undefined && !(PAY_PROCESSOR_STATUSES as readonly string[]).includes(String(r.status))) {
    return { ok: false, error: 'Status must be active or retired.' };
  }
  if (r.blurb !== undefined && (typeof r.blurb !== 'string' || r.blurb.trim().length > PAY_PROCESSOR_BLURB_MAX)) {
    return { ok: false, error: `Blurb must be ${PAY_PROCESSOR_BLURB_MAX} characters or fewer.` };
  }
  if (r.notes !== undefined && (typeof r.notes !== 'string' || r.notes.trim().length > PAY_PROCESSOR_NOTES_MAX)) {
    return { ok: false, error: `Notes must be ${PAY_PROCESSOR_NOTES_MAX} characters or fewer.` };
  }
  const logo = validatePayProcessorLogo(r.logo);
  if (!logo.ok) return logo;
  return { ok: true };
}

// ── Mutations (pure) ─────────────────────────────────────────────────────────

/** A brand-new custom row from a validated input. */
export function buildPayProcessor(input: PayProcessorInput, actor: string, now: string): PayProcessor {
  const label = input.label.trim();
  return {
    id: slugifyProcessorId(label),
    label,
    blurb: (input.blurb ?? '').trim(),
    routing: input.routing,
    status: input.status ?? 'active',
    logo: input.logo ?? null,
    notes: (input.notes ?? '').trim(),
    wiredInCode: false,
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
  };
}

/**
 * Apply an edit. `id`, `wiredInCode`, `createdBy` and `createdAt` are IMMUTABLE —
 * a rename changes the label only, never the id (for `'hurupay'` the id is the
 * routing literal; for a custom row it is what a future dispatch bucket will key
 * on). A seed being edited for the first time gets its `createdAt` stamped now
 * and its creator recorded, since that is when it first became a stored row.
 */
export function applyPayProcessorPatch(
  existing: PayProcessor,
  input: PayProcessorInput,
  actor: string,
  now: string,
): PayProcessor {
  const firstSave = isUnsavedSeed(existing);
  return {
    ...existing,
    label: input.label.trim(),
    blurb: (input.blurb ?? existing.blurb).trim(),
    routing: input.routing,
    status: input.status ?? existing.status,
    logo: input.logo === undefined ? existing.logo : input.logo,
    notes: (input.notes ?? existing.notes).trim(),
    createdBy: firstSave ? actor : existing.createdBy,
    createdAt: firstSave ? now : existing.createdAt,
    updatedBy: actor,
    updatedAt: now,
  };
}

// ── Sanitising a stored blob ─────────────────────────────────────────────────

/**
 * One stored row → a PayProcessor, or null when it is not one. Lenient on
 * optional text, strict on id / label / routing / status, and it re-derives
 * `wiredInCode` from code. A logo that fails validation is DROPPED (null) rather
 * than failing the row — a bad image must not make a processor vanish from the
 * tab, because a vanished processor is indistinguishable from a retired one.
 */
export function sanitizePayProcessor(raw: unknown): PayProcessor | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!id || !label) return null;
  if (!/^[a-z0-9_]+$/.test(id)) return null;
  const routing = (PAY_PROCESSOR_ROUTINGS as readonly string[]).includes(String(r.routing))
    ? (r.routing as PayProcessorRouting)
    : null;
  const status = (PAY_PROCESSOR_STATUSES as readonly string[]).includes(String(r.status))
    ? (r.status as PayProcessorStatus)
    : null;
  if (!routing || !status) return null;
  const logo = validatePayProcessorLogo(r.logo).ok ? ((r.logo as PayProcessorLogo | null) ?? null) : null;
  return {
    id,
    label: label.slice(0, PAY_PROCESSOR_LABEL_MAX),
    blurb: typeof r.blurb === 'string' ? r.blurb.trim().slice(0, PAY_PROCESSOR_BLURB_MAX) : '',
    routing,
    status,
    logo,
    notes: typeof r.notes === 'string' ? r.notes.trim().slice(0, PAY_PROCESSOR_NOTES_MAX) : '',
    wiredInCode: isProcessorId(id),
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    createdAt: typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : SEED_CREATED_AT,
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : null,
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : null,
  };
}

/** The `<img src>` for a logo, or null. Both kinds render through <img>. */
export function payProcessorLogoSrc(logo: PayProcessorLogo | null | undefined): string | null {
  if (!logo) return null;
  return logo.kind === 'public' ? logo.src : logo.dataUrl;
}
