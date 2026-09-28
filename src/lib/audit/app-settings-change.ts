/**
 * What an `app_settings` write through `POST /api/app-settings` records in the
 * audit log (`app_settings.changed`).
 *
 * Why this exists: that route used to audit only the payroll lock and the
 * sensitive/secret families, so every other key it wrote — the PAB Period
 * (`pab_period_overrides` / `pab_period_active_month`), the Tech Bonus payout
 * week, the US holiday list and switch, the Step-7 "Do not pay" set, the cycle
 * FX record — landed with no row at all. On 2026-09-28 "who changed the PAB
 * Period?" could only be answered by inference from `wizard.opened`, and the
 * previous window was unrecoverable (session log item 239).
 *
 * The audit is decided by KEY, on the server, so every writer of a key is
 * recorded — the wizard, System Settings, Admin — and a key added tomorrow is
 * audited by default. The only keys left out are the derived snapshots in
 * {@link APP_SETTING_AUDIT_EXEMPT}, each named with its reason and pinned by
 * `app-settings-change.test.ts`, so an exemption cannot be added silently.
 *
 * Isomorphic and pure — the route reads the old value, writes, then calls
 * {@link describeAppSettingChange}.
 */

/** Longest value copied verbatim into `details`. Longer values are summarised. */
export const APP_SETTING_AUDIT_VALUE_MAX = 4000;

/** Most top-level JSON keys listed when a long value is summarised. */
export const APP_SETTING_AUDIT_CHANGED_KEYS_MAX = 100;

/**
 * Keys written through the generic route that are deliberately NOT audited.
 * Each is a DERIVED snapshot whose inputs are audited elsewhere; listed in
 * `docs/features/audit-log.md` §6 with the same reasons.
 */
export const APP_SETTING_AUDIT_EXEMPT: readonly { match: string; kind: 'prefix' | 'exact'; reason: string }[] = [
  {
    match: 'payroll.wizard.final_pay.',
    kind: 'prefix',
    reason:
      'The wizard republishes it automatically 1.5 s after any change (whole-payroll sized). It is computed from audited inputs — wizard.additions_saved, app_settings.changed, csv.* — and staging it is audited as paystubs.staged.',
  },
  {
    match: 'hubstaff_daily_breakdown',
    kind: 'exact',
    reason: 'A by-product of the Hubstaff ingest, which is itself audited as csv.upload.',
  },
];

/** True when a successful write of `key` must leave an `app_settings.changed` row. */
export function isAppSettingChangeAudited(key: string): boolean {
  const k = key.trim();
  return !APP_SETTING_AUDIT_EXEMPT.some((e) => (e.kind === 'exact' ? k === e.match : k.startsWith(e.match)));
}

/**
 * The pay cycle a per-cycle wizard key belongs to, so the event also lands in
 * that cycle's Step 9 audit trail (strategy 1 of `cycle-audit.ts` keys on
 * `details.cycle.source_file`). `payroll.wizard.<segment>.<sourceFile>` where
 * the source file is a Hubstaff CSV name; anything else → null.
 */
export function cycleSourceFileFromSettingKey(key: string): string | null {
  const m = /^payroll\.wizard\.[a-z0-9_]+\.(.+\.csv)$/i.exec(key.trim());
  return m ? m[1] : null;
}

export type AppSettingChangeDetails = {
  key: string;
  /** Verbatim when ≤ {@link APP_SETTING_AUDIT_VALUE_MAX}; absent when summarised or unknown. */
  before?: string | null;
  after?: string;
  /** No row existed before this write (and the pre-read succeeded). */
  created: boolean;
  /** The pre-write read failed — `before` is UNKNOWN, never "absent". */
  before_unavailable?: true;
  /** Set when a value was too long to copy. */
  summarised?: true;
  before_length?: number;
  after_length?: number;
  /** Top-level JSON keys whose value differs (only when summarised and both sides parse as objects). */
  changed_keys?: string[];
  changed_keys_total?: number;
  cycle?: { source_file: string };
};

function topLevelChangedKeys(before: string | null, after: string): string[] | null {
  const parse = (v: string | null): Record<string, unknown> | null => {
    if (v == null) return {};
    try {
      const p = JSON.parse(v) as unknown;
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/**
 * The `details` for one write, or `null` when the write changed nothing
 * (re-posting the same value is not an event — the `/api/pab-exclusions`
 * precedent). A failed pre-read is never treated as "unchanged": the event is
 * written with `before_unavailable`.
 */
export function describeAppSettingChange(
  key: string,
  before: string | null,
  after: string,
  opts: { beforeUnavailable?: boolean } = {},
): AppSettingChangeDetails | null {
  const k = key.trim();
  const beforeUnavailable = opts.beforeUnavailable === true;
  if (!beforeUnavailable && before === after) return null;

  const details: AppSettingChangeDetails = { key: k, created: !beforeUnavailable && before === null };
  if (beforeUnavailable) details.before_unavailable = true;

  const beforeTooLong = !beforeUnavailable && before != null && before.length > APP_SETTING_AUDIT_VALUE_MAX;
  const afterTooLong = after.length > APP_SETTING_AUDIT_VALUE_MAX;
  if (beforeTooLong || afterTooLong) {
    details.summarised = true;
    if (!beforeUnavailable) details.before_length = before?.length ?? 0;
    details.after_length = after.length;
    const changed = beforeUnavailable ? null : topLevelChangedKeys(before, after);
    if (changed) {
      details.changed_keys = changed.slice(0, APP_SETTING_AUDIT_CHANGED_KEYS_MAX);
      details.changed_keys_total = changed.length;
    }
  } else {
    if (!beforeUnavailable) details.before = before;
    details.after = after;
  }

  const sourceFile = cycleSourceFileFromSettingKey(k);
  if (sourceFile) details.cycle = { source_file: sourceFile };
  return details;
}
