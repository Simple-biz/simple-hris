/**
 * Receiving-country currency for a single payee, resolved from their onboarding
 * paperwork — the server-side twin of `current-pay.ts`'s bulk `countryCurrency`
 * marker, for routes that render ONE person (the paystub readers).
 *
 * Colombia → COP marks Colombian staff who ride the PHP rails but are settled
 * in Colombian pesos; their pay statement carries a native COP equivalent.
 *
 * Same trust rule as current-pay: ONLY the hire-selected `country` counts.
 * HR's `invite_country` pick has real misclicks on never-submitted invites
 * (a Filipino hire invited under "Colombia"), and a wrong COP marker would put
 * a Colombian-peso line on a Filipino's pay document.
 *
 * Submissions are filed under the hire's personal email, so callers must pass
 * every alias they know (work + personal + gsuite alternates — e.g. from the
 * master record); this matches them against both submission email columns.
 */
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { getAppSetting } from "@/lib/supabase/app-settings";
import {
  USD_TO_COP_SETTINGS_KEY,
  effectiveUsdToCopRateFromStored,
} from "@/lib/fx/currency-fx";
import { currencyForCountry } from "@/lib/onboarding/countries";
import { normEmail } from "@/lib/email/norm-email";
import type { PayCurrency } from "@/lib/payment-catalog/pay-structure";

/** Resolve the payee's receiving-country currency from any of their emails.
 *  Null when no submission matches or the country doesn't map — callers then
 *  simply render no native-currency line. Best-effort: DB errors → null. */
export async function resolveCountryCurrencyForEmails(
  emails: Array<string | null | undefined>,
): Promise<PayCurrency | null> {
  const list = [...new Set(emails.map((e) => normEmail(e)).filter((e): e is string => !!e))];
  if (list.length === 0) return null;
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return null;
  try {
    const or = list
      .flatMap((e) => [`email.ilike.${e}`, `invite_personal_email.ilike.${e}`])
      .join(",");
    const { data, error } = await supabase
      .from("hr_onboarding_submissions")
      .select("country")
      .or(or)
      .limit(10);
    if (error) return null;
    for (const row of (data ?? []) as Array<{ country: string | null }>) {
      const cur = currencyForCountry(row.country);
      if (cur) return cur;
    }
    return null;
  } catch {
    return null;
  }
}

/** COP per $1 from `app_settings` (`usd_to_cop_rate`), with the official-rate
 *  fallback — the SAME resolution `buildFxRates` gives the dispatch queue, so a
 *  stub's COP equivalent always matches the figure Payment Dispatch pays. */
export async function getUsdToCopRate(): Promise<number> {
  try {
    return effectiveUsdToCopRateFromStored(await getAppSetting(USD_TO_COP_SETTINGS_KEY));
  } catch {
    return effectiveUsdToCopRateFromStored(null);
  }
}
