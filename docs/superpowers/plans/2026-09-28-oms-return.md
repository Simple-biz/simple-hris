# Orphanage step — "Send to OMS" (return the HRIS's figures to the Orphanage Management System)

**Brief:** in-session 2026-09-26 → 2026-09-28 (session `a3cfb82b`, audit item 235). Kane: *"a
button to send back to their System of all the data we have in the Orphanage Step … Emails,
Hours that were Regular and OT and the amount … the loading not to be in the button but in a
small modal pushing the data smoothly animated."* CONFLICT with `orphanage-oms-pull.md:161`
("OMS itself is read only") ruled **(b)** on 2026-09-28: *"i mean to OMS"*. Built under the
2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–6), one NEEDS left out (the OMS-side
table + grant + `OMS_RETURN_TABLE`).

**Stack:** Next.js app router, `@supabase/supabase-js` (server-only OMS client, reused),
`selectAllPaged`, `motion/react`, `node --import tsx --test`.

## Task 1 — the pure builder

- [ ] `src/lib/oms/oms-return.ts` — `buildOmsReturnRows({ orphanageAmounts, records, aliases,
  cycleLocked })` → `{ rows, totals, recordsWithoutAmount, verdictCounts }`. Rows come from the
  PAYING blob; the record supplies hours/split/rates; `reconcileLockedOrphanageAmount` supplies
  the verdict. A non-finite blob amount REFUSES the whole build (corrupt carrier), never skips.
  `parseOrphanageAmounts(blobValue)` reads the blob strictly. `cleanReturnAliases(raw)` accepts
  only email → email pairs (relabel, never money).
- [ ] `src/lib/oms/oms-return.test.ts` — amount = blob, never the record; hand-typed ⇒ hours null
  + `unverifiable`; record without amount ⇒ not sent, counted; alias relabels `work_email` only;
  non-finite amount refuses; totals sum the sent rows; ordering stable.

## Task 2 — config

- [ ] `src/lib/oms/oms-config.ts` — `readOmsReturnConfig(env)`: needs URL + key (shared) AND
  `OMS_RETURN_TABLE` (no default — a write never goes to a guessed table); identifier-checked,
  refused by variable name.
- [ ] `src/lib/oms/oms-config.test.ts` — unset table ⇒ not configured naming the variable; bad
  identifier refused; set ⇒ ok.

## Task 3 — server I/O

- [ ] `src/lib/supabase/orphanage-pay-db.ts` — `listOrphanagePayStrict(sourceFile)`: paged,
  THROWS on error (the existing `listOrphanagePay` returns `[]` on error, which would send a
  week as "no records").
- [ ] `src/lib/oms/oms-return-write.ts` — `probeOmsReturnTable` (count exact, no head),
  `insertOmsReturn` (ONE array insert = all or nothing), `latestOmsReturn(weekStart)` (paged,
  newest push_id).

## Task 4 — route

- [ ] `app/api/orphanage-pay/oms/return/route.ts`
  - `GET ?source_file=&week_start=` (`requireFeatureAccess view`): configured / tableReady /
    reason, the server-built preview, the newest send for the week.
  - `POST { source_file, week_start, aliases? }` (`requireFeatureEdit`): rebuild from the SAVED
    carriers, refuse an empty build, insert once, audit `wizard.orphanage_oms_returned` with the
    full payload.
- [ ] `src/lib/audit/registry.ts` — wizard family note += `orphanage_oms_returned`.

## Task 5 — UI

- [ ] `src/components/payroll/use-oms-return.ts` — open → GET (the modal shows the loading, not
  the button), send → POST, 15s/30s timeouts, non-JSON body named.
- [ ] `src/components/payroll/OrphanageOmsReturnDialog.tsx` — phases: preparing · ready
  (summary + warnings + last sent) · sending (rows stream HRIS → OMS, bar eases to ≤90% via
  `predictedProgress`) · sent (bar to 100%, checks stagger) · error (reason, rows back to queued,
  Retry). Not dismissable while sending. Reduced motion = crossfades.
- [ ] `src/components/payroll/OrphanageOmsPanel.tsx` — "Send to OMS" button (no spinner), LIVE
  only; aliases from the current pull.

## Task 6 — verify + document

- [ ] `npx tsc --noEmit`; `node --import tsx --test` on the new tests + oms tests + registry test.
- [ ] `orphanage-oms-pull.md` § Sending to OMS + rewrite :161/:169 + Deploy notes (OMS DDL,
  PENDING) · `orphanage-pay-step.md` UI bullet · INDEX row · `api-reference.md` ·
  `components.md` · `.env.example` · memory `orphanage-oms-pull` · Open items 235.
