# Accounting → Documents → Termination Docs

Approved brief: revision 3 (2026-08-31, Kane + Carla's answers). A new **inner tab** in the
existing Accounting → Documents surface. An accounting rep with `Accounting > Documents` **edit**
searches for someone who was offboarded, reviews a server-resolved facts sheet, fills any blanks,
and generates a **one-page PDF signed at generation with their own saved signature**. No email is
sent — the rep downloads it and replies from their own inbox. Every generated document is a
permanent, searchable log row.

Frozen implementation contract (17 new modules, verified signatures, guards G1–G9):
`docs/superpowers/plans/2026-08-31-termination-docs-contract.md`.

## The five decisions that shape everything

1. **Its own table, not a fifth `document_type`.** `document_requests` is request-shaped, and
   `GET /api/employee/documents` reads it via `from(TABLE)` where `TABLE` is the module-const
   literal `'document_requests'` (`src/lib/documents/requests.ts:32`). A separate table is the
   *proof* — not the policy — that a termination letter can never surface on an employee screen,
   including for a re-hire whose RBAC snapshot is restored.
2. **Prompt, never refuse.** The COE refuses on a missing fact because a wrong fact reaches a
   bank. Here a blank is the *normal* state of a 2023 leaver, so every missing fact becomes an
   input the rep fills. Refusals are reserved for things that make the document *false*:
   still-active, temporary-pause, no-departure-evidence, ambiguous identity, rehire-after-offboard,
   unrenderable name.
3. **Personal email SEARCHES; work email IDENTIFIES.** One personal inbox backs several master
   identities — `carla@simple.biz` (active) inherits `carlath@simple.biz`'s `resigned` stamp
   through a shared Gmail (`src/lib/roster/offboard-evidence.ts:41-48`). Keyed on personal email
   this feature would issue a termination letter for a working employee.
4. **Everything reversible, and the code is one commit.** 17 new files + 3 new directories + 1
   pre-existing file touched with **insertions only**, each block bracketed by
   `[TERMINATION-DOCS]`. The one irreversible act — the blank-only write-back into
   `global_master_list` — carries its own undo data on the document row and its own reverse script.
5. **Blanks-only write-back, three columns, never a rate.** `off_boarded_at`,
   `off_boarded_reason`, `"Start Date"`. A rep-supplied rate lives only on the document row:
   `employee_rate_history` and `employee_hourly_rates` are live pay paths, and a filled-in
   historical rate would silently re-price past weeks.

## Resolved risks (contract §8)

| # | Question | Ruling |
| --- | --- | --- |
| 1 | Write `"Department"` back? | **No.** Most-clobbered cell in the system — the next master sync reverts a DB-only edit — and it is display-only here. |
| 2 | Write rates back? | **No.** Decided at brief approval. Document row only. |
| 3 | Runtime kill switch? | **No.** The generic `POST /api/app-settings` gates only on `requireElevatedSession()` (admits `hr_coordinator`) and a `documents.*` key trips none of `isSensitiveKey`/`isAdminOnlyKey`, so the switch would be unaudited and HR-flippable. Revert = one `git revert` + two DB steps. Flagged to Kane. |
| 4 | Non-PHP payees | **Print the native currency.** `TerminationRate` already carries `currency`, the DDL carries `*_currency`, and the COE sets the precedent (a Colombian sees `$COP`). PHP-only would blank the rate for every USD/COP payee systematically. Blank only when no carrier held a value. |
| 5 | Hero header says "Signing queue" on both tabs | **Fixed with zero modified lines** — the whole existing body (`:390-841`) goes inside one `hidden` wrapper and the new panel renders its own header in the same anatomy. |
| 6 | Regenerate for the same person | **Allowed, with a confirm dialog naming the existing documents and their dates.** A permanent log records every generation. |
| 7 | `ambiguous_identity` adjudicator | **The rep**, from a candidate list showing dept / off-date / reason / active-flag. `candidateRowIds` is frozen into the snapshot. Never auto-picked. |
| 8 | Merged empty/no-match state | **Follow `ui-standards` §12.1/§12.2 in the new panel only.** |
| 9 | `.or()` on email values at `src/lib/anthropic/admin-tools.ts:1415` | **Live latent bug, out of scope.** Separate commit. This contract forbids `.or()` for email values everywhere. |

## Environment (verified, binding)

- **A dev server is LIVE** (PID 15540, `:3000`). **Never** `next build` / `next dev` — they share
  `.next/`. Verification is `npx tsc --noEmit` and `npm test` only.
- `npm test` = `node --import tsx --test "src/**/*.test.ts"` — a test outside `src/**` never runs.
- `tsconfig.tsbuildinfo` is **tracked** and already modified; `tsc` rewrites it. It must **not**
  enter the commit. Stage by explicit path; `git add -A` is forbidden (shared checkout).
- Branch `main`, HEAD `47ed47ef`, otherwise clean.

## Tasks

### 1. Foundation (must land before anything imports it)

- [ ] `src/lib/documents/termination/types.ts` — the whole shared type surface, verbatim from
      contract §2. **Pure and client-safe**: no `server-only`, no Supabase, no Node builtin.
      One definition of every field — deliberately unlike `CoePreviewFacts`, a hand-copied
      mirror nothing keeps in sync.
- [ ] `src/lib/documents/termination/reason-key.ts` — `reasonKey()`, the departure allowlist,
      and `escapeLikePattern()`. Reimplementations of module-private originals; do **not** export
      them from their home modules (that would be a modified pre-existing line).
- [ ] `src/lib/documents/termination/types.test.ts` + `reason-key.test.ts`

### 2. Data layer

- [ ] `references/sql/migrate/2026-08-31_termination_docs.sql` — `termination_documents`, five
      indexes, and five CHECKs that restate the guards as data (reason allowlist, both rates
      `> 0`, label `not like 'hsl:%'`, `termination_date > start_date`, currency set).
- [ ] `references/sql/fix/drop_termination_docs.sql` — the down-migration, with the
      run-the-reverse-script-first precondition and the storage prefix delete.
- [ ] `scripts/apply-termination-docs-migration.mts` — `--dry` rehearses in a rolled-back
      transaction, `--apply` commits, `--verify` re-checks. Kane runs it.
- [ ] `src/lib/documents/termination/termination-search.ts` — query → **set** of candidate work
      emails. Every `.ilike` escaped; `.or()` on an email value forbidden.
- [ ] `src/lib/documents/termination/termination-rates.ts` — starting/ending rate with a recorded
      `source`; native currency preserved; `0` is a blank, not a rate.
- [ ] `src/lib/documents/termination/termination-facts.ts` — the 3-arm resolver. Refusal order:
      no_master → ambiguous_identity → **still_active** → no_departure_evidence →
      **temporary_pause** → not_a_departure → rehire_after_offboard → bad_name.
- [ ] `src/lib/documents/termination/termination-log.ts` — the table, storage under a
      `termination/` prefix in the existing bucket, audit row.
- [ ] `src/lib/documents/termination/termination-writeback.ts` — blank-only guarded UPDATE
      (`.is(col, null)` in the filter, `.select('id')` on every update, zero rows = SKIP) and the
      `TerminationWritebackRecord` trail that `before: null` vs `before: ''` never collapses.

### 3. Renderer

- [ ] `src/lib/documents/termination/termination-document.ts` — one page, hard. Duplicates the
      COE's private typesetting closures; reuses `embedPdfFonts` / the logo module /
      `stampSignedDocument`'s signature scaling.
- [ ] `src/lib/documents/termination/termination-document.test.ts` — page count pinned at **both**
      the 1×1 PNG and the real 1944×184 full-height signature raster, plus a worst case. Copy
      `makePng` and its "the PNG helper produces something pdf-lib will actually embed" guard —
      without it a one-page pass can come from an image that silently failed to load. Assert
      `fonts.unicode === true` (a silent Helvetica fallback rewrites `₱` to `"PHP "`).

### 4. Routes (each gated exactly like its Documents sibling)

- [ ] `app/api/accounting/documents/termination/search/route.ts` — GET, `view`
- [ ] `app/api/accounting/documents/termination/facts/route.ts` — GET, `view`
- [ ] `app/api/accounting/documents/termination/route.ts` — GET log (`view`) · POST generate (`edit`)
- [ ] `app/api/accounting/documents/termination/[id]/route.ts` — GET download (`view`); **404**,
      not 403, for an unknown id

### 5. UI

- [ ] `src/components/accounting/termination-docs/TerminationDocsTabRow.tsx`
- [ ] `src/components/accounting/termination-docs/TerminationDocsPanel.tsx` — own header, search,
      candidate list, facts sheet with an input per blank, generate + confirm, the permanent log
      table, download.
- [ ] `src/components/accounting/AccountingDocuments.tsx` — **insertions only, 4 hunks, every
      block bracketed by `[TERMINATION-DOCS]`**: 2 imports after `:54`; the `docTab` state after
      `:91`; the tab row + `<div hidden>` open at `:389`; the wrapper close + panel mount before
      `:842`. The queue stays **mounted and hidden** so the signature dialog, the four confirm
      dialogs and every hook stay live on both tabs. **Do not reindent `:390-841`.** A
      `{cond && …}` wrap would change 452 unmarked lines and destroy the revert contract.

### 6. Revert

- [ ] `scripts/revert-termination-doc-writebacks.mts` — dry-run default. Backup to the
      **gitignored** `references/backups/` with a full ISO timestamp in the filename (a date-only
      name overwrites the first run of the day). Per record: re-read the column, proceed **only**
      if the current value still equals `record.after`, else SKIP and count it failed. Restore
      `before` exactly (`null` stays `null`, `''` stays `''`). Clear `field_writebacks` on success.
      Exit non-zero if anything was skipped.

### 7. Verify

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` clean
- [ ] Guard proofs G1–G9 each have a named test or a grep assertion
- [ ] `grep -n "\[TERMINATION-DOCS\]" src/components/accounting/AccountingDocuments.tsx` returns
      paired delete ranges
- [ ] `git diff --stat` on the one pre-existing code file shows **insertions only**

### 8. Document (same commit — a feature without its doc is unfinished)

- [ ] `docs/features/termination-docs.md` — rules, not a changelog. Must carry a
      `## Removal (one-shot)` section modelled on
      `docs/features/payroll-wizard-tutorial-mode.md:148-163`, including the negative inventory
      (no env var, no `app_settings` key, no cron, no n8n webhook, no notification type).
- [ ] `docs/features/INDEX.md` — **append** a new row; never edit the 4,947-character line 30.
- [ ] `docs/README.md` — one added row naming the `[TERMINATION-DOCS]` marker.
- [ ] `memory/termination-docs.md` + a `MEMORY.md` pointer at the top of the **Offboarding**
      domain. `MEMORY.md` truncates from the tail past ~24.4 KB / 200 lines — keep the hook under
      ~150 chars and re-check `wc -c` < 24400.
- [ ] One commit, staged by explicit path, `tsconfig.tsbuildinfo` excluded. Direct to `main`.
      **Never push.**
