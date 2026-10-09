import 'server-only';

import { getAppSettingStrict } from './app-settings';
import { PAYOUT_GUARDRAIL_KEY, parsePayoutGuardrail } from '@/lib/banking/payout-change-safety';

/**
 * Whether the bank-change guardrail is ON (Accounting → System Settings → Bank
 * Guardrail). Read fresh on every save and every form load: no cache, so a switch
 * takes effect on the next save.
 *
 * FAILS ON: a read that fails is ON, never off. A failed read only means the
 * employee is asked to tick a box; reading it as "off" would silently drop the
 * guardrail for every save while the database is unreachable.
 */
export async function readPayoutGuardrailOn(): Promise<boolean> {
  try {
    return parsePayoutGuardrail(await getAppSettingStrict(PAYOUT_GUARDRAIL_KEY));
  } catch (e) {
    console.error('[payout-guardrail] switch unreadable; treating the guardrail as ON', e);
    return true;
  }
}
