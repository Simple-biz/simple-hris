# Gift Tracker → Submissions → Export CSV

**STATUS: APPROVED BY KANE 2026-09-22** — "ALL RECOMMENDATION PLEASE" against brief revision 1.
Four questions asked, all four answered with the recommendation.

A CSV export on HR → Gift Tracker → **Submissions**, at submission grain: one row per
submission actually on file, scoped to the filter pills + search the panel already has.

## What Kane ruled

| Q | Ruling | Consequence for the build |
|---|---|---|
| 1 | Recommendation — follow the view | `submissionsFilter` + `submissionsSearch` reach the builder; the panel's `filtered` array IS the export, in its on-screen order. The scope is stamped in the preamble. |
| 2 | Recommendation — CSV only | One button, no dropdown. No submission-grain PDF, no second workbook. |
| 3 | Recommendation — extend the SHARED record | `GiftSubmissionRecord` + the submission column list gain `Submitted At` and `Reviewer Note`, so the Roster export's XLSX sheet 2 gains them too and the two files stay structurally in step. |
| 4 | Recommendation — leave it out | No one-letter-recipient heuristic column. The bug belongs to `app/update-gift-address/page.tsx`, not to a reporting surface that would outlive it. |

## The two grains, and why both are correct

`docs/features/gift-tracker-shipping-export.md:31` is emphatic that the **Roster** export must
never be reduced to the submissions table — a person who never filled the form in is the finding,
and a submissions-only file hides that gap by omission.

This file is deliberately the other one. The Submissions sub-tab is a **work queue**: every row is
something somebody typed and somebody else must approve, reject or ship. Its export answers "what
did these people actually send us", which is a shipping-desk question, not a reconciliation
question. The danger is not that the two exist — it is that a future reader finds one of them and
"fixes" the other to match. Both docs must therefore name the other.

The roster export's XLSX sheet 2 ("All submissions") is the same grain and the same column
vocabulary; that is exactly why this build reuses `GiftSubmissionRecord` rather than inventing a
second one.

## Three rules this build must not break

1. **No price, ever.** `gift_price_php` / `gift_name` / `gift_catalog_item_id` are vestigial but
   hold live-looking values ([[gift-feature-info-only]]). They stay out of the input type and out
   of every column. The existing header-regex test is EXTENDED to the new CSV, not copied.
2. **Off-roster submitters are flagged, never dropped.** A submission whose `personal_email`
   matches no roster row prints `Off-roster` in Department and `-` for Work Email — the same
   convention the roster export already uses (`shipping-export.ts:495`). They are the likeliest
   mis-ship.
3. **The scope is stated, never implied.** The panel's filter defaults to **Pending**. An unstamped
   file would look like "all submissions" while holding a fraction of them, so the scope label is a
   preamble line, the button counts the rows it will write, and the summary line prints
   `N of TOTAL`.

## Tasks

- [ ] 1. `src/lib/gift-tracker/shipping-export.ts` — `GiftRosterSubmissionInput` gains OPTIONAL
      `created_at` + `decision_note` (optional so existing fixtures and the loose structural
      assignment keep working); `GiftSubmissionRecord` gains `firstSubmittedAt` + `reviewerNote`;
      `SUBMISSION_COLUMNS` is renamed `GIFT_SUBMISSION_COLUMNS`, exported, and gains the two
      headers; `SUBMISSION_COLUMN_WIDTHS` is filled out to match its column count (it was 14
      entries for 17 columns).
- [ ] 2. Same file — `buildGiftSubmissionsExport(...)` (pure, preserves caller order, never
      re-sorts), `giftSubmissionsToCsv(...)` (UTF-8 BOM, RFC-4180, six-line preamble),
      `downloadGiftSubmissionsCsv(...)`.
- [ ] 3. `src/lib/gift-tracker/shipping-export.test.ts` — order preserved · off-roster flagged ·
      identity counted on WORK email not the submission key · scope label + `N of TOTAL` ·
      no price header · the two new columns reach both outputs.
- [ ] 4. `src/components/orphanage/GiftTracker.tsx` — `SubmissionsPanel` toolbar gains an Export
      CSV button beside the search field, wrapped `data-readonly-allow` like the Roster toolbar.
- [ ] 5. `npx tsc --noEmit` + the module tests.
- [ ] 6. Docs: `gift-tracker-shipping-export.md` § Submissions export, INDEX row 39 invariant +
      wikilink, memory `gift-tracker-submissions-export` + `MEMORY.md` pointer. One commit,
      staged by explicit path.

## Deploy notes

**No migration.** No env var, no cron, no n8n, no route — the submissions are already loaded in
the tab and the download is an in-memory Blob, exactly like the Roster export.
