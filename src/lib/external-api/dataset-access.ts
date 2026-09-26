/**
 * Who holds a dataset — the "Clients with access" block of the Data catalog.
 *
 * Computed from the SAME client list the Integrations tab shows
 * (`GET /api/admin/external-api-clients`), on every render, never stored: a grant
 * written into the catalog would be wrong the first time an admin edits a key.
 *
 * A client holds a dataset when its `scopes` include the dataset's scope. Its state
 * follows the Integrations panel's `stateOf` order, which is also the order
 * `authenticateExternalRequest` refuses in: revoked first, then expired (`isExpired`,
 * FAIL-CLOSED — a stamp that does not parse is expired), otherwise live. Only a live
 * client can actually read today; revoked and expired ones are listed so the page
 * answers "who could, and who used to".
 *
 * Field counts come from `granted_columns`, which today is the GML grant and nothing
 * else. For any other scope the grant is reported as unknown rather than guessed —
 * applying the GML column list to another dataset would invent a grant. Phase A's
 * per-scope `granted_fields` replaces this.
 *
 * Pure: the client bundle imports it.
 */
import { isExpired } from './expiry';
import type { LiveDataset } from './datasets';

/** The subset of the admin client view this needs. */
export type AccessClient = {
  id: string;
  name: string;
  system: string;
  contact_email: string | null;
  key_prefix: string;
  scopes: string[] | null | undefined;
  granted_columns: string[] | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  calls_7d: number;
};

export type AccessState = 'live' | 'expired' | 'revoked';

export type FieldGrant =
  | { kind: 'whole' }
  | { kind: 'partial'; visible: string[]; hidden: string[] }
  | { kind: 'unknown' };

export type AccessRow = {
  client: AccessClient;
  state: AccessState;
  fields: FieldGrant;
};

export const GML_SCOPE = 'global_master_list.read';

export function accessStateOf(c: Pick<AccessClient, 'revoked_at' | 'expires_at'>, nowMs: number = Date.now()): AccessState {
  if (c.revoked_at) return 'revoked';
  if (isExpired(c.expires_at, nowMs)) return 'expired';
  return 'live';
}

/** What of `dataset` this client may see. `null` grant = the whole dataset. */
export function fieldGrantFor(c: Pick<AccessClient, 'granted_columns'>, dataset: LiveDataset): FieldGrant {
  if (dataset.scope !== GML_SCOPE) return { kind: 'unknown' };
  const grant = c.granted_columns;
  if (grant === null) return { kind: 'whole' };
  const chosen = new Set(grant);
  const visible = dataset.fields.map((f) => f.name).filter((n) => chosen.has(n));
  const hidden = dataset.fields.map((f) => f.name).filter((n) => !chosen.has(n));
  if (hidden.length === 0) return { kind: 'whole' };
  return { kind: 'partial', visible, hidden };
}

const STATE_ORDER: Record<AccessState, number> = { live: 0, expired: 1, revoked: 2 };

/** Every client whose scopes include the dataset's — live first, then expired, then revoked, by name. */
export function clientAccess(clients: readonly AccessClient[], dataset: LiveDataset, nowMs: number = Date.now()): AccessRow[] {
  const rows: AccessRow[] = [];
  for (const c of clients) {
    if (!Array.isArray(c.scopes) || !c.scopes.includes(dataset.scope)) continue;
    rows.push({ client: c, state: accessStateOf(c, nowMs), fields: fieldGrantFor(c, dataset) });
  }
  return rows.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.client.name.localeCompare(b.client.name),
  );
}

/** How many clients can read the dataset right now. */
export function liveCount(rows: readonly AccessRow[]): number {
  return rows.filter((r) => r.state === 'live').length;
}

/**
 * The one-line access answer for a live dataset's row in the list.
 *
 * `rows === null` means the client list was NOT read (still loading, or the fetch
 * failed with nothing cached). That is **unknown**, never "no clients": a failed read
 * shown as zero tells an admin nobody holds the roster when somebody might.
 */
export function describeAccess(rows: readonly AccessRow[] | null): { tone: 'unknown' | 'none' | 'some'; text: string } {
  if (rows === null) return { tone: 'unknown', text: 'Unknown — client list not loaded' };
  const live = liveCount(rows);
  const inactive = rows.length - live;
  if (live === 0) {
    return { tone: 'none', text: inactive > 0 ? `No live client · ${inactive} inactive` : 'No client holds it' };
  }
  const head = `${live} live client${live === 1 ? '' : 's'}`;
  return { tone: 'some', text: inactive > 0 ? `${head} · ${inactive} inactive` : head };
}
