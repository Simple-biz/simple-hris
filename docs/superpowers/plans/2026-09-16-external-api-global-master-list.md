# External read API — Global Master List (per-client keys, revocable, logged)

**Approved brief:** in-session 2026-09-16. Kane's answers: Q1 = ALL columns, Q2 = off-boarded
people UNREACHABLE (no flag), Q3 = "an optimal rate limit" → 60 requests / minute / key
(a full roster pull is 8 calls at the 500-row cap), Q4 = recommendation → **Rotate** keeps the
client id and its call history; the history is the "what system is calling us" record.

One deviation from the brief, decided during build: `/api/external/*` passes the SSO proxy
**unconditionally** rather than only with a `Bearer hris_` header. The handler is the gate
either way (fail-closed, every denial logged); the difference is that a caller with a missing
or wrong key gets a JSON `401` instead of a `302` to the login page's HTML, which is the
answer an API client can act on.

**Stack:** Next.js app router, `node:crypto`, `@supabase/supabase-js` (service-role, server
only), `selectAllPaged`, `node --import tsx --test`, `pg` for the migration script.

## Task 1 — the two tables

- [ ] `references/sql/create/2026-09-16_external_api_clients.sql` — `external_api_clients`
  (name, system, contact_email, key_prefix, key_hash UNIQUE, scopes, created/revoked/rotated
  stamps, last_used_at) + `external_api_requests` (one row per call, incl. denied ones).
  RLS on, no policies. CHECKs: non-blank name/system, hash is 64 hex, scopes ⊆ the known set.
- [ ] `scripts/apply-external-api-clients-migration.mts` — copy of the OMS script: `--dry`
  default, `--apply`, `--verify`; positive + negative controls that prove the CHECKs bite.
- [ ] `scripts/Apply External API clients migration.cmd` — its own launcher.

## Task 2 — pure modules

- [ ] `src/lib/external-api/keys.ts` — `generateApiKey()` (`hris_live_` + 32 CSPRNG bytes,
  base64url), `keyPrefix()`, `hashApiKey(key, pepper)`, `looksLikeApiKey()`,
  `constantTimeEqualHex` (re-exported from otp-core), `readPepper(env)` — **fails closed**.
- [ ] `src/lib/external-api/keys.test.ts`
- [ ] `src/lib/external-api/gml-query.ts` — `parseGmlQuery(searchParams)` (department,
  email, search, limit ≤ 500, cursor), `applyGmlQuery(rows, query)` (active-only is applied
  BEFORE any filter, stable `id` order, keyset cursor), `MAX_LIMIT`.
- [ ] `src/lib/external-api/gml-query.test.ts` — off-boarded rows never leak through any
  filter; limit clamps; cursor is exclusive; email matches every alias column.
- [ ] `src/lib/external-api/rate-limit.ts` — sliding window per client id, 60/min,
  returns `{ allowed, remaining, retryAfterSeconds }`. Pure, injectable clock.
- [ ] `src/lib/external-api/rate-limit.test.ts`

## Task 3 — data layer

- [ ] `src/lib/supabase/external-api-db.ts` — `findClientByKeyHash`, `listClients`,
  `createClient`, `updateClient`, `insertRequestLog`, `touchLastUsed`, `listRequests`,
  `countRequestsSince` (paged). Every read of `global_master_list` goes through
  `selectAllPaged` with `.is('off_boarded_at', null)` — the off-boarded filter is in the SQL
  AND in the pure function.

## Task 4 — the external route

- [ ] `src/lib/external-api/authenticate.ts` — Bearer → client row or a typed denial
  (`missing`, `malformed`, `unknown`, `revoked`, `unconfigured`). One sentence outward:
  `Invalid or revoked API key`. Never says which.
- [ ] `app/api/external/v1/global-master-list/route.ts` — `GET` only; authenticate → rate
  limit → read → filter → respond; **every** branch writes an `external_api_requests` row
  (ok, 401, 429, 500) with ip + user-agent + duration; `last_used_at` touched on success.
- [ ] `proxy.ts` — `/api/external/` passes the SSO gate; handler is the gate.

## Task 5 — admin management

- [ ] `app/api/admin/external-api-clients/route.ts` — `GET` list (+7-day call counts),
  `POST` create → `{ client, api_key }` (plaintext ONCE). `requireAdminSession()`.
- [ ] `app/api/admin/external-api-clients/[id]/route.ts` — `PATCH { action: revoke |
  restore | rotate | update }`; rotate returns the new plaintext once.
- [ ] `app/api/admin/external-api-clients/[id]/requests/route.ts` — newest N calls.
- [ ] `src/lib/audit/registry.ts` — family `external_api.` on `admin`.

## Task 6 — UI

- [ ] `src/components/admin/AdminExternalApiClients.tsx` — the "External access" section:
  client table (name · system · prefix · status · last used · 7d calls), New client dialog,
  key-shown-once panel with copy, Revoke/Restore, Rotate (confirm), Calls drawer.
- [ ] `src/components/admin/AdminApiKeys.tsx` — mounts it under the Anthropic card.

## Task 7 — verify

- [ ] `npm test` (new tests + registry source-scan), `npx tsc --noEmit`, `next build` if no dev
  server is running.

## Task 8 — document, one commit

- [ ] `docs/features/external-api-global-master-list.md`
- [ ] `docs/features/INDEX.md` — new row
- [ ] `docs/reference/api-reference.md` + `docs/reference/components.md` rows
- [ ] memory `external-api-gml-read-keys.md` + `MEMORY.md` pointer
- [ ] `docs/audits/audit-2026-09-16-session-log.md` § Open items — migration PENDING
