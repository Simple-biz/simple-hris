'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  parseManualValidationMap,
  validationFor,
  type ManualValidation,
  type ManualValidationMap,
} from '@/lib/payroll/manual-validation';

/**
 * Reads one cycle's manual validations ("MV") for the Payment Dispatch side, so
 * the Mark Paid dialog can show the clerk who vouched for the figure she is
 * about to send and what they said.
 *
 * ## Why a hook and not a key on `useDispatchQueue`
 *
 * `useDispatchQueue` carries per-cycle maps already (`deptByEmail`), but a new
 * key there has to be threaded through eight places — the public state
 * interface, the sessionStorage `CachedQueue`, `seedState`, `loadAll`'s return
 * type, its rates-error early return, its success return, `setTabCache`, and
 * both `setState` branches. Every one of those is a place to forget it, and the
 * two Mark Paid surfaces (`PayrollDispatch` and the standalone
 * `PayrollClerkApp`) already disagree about what they send — the clerk app omits
 * `amount_cop` and `system_bonus_*`. Adding another chance to diverge is the
 * wrong trade for one display string.
 *
 * This is one implementation with two call sites instead, and it is read-only:
 * MV is written from the wizard's Validation step, never from dispatch.
 */
export function useManualValidations(sourceFile: string | null | undefined): {
  validations: ManualValidationMap;
  /** Null until a load has completed at least once, so a caller can tell
   *  "nobody validated" from "we do not know yet". */
  loaded: boolean;
  error: string | null;
  validationFor: (email: string | null | undefined) => ManualValidation | null;
  refresh: () => void;
} {
  const [validations, setValidations] = useState<ManualValidationMap>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const key = sourceFile?.trim() || null;

  useEffect(() => {
    if (!key) {
      setValidations({});
      setLoaded(false);
      setError(null);
      return;
    }
    const ctl = new AbortController();
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/payroll-wizard/manual-validation?sourceFile=${encodeURIComponent(key)}`,
          { cache: 'no-store', signal: ctl.signal },
        );
        const json = (await res.json()) as {
          validations?: unknown;
          error?: string | null;
        };
        if (!alive) return;
        // The route answers 200-with-error in some paths, so check both.
        if (!res.ok || json.error) {
          setError(json.error?.trim() || `HTTP ${res.status}`);
          // Deliberately does NOT clear `validations`: a failed refresh must not
          // erase a banner that was correct a moment ago and make a validated
          // payment look unvouched.
          return;
        }
        const { map } = parseManualValidationMap(
          json.validations == null ? null : JSON.stringify(json.validations),
        );
        setValidations(map);
        setLoaded(true);
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [key, nonce]);

  const lookup = useCallback(
    (email: string | null | undefined) => validationFor(validations, email),
    [validations],
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { validations, loaded, error, validationFor: lookup, refresh };
}
