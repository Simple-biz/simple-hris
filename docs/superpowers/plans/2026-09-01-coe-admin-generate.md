# Accounting-initiated COE — "Generate COE" in the Signing Queue

**Date:** 2026-09-01 · **Approved:** Kane, same day (Q1: search active GML → generate → sign;
Q2: active people from the Global Master List only).

An accounting rep with **Accounting → Documents edit** searches an ACTIVE Global Master List
person, previews the same facts card the employee would see, and generates + signs the COE in one
action. The row is an ordinary `document_requests` COE row, so the employee finds the signed copy
in Profile → Request Documents and gets the `documents.signed` notification — nothing about
delivery is new.

Precedent: Termination Docs (`app/api/accounting/documents/termination/*`) for the admin-side
search/generate anatomy, and the existing `createCoeDocumentRequest` + `signDocumentRequest`
pair for the entire render/sign pipeline. Same `accounting/documents` feature key — a new key
defaults to `hidden` and vanishes the tab.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `src/lib/documents/coe-admin.ts` — pure rules: candidate fold (dedupe by work email,
      active-only via GML status, newest-upload display fields) + the POST-side active gate
      (fail CLOSED: status read error refuses, missing refuses, stamped refuses). Types for the
      search/preview/generate payloads. `coe-admin.test.ts` beside it (node:test).
- [x] 2. `src/lib/documents/coe-admin-search.ts` — server-only reads: `global_master_list`
      partial ILIKE passes over "Name" (tokens ANDed) / "Work Email" / "Personal Email"
      (no `.or()` — one `.ilike` per column, `escapeLikePattern`), all paged via
      `selectAllPaged`; `fetchGmlStatusMap()` supplies the active verdict; fold via task 1.
      Min-query + candidate cap both SPEAK (`tooShort` / `truncated`).
- [x] 3. `src/lib/documents/requests.ts` — `createCoeDocumentRequest` gains optional
      `{ actor?: { email }, notifyAccounting?: boolean }`. Defaults preserve the employee path
      byte-for-byte. With an actor: audit `user_name` = the ADMIN, `details.generated_for` =
      employee, role default 'Accounting'; `notifyAccounting: false` skips the self-ping.
- [x] 4. `app/api/accounting/documents/coe/search/route.ts` — GET ?q= (view gate, explicit
      third arg — `requireFeatureAccess` defaults to edit).
- [x] 5. `app/api/accounting/documents/coe/preview/route.ts` — GET ?email= (edit gate): active
      gate first, then `resolveCoeFacts`; 422 carries the blocked message + code.
- [x] 6. `app/api/accounting/documents/coe/route.ts` — POST { work_email } (edit gate), in
      order: active gate (fail closed) → duplicate pending COE check (409, names the existing
      row) → signature gate (412 BEFORE any row exists — mirrors the PATCH mapping) →
      `createCoeDocumentRequest` (actor = session, notifyAccounting false, disclosure note) →
      `signDocumentRequest` (session's own signature). A sign failure after create returns 200
      with `sign_error` — the pending row sits in the queue and the normal Approve path
      finishes it; that degradation is the design, not a bug.
- [x] 7. `src/components/accounting/GenerateCoeDialog.tsx` + a "Generate COE" toolbar button in
      `AccountingDocuments.tsx` (queue tab only, `canEdit` only). Dialog: search → pick →
      facts card → Generate & sign. 412 steers into the existing signature-capture dialog.
- [x] 8. Tests green (`node --import tsx --test`), typecheck/build — check for a live dev
      server first (`.next/` is shared).
- [x] 9. Docs, same commit: `docs/features/documents-tab.md` § "Accounting-generated COE",
      INDEX row update (Onboarding & documents), memory `coe-admin-generate` + MEMORY.md line
      + wikilink in the INDEX row.
- [x] 10. Stage by explicit path, one commit to main. Never push.

## Data

No migration. No new tables, columns, notification types, or feature keys.

## Pinned decisions

- **Active = the GML's own verdict** (`fetchGmlStatusMap`): any unstamped row carrying the work
  email counts active (a stamped duplicate never shadows the live row). A leaver still on the
  sheet through final-pay week therefore still qualifies — they are engaged until final pay,
  and `resolveCoeFacts` re-resolves every printed fact anyway.
- **Work email IDENTIFIES; name/personal email only SEARCH** (termination-docs G1). Candidates
  without a work email are dropped, and the POST accepts nothing but `work_email`.
- **The POST-side gate fails CLOSED**, unlike the Payment Catalog's keep-leaning guards: here a
  false "active" issues a certificate asserting current engagement — refusing is the cheap
  direction.
