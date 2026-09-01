/**
 * Payroll Wizard additions blob — key building + save-body validation for the
 * concurrency-checked write route (`app/api/payroll-wizard/additions/route.ts`).
 *
 * `payroll.wizard.additions.<sourceFile>` is the whole-object blob that PAYS
 * (orphanageAmounts, bonus overrides, metrics, PAB snapshot — see
 * docs/features/orphanage-pay-step.md §Two carriers). It is saved as one map,
 * so a write from a tab holding stale state used to revert every person in it
 * with no error — that is how the 2026-08-09 week's re-pasted corrections were
 * rolled back nine minutes after they landed, and how the 2026-08-23 week ended
 * up with 44 recorded-hours rows paying ₱0. Writes therefore go through a
 * compare-and-swap route: the client sends the `updated_at` it loaded, and a
 * write over a revision the writer has not seen is REFUSED (409), never landed.
 *
 * The generic `/api/app-settings` POST refuses this key family outright so no
 * last-write-wins writer remains.
 */

const ADDITIONS_KEY_PREFIX = 'payroll.wizard.additions.';

export function additionsSettingKey(sourceFile: string): string {
  return `${ADDITIONS_KEY_PREFIX}${sourceFile}`;
}

/** True for any key in the CAS-only additions family. The trailing dot is part
 *  of the test on purpose: `payroll.wizard.additionsfoo` is not this family. */
export function isWizardAdditionsKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith(ADDITIONS_KEY_PREFIX);
}

/** Keys are built from this, so keep it to something filename-shaped — same
 *  contract as the MV route's `cleanSourceFile`. The fixed prefix already
 *  contains the blast radius; this only stops control characters and absurd
 *  lengths from becoming keys. */
export function cleanAdditionsSourceFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '' || s.length > 300) return null;
  for (let j = 0; j < s.length; j += 1) {
    const code = s.charCodeAt(j);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return s;
}

export type AdditionsSaveBody =
  | {
      ok: true;
      sourceFile: string;
      /** The blob to store, already serialized. */
      value: string;
      /** The `updated_at` the client loaded — null means "the key did not
       *  exist when I read it", which the CAS write treats as a plain INSERT
       *  so a racing creator conflicts instead of being overwritten. */
      expectedUpdatedAt: string | null;
    }
  | { ok: false; reason: string };

/**
 * Validate + normalize the POST body. The payload must be a plain object —
 * an array, a string or null would still stringify and store, and the wizard's
 * hydration would then read every field as absent, which is exactly the
 * "empty maps over a saved blob" wipe this route exists to prevent.
 */
export function parseAdditionsSaveBody(body: unknown): AdditionsSaveBody {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'Invalid JSON body' };
  }
  const b = body as { sourceFile?: unknown; payload?: unknown; expectedUpdatedAt?: unknown };

  const sourceFile = cleanAdditionsSourceFile(b.sourceFile);
  if (!sourceFile) return { ok: false, reason: 'sourceFile is required' };

  if (typeof b.payload !== 'object' || b.payload === null || Array.isArray(b.payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }

  if (b.expectedUpdatedAt !== null && typeof b.expectedUpdatedAt !== 'string') {
    return { ok: false, reason: 'expectedUpdatedAt must be the loaded updated_at string, or null for a new blob' };
  }

  return {
    ok: true,
    sourceFile,
    value: JSON.stringify(b.payload),
    expectedUpdatedAt: b.expectedUpdatedAt,
  };
}
