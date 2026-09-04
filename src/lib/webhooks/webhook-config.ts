/**
 * `webhooks.config` — the shape Admin → Webhooks stores, plus the pure rules for
 * the per-slug AUTOMATION overrides added 2026-09-04 (docs/features/webhook-automations.md).
 *
 * An entry has always been { slug, url, active, … }. Two OPTIONAL fields join it:
 *
 *   recipients        — who the automation mails. `mode: 'role'` keeps the code's
 *                       default audience (e.g. everyone holding the `accounting`
 *                       role) and lets an admin ADD or REMOVE individual addresses
 *                       on top; `mode: 'custom'` replaces the audience with a fixed
 *                       list. Role mode is the default: revoking someone's role
 *                       still removes them, and the editor is for exceptions.
 *   payload_overrides — top-level keys shallow-merged INTO the payload the code
 *                       builds. The keys that carry the week's FACTS are protected
 *                       and can never be overridden — refused on save and stripped
 *                       again at send, so a raw write to app_settings cannot make
 *                       the email lie either (memory: payment-cycle-complete-celebration —
 *                       the honesty fields are never massaged).
 *
 * Pure: no I/O. The resolver (`resolve-webhook.ts`) and the admin route both parse
 * through here so the two cannot disagree about what an entry means.
 */

export interface WebhookRecipientOverride {
  mode: 'role' | 'custom';
  /** Role mode: addresses mailed IN ADDITION to the role holders. */
  add: string[];
  /** Role mode: role holders who must NOT be mailed. */
  remove: string[];
  /** Custom mode: the whole list. Ignored in role mode. */
  custom: string[];
}

export interface WebhookAutomationConfig {
  recipients: WebhookRecipientOverride | null;
  payload_overrides: Record<string, unknown> | null;
}

export interface WebhookConfigEntry extends WebhookAutomationConfig {
  id?: string;
  slug: string;
  label?: string;
  url: string;
  active: boolean;
  description?: string;
  updated_at?: string;
}

export interface WebhookRecipient {
  email: string;
  name: string | null;
}

export interface EffectiveRecipient extends WebhookRecipient {
  /** Where this address came from: the code's default audience, or the override. */
  source: 'role' | 'added' | 'custom';
}

/**
 * Payload keys an override may NEVER set. These are the facts of the event and
 * the delivery envelope: who it goes to, what week it describes, how much was
 * paid or still owed, whether it is a celebration, and the attached files.
 */
export const PROTECTED_PAYLOAD_KEYS: readonly string[] = [
  'event',
  'trigger',
  'celebrate',
  'cycle',
  'stats',
  'recipients',
  'attachments',
  'attachments_error',
  'sent_by',
  'test',
];

/** n8n's own refusal threshold in the celebration workflow — mirrored here so a
 *  list that would be rejected downstream is refused at save time instead. */
export const MAX_RECIPIENTS = 300;

/** Upper bound on the serialized overrides — a payload field, not a document store. */
export const MAX_PAYLOAD_OVERRIDES_BYTES = 16 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e && EMAIL_RE.test(e) ? e : null;
}

function emailList(raw: unknown): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { emails, invalid };
  for (const item of raw) {
    const e = normalizeEmail(item);
    if (!e) {
      if (typeof item === 'string' && item.trim()) invalid.push(item.trim());
      continue;
    }
    if (seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }
  return { emails, invalid };
}

/** Lenient parse of a stored `recipients` value. Junk → null (= no override). */
export function normalizeRecipientOverride(raw: unknown): WebhookRecipientOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === 'custom' ? 'custom' : 'role';
  const add = emailList(r.add).emails;
  const remove = emailList(r.remove).emails;
  const custom = emailList(r.custom).emails;
  if (mode === 'role' && add.length === 0 && remove.length === 0) return null;
  return { mode, add, remove, custom };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Lenient parse of a stored `payload_overrides` value. Junk → null. Protected
 *  keys are DROPPED here too, so even a hand-edited row cannot carry them. */
export function normalizePayloadOverrides(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (PROTECTED_PAYLOAD_KEYS.includes(k)) continue;
    if (!k.trim()) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Parse the stored `webhooks.config` JSON into entries. Never throws; junk → []. */
export function parseWebhookConfig(raw: string | null | undefined): WebhookConfigEntry[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: WebhookConfigEntry[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const slug = typeof item.slug === 'string' ? item.slug : '';
    out.push({
      id: typeof item.id === 'string' ? item.id : undefined,
      slug,
      label: typeof item.label === 'string' ? item.label : undefined,
      url: typeof item.url === 'string' ? item.url : '',
      active: item.active === true,
      description: typeof item.description === 'string' ? item.description : undefined,
      updated_at: typeof item.updated_at === 'string' ? item.updated_at : undefined,
      recipients: normalizeRecipientOverride(item.recipients),
      payload_overrides: normalizePayloadOverrides(item.payload_overrides),
    });
  }
  return out;
}

/**
 * The audience the automation will actually mail.
 *
 *  - role mode:   defaults - remove + add (added people carry no name unless the
 *                 defaults already knew one). Remove wins over add: an address
 *                 listed in both is never mailed.
 *  - custom mode: the custom list, names borrowed from the defaults when present.
 *
 * Deduped by lowercase email; the defaults' order is preserved, additions follow.
 */
export function applyRecipientOverride(
  defaults: readonly WebhookRecipient[],
  override: WebhookRecipientOverride | null | undefined,
): { effective: EffectiveRecipient[]; added: string[]; removed: string[] } {
  const nameByEmail = new Map<string, string | null>();
  const base: EffectiveRecipient[] = [];
  const seen = new Set<string>();
  for (const d of defaults) {
    const e = normalizeEmail(d.email);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    nameByEmail.set(e, d.name ?? null);
    base.push({ email: e, name: d.name ?? null, source: 'role' });
  }
  if (!override) return { effective: base, added: [], removed: [] };

  // Normalize defensively — the stored value went through
  // `normalizeRecipientOverride`, but this is also called with editor state.
  const custom = emailList(override.custom).emails;
  const addList = emailList(override.add).emails;
  const removeSet = new Set(emailList(override.remove).emails);

  if (override.mode === 'custom') {
    const effective: EffectiveRecipient[] = custom.map((email) => ({
      email,
      name: nameByEmail.get(email) ?? null,
      source: 'custom',
    }));
    return {
      effective,
      added: custom.filter((e) => !seen.has(e)),
      removed: base.map((b) => b.email).filter((e) => !custom.includes(e)),
    };
  }

  const effective = base.filter((b) => !removeSet.has(b.email));
  const removed = base.filter((b) => removeSet.has(b.email)).map((b) => b.email);
  const added: string[] = [];
  for (const email of addList) {
    if (removeSet.has(email)) continue;
    if (effective.some((r) => r.email === email)) continue;
    effective.push({ email, name: nameByEmail.get(email) ?? null, source: 'added' });
    added.push(email);
  }
  return { effective, added, removed };
}

/**
 * Shallow-merge overrides INTO a built payload. Protected keys are reported in
 * `rejected` and never applied — the facts always win.
 */
export function mergePayloadOverrides(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> | null | undefined,
): { payload: Record<string, unknown>; rejected: string[] } {
  const payload: Record<string, unknown> = { ...base };
  const rejected: string[] = [];
  if (!overrides || !isPlainObject(overrides)) return { payload, rejected };
  for (const [k, v] of Object.entries(overrides)) {
    if (PROTECTED_PAYLOAD_KEYS.includes(k)) {
      rejected.push(k);
      continue;
    }
    payload[k] = v;
  }
  return { payload, rejected };
}

/**
 * STRICT validation for a save from the Admin editor. Unlike the lenient
 * normalizers above (which quietly drop junk so a bad row can't break delivery),
 * this names every problem so the admin fixes it instead of silently losing it.
 */
export function validateAutomationConfig(raw: {
  recipients?: unknown;
  payload_overrides?: unknown;
}): { ok: true; config: WebhookAutomationConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  let recipients: WebhookRecipientOverride | null = null;
  if (raw.recipients != null) {
    if (!isPlainObject(raw.recipients)) {
      errors.push('recipients must be an object');
    } else {
      const r = raw.recipients;
      const mode = r.mode ?? 'role';
      if (mode !== 'role' && mode !== 'custom') {
        errors.push(`recipients.mode must be "role" or "custom" (got ${JSON.stringify(mode)})`);
      }
      const add = emailList(r.add);
      const remove = emailList(r.remove);
      const custom = emailList(r.custom);
      for (const bad of [...add.invalid, ...remove.invalid, ...custom.invalid]) {
        errors.push(`"${bad}" is not a valid email address`);
      }
      for (const e of add.emails.filter((x) => remove.emails.includes(x))) {
        errors.push(`"${e}" is listed under both add and remove`);
      }
      if (mode === 'custom' && custom.emails.length === 0) {
        errors.push('custom mode needs at least one recipient — or switch back to role mode');
      }
      if (custom.emails.length > MAX_RECIPIENTS || add.emails.length > MAX_RECIPIENTS) {
        errors.push(`at most ${MAX_RECIPIENTS} recipients`);
      }
      if (errors.length === 0 && (mode === 'role' || mode === 'custom')) {
        recipients =
          mode === 'role' && add.emails.length === 0 && remove.emails.length === 0
            ? null
            : { mode, add: add.emails, remove: remove.emails, custom: custom.emails };
      }
    }
  }

  let payload_overrides: Record<string, unknown> | null = null;
  if (raw.payload_overrides != null) {
    if (!isPlainObject(raw.payload_overrides)) {
      errors.push('payload_overrides must be a JSON object');
    } else {
      const keys = Object.keys(raw.payload_overrides);
      for (const k of keys.filter((x) => PROTECTED_PAYLOAD_KEYS.includes(x))) {
        errors.push(`"${k}" is a protected key — the automation owns it and it cannot be overridden`);
      }
      if (keys.some((k) => !k.trim())) errors.push('payload_overrides has an empty key');
      let size = 0;
      try {
        size = JSON.stringify(raw.payload_overrides).length;
      } catch {
        errors.push('payload_overrides is not serializable JSON');
      }
      if (size > MAX_PAYLOAD_OVERRIDES_BYTES) {
        errors.push(`payload_overrides exceeds ${MAX_PAYLOAD_OVERRIDES_BYTES} bytes`);
      }
      if (errors.length === 0) {
        payload_overrides = keys.length ? { ...raw.payload_overrides } : null;
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { recipients, payload_overrides } };
}

/**
 * Which slugs have an editable automation, and what the editor should say about
 * them. Absent from this map = the card shows no "Open automation" button. Adding
 * a slug here is a feature: it needs a server preview + test-run path in
 * app/api/admin/webhooks/automation/route.ts and a doc section.
 */
export interface WebhookAutomationDescriptor {
  slug: string;
  title: string;
  /** What fires it — the ONLY thing that fires it. */
  trigger: string;
  /** Where the default recipients come from. */
  audience: string;
  /** Attached files, by name, in send order. */
  attachments: string[];
}

export const WEBHOOK_AUTOMATIONS: Record<string, WebhookAutomationDescriptor> = {
  payment_cycle_complete: {
    slug: 'payment_cycle_complete',
    title: 'Payment cycle closed → celebrate Accounting',
    trigger:
      'Payment Dispatch → Stop processing → "Close the pay cycle" ON. Fires once, from the server, right after the close-out record is filed. Nothing else can fire it.',
    audience: 'Everyone currently holding the accounting role (revoked grants excluded).',
    attachments: ['Cycle close-out CSV', 'Cycle close-out XLSX', 'Cycle close-out PDF'],
  },
};
