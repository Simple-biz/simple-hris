# FROZEN IMPLEMENTATION CONTRACT — Termination Docs

`[TERMINATION-DOCS]` · Accounting → Documents → inner tab · contract frozen 2026-08-31 · read-only recon complete
Every signature below was re-verified against the file. Where two recon agents disagreed, §8 and the inline notes say which was wrong.

---

## 0. Verified environment

| Fact | Verified value | How |
|---|---|---|
| Branch | `main` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `47ed47ef fix(payroll): the double-pay guard was red because the TEST was wrong` | `git log --oneline -3` |
| Prior commits | `449f8d62`, `3bac1ff6` | same |
| Working tree | **NOT clean — exactly one modified file: `tsconfig.tsbuildinfo`** | `git status --porcelain` → ` M tsconfig.tsbuildinfo` |
| Untracked files | **none** | same |
| Is `tsconfig.tsbuildinfo` tracked? | **YES** (`git ls-files --error-unmatch` succeeds). It is NOT in `.gitignore`. | verified |
| Dev server | **LIVE.** PID **15540** LISTENING on `[::]:3000`, cmdline `"C:\Program Files\nodejs\node.exe" C:\Users\Kane\Desktop\simple-hris\node_modules\next\dist\server\lib\start-server.js` | `Get-NetTCPConnection -LocalPort 3000` |
| `.next/dev` last write | **8/31/2026 3:08:29 PM** (production `BUILD_ID` is stale: 8/10/2026 3:42:43 PM) | `Get-ChildItem .next -Force` |

**Hard consequences, binding on every code agent:**

1. **NEVER run `next build`, `npm run build`, `next dev`, or `npm run clean`.** A dev server owns `.next/`. Verification is `npx tsc --noEmit` and `npm test` only.
2. `npm test` = `node --import tsx --test "src/**/*.test.ts"` (`package.json:13`). **A test outside `src/**` never runs.** `npm run lint` = `tsc --noEmit` (`package.json:12`). There is **no eslint and no prettier config** in this repo — nothing will reformat your indentation, and nothing will flag it.
3. **`tsconfig.tsbuildinfo` must NOT enter the feature commit.** `tsc --noEmit` rewrites it. Stage by explicit path only. `git add -A` / `git add .` are forbidden (CLAUDE.md: shared checkout). Re-run `git status` immediately before the commit.
4. The session-start snapshot handed to the recon agents was stale (it showed HEAD `50c05777` and `?? scripts/audit-pay-structure-no-department.mts`). That script is now committed. **Plan against `47ed47ef`.**
5. No agent may run a Node script that touches Supabase. `.env.local` is PRODUCTION service-role.

---

## 1. File manifest

### 1a. Files to CREATE (17). All new → free to delete on revert.

| # | Path | Purpose | Est. lines |
|---|---|---|---|
| C1 | `src/lib/documents/termination/types.ts` | **Pure, client-safe.** All types in §2, all pure predicates, `TERMINATION_*` constants. No Supabase, no `server-only`. Both the client panel and every server module import from here — this is what prevents the `CoePreviewFacts` hand-copy drift hazard (`src/lib/documents/types.ts:41`). | ~230 |
| C2 | `src/lib/documents/termination/reason-key.ts` | **Pure, client-safe.** `reasonKey()` + `TERMINATION_DEPARTURE_REASONS` — byte-identical reimplementation of the module-private originals at `src/lib/payment-catalog/catalog-roster-visibility.ts:74` and `:80`. | ~40 |
| C3 | `src/lib/documents/termination/termination-search.ts` | `import 'server-only'`. Personal/work/alternate email → **set** of candidate work-email identities. | ~200 |
| C4 | `src/lib/documents/termination/termination-facts.ts` | `import 'server-only'`. `resolveTerminationFacts()` — the 3-arm result. Offboard-safe master read, arbitration, G2–G5. | ~420 |
| C5 | `src/lib/documents/termination/termination-rates.ts` | `import 'server-only'`. Starting-rate and ending-rate resolvers with recorded `source`. | ~260 |
| C6 | `src/lib/documents/termination/termination-document.ts` | PDF renderer. Duplicates the COE closure set (see §4). | ~380 |
| C7 | `src/lib/documents/termination/termination-log.ts` | `import 'server-only'`. `termination_documents` table + storage + audit. | ~280 |
| C8 | `src/lib/documents/termination/termination-writeback.ts` | `import 'server-only'`. Blank-only guarded UPDATE + writeback records. | ~200 |
| C9 | `src/lib/documents/termination/types.test.ts` | Pure-type/predicate tests (G2, G4, G7 blank predicate). | ~150 |
| C10 | `src/lib/documents/termination/reason-key.test.ts` | Parity with the private original's behaviour + the pollution corpus. | ~90 |
| C11 | `src/lib/documents/termination/termination-document.test.ts` | One-page pin ×2 signature fixtures + worst case. | ~230 |
| C12 | `app/api/accounting/documents/termination/route.ts` | `GET` log list · `POST` generate. | ~190 |
| C13 | `app/api/accounting/documents/termination/search/route.ts` | `GET ?q=` person search. | ~70 |
| C14 | `app/api/accounting/documents/termination/facts/route.ts` | `GET ?work_email=` facts sheet. | ~70 |
| C15 | `app/api/accounting/documents/termination/[id]/route.ts` | `GET` signed download URL. | ~70 |
| C16 | `src/components/accounting/termination-docs/TerminationDocsPanel.tsx` | The whole inner-tab UI. | ~700 |
| C17 | `src/components/accounting/termination-docs/TerminationDocsTabRow.tsx` | The two-pill tablist (mounted from `AccountingDocuments.tsx`). | ~70 |

### 1b. Non-code files to CREATE (5)

| # | Path | Notes |
|---|---|---|
| N1 | `references/sql/migrate/2026-08-31_termination_docs.sql` | Forward DDL (§3). Kane runs it in the Supabase SQL editor. |
| N2 | `references/sql/fix/drop_termination_docs.sql` | Down-migration (§3). Naming follows the only teardown precedent: `references/sql/fix/drop_manager_team_wallpapers.sql:7`, `references/sql/fix/drop_employee_hourly_rates_current_view.sql:8`. **Verified: `references/sql/` has exactly five subdirs — `alter create fix migrate seed`. There is no `drop/`, no `down/`, and no `supabase/migrations/`.** |
| N3 | `scripts/revert-termination-doc-writebacks.mts` | Reverse script, `--apply` gated (§7). |
| N4 | `docs/features/termination-docs.md` | Feature doc with a `## Removal (one-shot)` section modelled verbatim on `docs/features/payroll-wizard-tutorial-mode.md:148-163`. |
| N5 | `C:/Users/Kane/.claude/projects/c--Users-Kane-Desktop-simple-hris/memory/termination-docs.md` | Memory topic file. |

### 1c. Pre-existing files to EDIT — exactly THREE. Zero modified lines anywhere.

#### E1 — `src/components/accounting/AccountingDocuments.tsx` (1654 lines; **13 added lines, 0 modified**)

Verified structure (I re-read it; recon agent 7's claim that the queue body runs `:413→:1087` is **WRONG** — `:842` is the `</div>` that closes `<div className="w-full space-y-5">` at `:388`, `:844` opens the detail-modal comment, `:1086` closes the root div, `:1087` is the function's `}`. **Recon agent 5 was right.**)

```
:1    'use client';
:3-54 imports  (:54 is `} from '@/lib/documents/types';`)
:56   type Filter
:87-111  useState block  (:91 = `const [query, setQuery] = useState('');`)
:173  const openSignatureDialog = () => {
:384  const signingBlocked = !signature || !signature.enabled;
:386  return (
:387    root <div  … overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-amber-50/20 …>
:388      <div className="w-full space-y-5">
:390-411  header block   (:411 = `        </div>`)
:412      (blank line)
:413      {/* ── Signature manager ─── */}   … :501 `</section>`
:503      {/* ── KPIs ─── */}
:842      </div>                      ← closes `w-full space-y-5`
:844-1084 detail modal + 4 dialogs (all state-gated; DO NOT MOVE)
:1086   </div>
:1087 }
```

**Edit E1.1 — insert AFTER line 54** (3 lines):
```tsx
// [TERMINATION-DOCS]
import TerminationDocsTabRow from '@/components/accounting/termination-docs/TerminationDocsTabRow';
import TerminationDocsPanel from '@/components/accounting/termination-docs/TerminationDocsPanel'; // [TERMINATION-DOCS]
```

**Edit E1.2 — insert AFTER line 91** (2 lines):
```tsx
  // [TERMINATION-DOCS]
  const [docTab, setDocTab] = useState<'queue' | 'termination'>('queue'); // [TERMINATION-DOCS]
```

**Edit E1.3 — insert AT line 412** (the blank line between the header's `</div>` at `:411` and the signature-manager comment at `:413`) — **7 lines**:
```tsx
        {/* [TERMINATION-DOCS] */}
        <TerminationDocsTabRow value={docTab} onChange={setDocTab} />
        {docTab === 'termination' && (
          <TerminationDocsPanel canEdit={canEdit} sessionEmail={sessionEmail} signature={signature} signatureLoaded={signatureLoaded} onSetUpSignature={openSignatureDialog} />
        )}
        {/* Queue sections below are HIDDEN, not unmounted — the signature dialog, the four
            confirmation dialogs and every hook stay live on both tabs. [TERMINATION-DOCS] */}
        <div hidden={docTab !== 'queue'} className="space-y-5">{/* [TERMINATION-DOCS] */}
```

**Edit E1.4 — insert IMMEDIATELY BEFORE line 842** (`      </div>`) — **1 line**:
```tsx
        </div>{/* [TERMINATION-DOCS] */}
```

**Why `hidden` and not a `{cond && (…)}` wrap or an early `return`:**
- A `{docTab === 'queue' && (<> … </>)}` wrap reindents lines 413–841 (**429 lines**), producing 429 changed lines that carry no marker. That destroys the revert contract outright. **Forbidden.**
- An early `return` before `:386` would unmount the signature-capture `<Dialog open={sigDialogOpen}>` at `:1027`, breaking the auto-prompt effect at `:157-162` (which calls `openSignatureDialog()` and is exactly what the new tab needs). **Forbidden.**
- A plain block `<div hidden>` works: the UA rule `[hidden]{display:none}` applies to a block div. **Do NOT use `display: contents`** — `contents` overrides `[hidden]`, and it also makes the outer `space-y-5`'s `> * + *` selector target the wrapper instead of the sections, collapsing their spacing. The inner `space-y-5` restores exact current spacing.
- Accepted cost: the queue's `useLiveRefresh` (`:148-153`, 60 s poll on `document_requests`) keeps running while the Termination tab is open. This is the shipped precedent (memory `payroll-wizard-tab-persist`: wizard stays mounted + hidden).
- Accepted cost: lines 413–841 are now nested one level deeper than their indentation. No formatter exists to complain. **Do not reindent them.**

**Marker contract (binding):** every contiguous inserted block is bracketed by a `[TERMINATION-DOCS]` token on its **first** and **last** line, so that
```
grep -n "\[TERMINATION-DOCS\]" src/components/accounting/AccountingDocuments.tsx
```
returns the exact delete ranges in pairs. Per-line markers inside a JSX attribute list are syntactically impossible; the bracket rule is the operative form.

#### E2 — `docs/features/INDEX.md`

**APPEND A NEW ROW at the end of the table.** Do **not** edit line 30 (the "Onboarding & documents" row) — it is 4,947 characters on one line; surgical string editing there makes the revert a manual reconstruction instead of a whole-line delete. **1 added line.**
Format (from `:13` `| Surface | Docs | Memory | Key invariant |`, separator `:14` `|---|---|---|---|`): Surface plain text with `->` arrows · Docs = backticked bare filenames joined ` · ` · Memory = `[[wikilinks]]` with `.md` stripped · Key invariant = prose, `**bold**` rule, backticked identifiers.

#### E3 — `docs/README.md`

**One added row** in the features table (near the `documents-tab.md` row at `:89`). Row text must name the removal marker, matching `:79` ("removable via the `[WIZARD-TUTORIAL]` markers"). **1 added line.**

#### E4 (memory, outside the repo) — `MEMORY.md`

One pointer, inserted at the **TOP of the `**Offboarding**` domain (line 60)**, not appended. Format from line 1: `file.md — hook`, up to 3 per line joined ` · `, hook under ~150 chars. **Both caps truncate from the TAIL** (~24,400 bytes AND 200 lines, target ≤140); current 20,875 B / 94 lines. Verify with `wc -c` < 24400 and `wc -l` ≤ 140.

### 1d. Files that need ZERO edits — verified, do not touch

| File | Why |
|---|---|
| `src/App.tsx` | `:358-364` already renders `<AccountingDocuments sessionEmail={sessionEmail} canEdit={canEditAccountingTab('documents', roles, featurePerms)} />`. Both props already exist on the component (`:80-86`). |
| `src/lib/rbac/accounting-tabs.ts` | `documents` already at `:14` (`ACCOUNTING_TAB_IDS`) and `:33` (`TAB_TO_FEATURE`). |
| `src/lib/rbac/feature-permissions.ts` | `{ key: "documents", label: "Documents" }` already at `:23`. **Adding a new feature key would make the tab HIDDEN for every existing rep** (`resolveFeatureAccess` defaults `'hidden'` at `:161`; `provisionDashboardTabs` only backfills on a role GRANT). Reusing `documents` is the whole reason this is an inner tab. |
| `src/lib/rbac/view-tabs.ts` | `documents` already at `:40`. (Also: this array is DEAD for the accounting dashboard — `App.tsx:211` uses `allowedAccountingTabsForUser`.) |
| `src/lib/pages/visibility.ts` | `{ key: 'documents', label: 'Documents' }` already at `:117`. |
| `src/components/Sidebar.tsx` | `documents` already at `:71`. |
| `src/lib/supabase/audit-log.ts` | `NewAuditLog.action` is `AuditAction | string` (verified `:127`). No `documents.*` action is in the `AuditAction` union and none needs to be — `src/lib/documents/signatures.ts:89-94` proves it. **Do not extend the union.** |
| `src/lib/documents/types.ts` | Zero edits **because the log gets its own table**. Reusing `document_requests` would force edits at `:13`, `:15`, `:25`, `:33` AND leak into `GET /api/employee/documents`. **Forbidden.** |
| `src/lib/notifications/notification-views.ts` | No email, no notification. |
| `src/lib/documents/requests.ts` | Do **not** add a `table`/`type` option to `listDocumentRequests`. `TABLE` at `:32` is the only table name that code path can name; that literal is the leak proof (G8). |
| `src/lib/payment-catalog/catalog-roster-visibility.ts` | Do **not** export `reasonKey`/`DEPARTURE_REASONS`. Reimplement in C2 (an export is a modified pre-existing line for a 40-line copy). |
| `src/lib/supabase/hr-pending-employees.ts` | Do **not** export `escapeLikePattern`. Reimplement in C3. |
| `src/lib/documents/coe-facts.ts` / `coe-document.ts` | Never modify. C6 duplicates; C4 imports only the four public helpers named in §6. |

---

## 2. Types — copy-pasteable, canonical

### `src/lib/documents/termination/types.ts` (C1) — PURE, CLIENT-SAFE

```ts
/** [TERMINATION-DOCS]
 * Termination Docs — the whole shared type surface.
 *
 * PURE and CLIENT-SAFE by contract: no `server-only`, no Supabase import, no
 * Node builtin. The client panel AND every server module import from here, so
 * there is exactly ONE definition of every field — deliberately unlike
 * `src/lib/documents/types.ts:41 CoePreviewFacts`, which is a hand-copied
 * mirror of `CoeFacts` that nothing keeps in sync.
 */

/** Currencies a rate can be quoted in. Mirrors PayCurrency
 *  (src/lib/payment-catalog/pay-structure.ts:12) without importing the
 *  payment-catalog module into client code. */
export type TerminationCurrency = 'PHP' | 'USD' | 'COP';

/** Where a resolved rate came from. Recorded for audit, NEVER printed. */
export type TerminationRateSource =
  | 'hr_pending'          // hr_pending_employees.regular_rate — the hire rate
  | 'rate_history'        // employee_rate_history, non-1970, non-sync-authored
  | 'rate_history_baseline' // employee_rate_history effective_from = 1970-01-01
  | 'wizard_snapshot'     // app_settings payroll.wizard.final_pay.<file>
  | 'paystub_locked'      // paystub_dispatch_queue payload.rates_php.regular
  | 'disbursement_record' // disbursement_records.regular_rate_php
  | 'rate_history_as_of'  // resolveRateAsOfDate(history, offDate)
  | 'rep_supplied';       // the rep typed it into a blank

/** A rate on the document. `amount === null` means BLANK — the rep must fill it. */
export interface TerminationRate {
  amount: number | null;
  currency: TerminationCurrency;
  /** null only while amount is null and no carrier was consulted successfully. */
  source: TerminationRateSource | null;
  /** Why it is blank. null when amount !== null. */
  blankReason: TerminationBlankReason | null;
}

/** Every fact that can arrive empty and be filled by the rep. */
export type TerminationBlankField =
  | 'termination_date'
  | 'reason'
  | 'ending_department'
  | 'start_date'
  | 'starting_rate'
  | 'ending_rate';

export type TerminationBlankReason =
  | 'not_on_file'          // nothing in any carrier
  | 'date_failed_sanity'   // sanitizeOffboardDay() returned null (e.g. franm@'s 2027-04-20)
  | 'never_paid'           // no paid payment_dispatches row with a cycle_source_file
  | 'no_hire_record'       // no hr_pending_employees row (pre-digital-pipeline hire)
  | 'zero_rate'            // carrier held 0 — "a zero rate is not a rate"
  | 'non_php_payee'        // resolved currency is not PHP; the page prints PHP only
  | 'read_degraded';       // the carrier read returned an error

/** REFUSALS. The document is not generatable. `code` is machine-readable;
 *  `message` is written for an INTERNAL REP looking at someone else's record —
 *  never reuse the COE's employee-voice strings (coe-facts.ts:108). */
export type TerminationBlockedReason =
  | { code: 'no_master';            message: string }
  | { code: 'ambiguous_identity';   message: string; candidates: string[] }
  | { code: 'still_active';         message: string }
  | { code: 'no_departure_evidence';message: string }
  | { code: 'temporary_pause';      message: string }
  | { code: 'not_a_departure';      message: string; rawReason: string }
  | { code: 'rehire_after_offboard';message: string; offDate: string; startDate: string }
  | { code: 'bad_name';             message: string; rawName: string | null }
  | { code: 'evidence_read_failed'; message: string };

/** Which master row won the arbitration, and how. Audit only. */
export interface TerminationIdentity {
  /** THE identity. Lower-cased. Never a personal email. */
  workEmail: string;
  personalEmail: string | null;
  /** global_master_list.id of the row that supplied name/department/start_date. */
  masterRowId: string | null;
  /** true when that row sits on the CURRENT master_list_uploads upload. */
  onCurrentUpload: boolean;
  /** Every gml row id that carried this work email, newest-upload first. */
  candidateRowIds: string[];
  /** Which column the rep's query matched. */
  matchedColumn:
    | 'Work Email' | 'Personal Email' | 'Alternate Work Email' | 'Alternate Work Email 2'
    | 'offboarded_sheet.work_email' | 'offboarded_sheet.personal_email'
    | 'offboarding_queue.employee_work_email';
  /** Which source supplied the winning off-board date. */
  offDateSource: 'global_master_list' | 'offboarded_sheet' | 'offboarding_queue';
}

/** The facts sheet the server resolves and the rep reviews. */
export interface TerminationFacts {
  identity: TerminationIdentity;

  /** Legal name, composed like coeWorkerName: first middle last [+ extension].
   *  Nickname DROPPED on purpose. Never null — a null name is a `bad_name` block. */
  workerName: string;

  /** `YYYY-MM-DD`, or null = BLANK. Already through
   *  sanitizeOffboardDay(normalizeMasterDate(raw)). */
  terminationDate: string | null;
  /** e.g. "August 18, 2026". null iff terminationDate is null. */
  terminationDateLabel: string | null;

  /** Normalized departure key, guaranteed NOT 'temporary_pause'. null = BLANK. */
  reasonKey: TerminationDepartureReason | null;
  /** Human label via OFFBOARD_REASON_LABELS. null iff reasonKey is null. */
  reasonLabel: string | null;
  /** Exactly what the DB held, for the audit row. Never printed. */
  rawReason: string | null;

  /** RAW master `Department` cell — may be `hsl:intake_specialist` or `"A, B"`.
   *  Audit + rate resolution only. NEVER rendered. */
  endingDepartmentRaw: string | null;
  /** formatDeptLabel(endingDepartmentRaw). null = BLANK. This is what prints. */
  endingDepartmentLabel: string | null;

  /** `YYYY-MM-DD`, or null = BLANK. */
  startDate: string | null;
  startDateLabel: string | null;

  startingRate: TerminationRate;
  endingRate: TerminationRate;

  /** Which facts arrived empty. The panel renders an input for each. */
  blanks: TerminationBlankField[];

  /** Non-fatal degradation notes (a carrier read failed). Shown to the rep. */
  degraded: string[];
}

/** Departure reasons a termination document may state. This is
 *  VALID_OFFBOARD_REASONS minus 'temporary_pause' — G2, in the type system. */
export const TERMINATION_DEPARTURE_REASONS = [
  'ncns',
  'resigned',
  'end_of_contract',
  'performance',
  'attendance',
  'time_manipulation',
  'other',
] as const;
export type TerminationDepartureReason = (typeof TERMINATION_DEPARTURE_REASONS)[number];

export function isTerminationDepartureReason(
  v: string | null | undefined,
): v is TerminationDepartureReason {
  return !!v && (TERMINATION_DEPARTURE_REASONS as readonly string[]).includes(v);
}

/** 3-arm result. NEVER throws for a data problem — the COE contract
 *  (coe-facts.ts:116). */
export type TerminationFactsResult =
  | { facts: TerminationFacts; blocked: null; error: null }
  | { facts: null; blocked: TerminationBlockedReason; error: null }
  | { facts: null; blocked: null; error: string };

// ─── Search ─────────────────────────────────────────────────────────────────

/** One candidate identity from a rep's query. A personal email is NOT an
 *  identity — one inbox backs several master rows (carlathomas0112@gmail.com,
 *  mariaa@/mariaar@) — so search returns a SET the rep disambiguates. */
export interface TerminationSearchCandidate {
  workEmail: string | null;
  personalEmail: string | null;
  name: string | null;
  /** Display-safe: already through formatDeptLabel. */
  departmentLabel: string | null;
  /** Sanitized `YYYY-MM-DD`, or null (UNDATED). */
  offDate: string | null;
  rawReason: string | null;
  reasonLabel: string | null;
  matchedColumn: TerminationIdentity['matchedColumn'];
  /** fetchGmlStatusMap says this email is ACTIVE — G3 will refuse it. */
  active: boolean;
  /** Precomputed refusal so the row renders greyed with the real reason. */
  blockedCode: TerminationBlockedReason['code'] | null;
}

// ─── Stored row ─────────────────────────────────────────────────────────────

/** ONE reversible field write. `before` distinguishes NULL from '' — the
 *  reverse script must restore the exact prior state. */
export interface TerminationWritebackRecord {
  table: 'global_master_list';
  /** global_master_list.id — NEVER an email. One work email owns several rows. */
  rowId: string;
  /** Reproduce the DB identifier VERBATIM, quoting included: 'off_boarded_at',
   *  'off_boarded_reason', 'Start Date'. */
  column: TerminationWritebackColumn;
  before: null | '';
  after: string;
  appliedAt: string;
}

/** The ONLY three columns the write-back may ever touch. */
export const TERMINATION_WRITEBACK_COLUMNS = [
  'off_boarded_at',
  'off_boarded_reason',
  'Start Date',
] as const;
export type TerminationWritebackColumn = (typeof TERMINATION_WRITEBACK_COLUMNS)[number];

/** Row shape of `termination_documents`. Snake_case = DB column names verbatim. */
export interface TerminationDocumentRow {
  id: string;
  work_email: string;
  personal_email: string | null;
  master_row_id: string | null;
  worker_name: string;
  termination_date: string;           // DATE, 'YYYY-MM-DD'
  reason_key: TerminationDepartureReason;
  reason_label: string;
  ending_department_raw: string | null;
  ending_department_label: string;
  start_date: string | null;
  starting_rate: string | number | null;   // numeric → PostgREST may hand back a string
  starting_rate_currency: TerminationCurrency | null;
  starting_rate_source: TerminationRateSource | null;
  ending_rate: string | number | null;
  ending_rate_currency: TerminationCurrency | null;
  ending_rate_source: TerminationRateSource | null;
  facts: TerminationFacts;                       // jsonb — full snapshot
  filled_by_rep: TerminationBlankField[];        // text[]
  field_writebacks: TerminationWritebackRecord[];// jsonb
  generated_by: string;
  generated_by_name: string | null;
  generated_by_title: string | null;
  generated_at: string;
  file_path: string;
  file_name: string;
  file_size: number | null;
  created_at: string;
}

// ─── API bodies ─────────────────────────────────────────────────────────────

/** GET /api/accounting/documents/termination/search?q= */
export interface TerminationSearchResponse {
  candidates: TerminationSearchCandidate[];
  degraded: string[];
  error?: string;
}

/** GET /api/accounting/documents/termination/facts?work_email= */
export interface TerminationFactsResponse {
  facts: TerminationFacts | null;
  blocked: TerminationBlockedReason | null;
  error?: string;
}

/** POST /api/accounting/documents/termination */
export interface TerminationGenerateRequest {
  /** The IDENTITY. Must be a work email the search returned. */
  work_email: string;
  /** Only the blanks the rep filled. A key not in `facts.blanks` is REJECTED 400. */
  filled: {
    termination_date?: string;                  // 'YYYY-MM-DD'
    reason?: TerminationDepartureReason;
    ending_department?: string;
    start_date?: string;                        // 'YYYY-MM-DD'
    starting_rate?: number;
    ending_rate?: number;
  };
  /** Rep opted the blank-only write-back on for this generation. Default false. */
  write_back: boolean;
}

export interface TerminationGenerateResponse {
  row: TerminationDocumentRow | null;
  /** Immediately usable download URL, 3600 s TTL. */
  url: string | null;
  blocked: TerminationBlockedReason | null;
  /** What the write-back actually did — [] when write_back was false or all
   *  targets were already filled. */
  writebacks: TerminationWritebackRecord[];
  /** Targets skipped because the column was filled since selection. */
  writeback_skipped: Array<{ column: TerminationWritebackColumn; rowId: string; reason: string }>;
  error?: string;
}

/** GET /api/accounting/documents/termination (the permanent log) */
export interface TerminationLogResponse {
  rows: TerminationDocumentRow[];
  /** true when the page cap was hit — the caller must pass `before` to continue. */
  truncated: boolean;
  error?: string;
}

/** GET /api/accounting/documents/termination/[id] */
export interface TerminationFileResponse {
  url: string | null;
  error?: string;
}
```

### `src/lib/documents/termination/reason-key.ts` (C2)

```ts
/** [TERMINATION-DOCS]
 * `reasonKey` and the departure ALLOWLIST.
 *
 * Byte-identical reimplementation of the module-PRIVATE originals at
 * src/lib/payment-catalog/catalog-roster-visibility.ts:74 (DEPARTURE_REASONS)
 * and :80 (reasonKey). Verified private: neither is exported.
 * DO NOT invent a different normalizer — `off_boarded_reason` is free text with
 * NO CHECK constraint and holds both casings of every enum plus sheet-authored
 * labels (`Policy Violation`, `Declined Offer`, `Agent Passed Away`, `Active`)
 * and synthetic non-departures (`duplicate_cleanup` 94 rows, `sheet_sync` 2).
 * An ALLOWLIST is required by ruling; a denylist is forbidden.
 */
import { TERMINATION_DEPARTURE_REASONS } from './types';

export const TERMINATION_DEPARTURE_REASON_SET: ReadonlySet<string> = new Set(
  TERMINATION_DEPARTURE_REASONS,
);

export function reasonKey(raw: string | null | undefined): string | null {
  const k = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return k || null;
}

/** LIKE-escape for `.ilike()`. `_` is legal in an email local-part and ILIKE
 *  treats it as a single-char wildcard, so `a_b@x.com` can match `axb@x.com` —
 *  a DIFFERENT person. Copy of the private escaper at
 *  src/lib/supabase/hr-pending-employees.ts:714 (verified: not exported). */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}
```

---

## 3. DDL

### Forward — `references/sql/migrate/2026-08-31_termination_docs.sql` (N1)

```sql
-- [TERMINATION-DOCS]
-- Termination Docs — the permanent, searchable log of generated termination
-- letters, plus the reversal trail for the blank-only write-back.
--
-- Reversed by references/sql/fix/drop_termination_docs.sql. Run the reverse
-- script scripts/revert-termination-doc-writebacks.mts BEFORE the drop — the
-- undo data lives in this table's `field_writebacks` column.
--
-- NOT a `document_requests` row and NOT a new `document_type`. `document_requests`
-- is served to employees by GET /api/employee/documents via listDocumentRequests
-- (src/lib/documents/requests.ts:45-61, from(TABLE) where TABLE is the literal
-- 'document_requests' at :32). Keeping this in its own table is the leak proof.
--
-- Storage: reuses the EXISTING private bucket `document-requests`
-- (src/lib/documents/types.ts:108) under a distinct `termination/` prefix, so
-- no new bucket and no new storage policy migration is created — and revert is
-- a prefix delete that cannot touch a document_requests object.

create table if not exists public.termination_documents (
  id                      uuid        primary key default gen_random_uuid(),

  -- ── Identity (G1: work email IDENTIFIES) ──────────────────────────────────
  work_email              text        not null,
  personal_email          text,
  master_row_id           uuid,
  worker_name             text        not null,

  -- ── Printed facts ─────────────────────────────────────────────────────────
  termination_date        date        not null,
  reason_key              text        not null,
  reason_label            text        not null,
  ending_department_raw   text,
  ending_department_label text        not null,
  start_date              date,
  starting_rate           numeric(12,2),
  starting_rate_currency  text,
  starting_rate_source    text,
  ending_rate             numeric(12,2),
  ending_rate_currency    text,
  ending_rate_source      text,

  -- ── Provenance / reversal ─────────────────────────────────────────────────
  facts                   jsonb       not null default '{}'::jsonb,
  filled_by_rep           text[]      not null default '{}',
  field_writebacks        jsonb       not null default '[]'::jsonb,

  -- ── Signed at generation ──────────────────────────────────────────────────
  generated_by            text        not null,
  generated_by_name       text,
  generated_by_title      text,
  generated_at            timestamptz not null default now(),

  -- ── File ──────────────────────────────────────────────────────────────────
  file_path               text        not null,
  file_name               text        not null,
  file_size               integer,

  created_at              timestamptz not null default now(),

  -- G2 IN THE DATABASE: a suspension can never become a termination letter.
  -- Positive allowlist = VALID_OFFBOARD_REASONS (src/lib/hr/offboard-reasons.ts:11)
  -- minus 'temporary_pause'. A denylist is forbidden by ruling.
  constraint termination_documents_reason_key_check
    check (reason_key in ('ncns','resigned','end_of_contract','performance',
                          'attendance','time_manipulation','other')),

  -- No document may state a rate of zero.
  constraint termination_documents_starting_rate_positive
    check (starting_rate is null or starting_rate > 0),
  constraint termination_documents_ending_rate_positive
    check (ending_rate is null or ending_rate > 0),

  -- A raw hsl:* slug must never reach a human-readable column.
  constraint termination_documents_dept_label_not_slug
    check (ending_department_label not like 'hsl:%'),

  -- The re-hire guard, restated as data (G4).
  constraint termination_documents_off_after_start
    check (start_date is null or termination_date > start_date),

  constraint termination_documents_currency_check
    check (
      (starting_rate_currency is null or starting_rate_currency in ('PHP','USD','COP')) and
      (ending_rate_currency   is null or ending_rate_currency   in ('PHP','USD','COP'))
    )
);

comment on table public.termination_documents is
  '[TERMINATION-DOCS] Permanent log of generated termination letters. field_writebacks is the ONLY undo data for the blank-only write-back — run scripts/revert-termination-doc-writebacks.mts before dropping this table.';

-- Log search: by person, newest first.
create index if not exists termination_documents_work_email_idx
  on public.termination_documents (lower(work_email), generated_at desc);
-- G1: personal email SEARCHES.
create index if not exists termination_documents_personal_email_idx
  on public.termination_documents (lower(personal_email));
-- Default log ordering + keyset paging.
create index if not exists termination_documents_generated_at_idx
  on public.termination_documents (generated_at desc);
-- "what did this rep issue" audit queries.
create index if not exists termination_documents_generated_by_idx
  on public.termination_documents (lower(generated_by), generated_at desc);
-- Reverse-script scan: only rows that actually wrote something.
create index if not exists termination_documents_writebacks_idx
  on public.termination_documents using gin (field_writebacks);
```

**Column justification — every column earns its place:**

| Column | Justified by |
|---|---|
| `id` | storage path segment + the `[id]` download route + audit `resource_id`. |
| `work_email` | **G1** — the identity. Log search key. |
| `personal_email` | **G1** — searchable, never identifying. |
| `master_row_id` | **The write-back reverse is keyed on `global_master_list.id`, never an email** — one work email owns several rows (`app/api/hr/offboard/route.ts:170-171` stamps *every* active row). Without this, the revert can restore the wrong row. |
| `worker_name` | printed line 1. |
| `termination_date` | printed. `date` not `timestamptz`: a letter states a calendar day, and a timestamptz reintroduces the `new Date('YYYY-MM-DD')` UTC-midnight day-shift. |
| `reason_key` | printed + the CHECK that mechanises G2. |
| `reason_label` | printed verbatim; frozen so a later relabel in `OFFBOARD_REASON_LABELS` cannot retro-change what a signed document says. |
| `ending_department_raw` | audit + rate re-resolution (`computePersonComp` needs the raw label to hit the HSL SUB-team base rate before the parent collapse, `person-comp.ts:141-144`). Never printed. |
| `ending_department_label` | printed; the `not like 'hsl:%'` CHECK is the last line of defence. |
| `start_date` | drives the printed "starting rate" context + the `off_after_start` CHECK (G4). |
| `starting_rate` / `ending_rate` | printed (the `->` line). `numeric(12,2)` because every carrier is TEXT and must be parsed once, at write time. |
| `*_currency` | a rate without its currency is meaningless; COP/USD payees exist. |
| `*_source` | **audit only, never printed** — the COE precedent (`coe-facts.ts:100-101`). Tells a future auditor whether the ending rate came from the locked paystub or a history fallback. |
| `facts` (jsonb) | the full resolved snapshot at generation time. The rates sheet re-prices history silently (`employee_hourly_rates` rewritten in place, only 21/22,347 rows have `updated_at != created_at`), so without a frozen snapshot the document cannot be re-explained later. |
| `filled_by_rep` (text[]) | which facts a human supplied vs which the system resolved — the difference matters on a signed legal page. |
| `field_writebacks` (jsonb) | **the reverse script's ONLY input.** `audit_log` cannot hold it: `clearAuditLog()` (`src/lib/supabase/audit-log.ts:179`) truncates the whole table behind `DELETE /api/audit-log`, which is exactly why `bank_update_history` was split out (`references/sql/migrate/2026-07-01_bank_update_history.sql:5-17`). |
| `generated_by` / `_name` / `_title` | the signature is the rep's own; `generated_by` is the accountable actor and the caption on the PDF. |
| `generated_at` | printed + log ordering + keyset paging. |
| `file_path` / `file_name` / `file_size` | storage object address; `file_path` is the revert's delete list. |
| `created_at` | insertion time, distinct from `generated_at` (a retry could differ). |

**No `normalize_email_column` trigger.** `bank_update_history` uses one, but it is guarded by an `IF EXISTS` on `pg_proc` and would add a drop step to the down-migration. Freeze: lowercase in app code with `normEmail` before every insert and every query. The `lower()` indexes make reads case-safe regardless.

### Down — `references/sql/fix/drop_termination_docs.sql` (N2)

```sql
-- [TERMINATION-DOCS]
-- Revert: pair of references/sql/migrate/2026-08-31_termination_docs.sql.
--
-- PRECONDITION — run FIRST, or the field write-back becomes unreversible:
--   node --import tsx scripts/revert-termination-doc-writebacks.mts --apply
-- It reads public.termination_documents.field_writebacks, which this script
-- destroys. There is no other copy.
--
-- 0) PRE-CHECK — must return 0. A non-zero count means unreverted writebacks.
--    select count(*) from public.termination_documents
--     where jsonb_array_length(field_writebacks) > 0;

drop table if exists public.termination_documents cascade;

-- Storage objects are NOT dropped by the above. Remove them separately:
--   delete from storage.objects
--    where bucket_id = 'document-requests' and name like 'termination/%';
-- The `termination/` prefix is exclusive to this feature, so this cannot touch a
-- document_requests object (those are `<email-segment>/<id>/original.pdf`).
--
-- VERIFY
--   select to_regclass('public.termination_documents');            -- expect NULL
--   select count(*) from storage.objects
--    where bucket_id='document-requests' and name like 'termination/%'; -- expect 0
--
-- NOT DROPPED, deliberately: the `document-requests` bucket, `document_requests`,
-- `document_signatures`, and every audit_log row with action
-- 'documents.termination_generated' (the audit trail outlives the feature).
```

---

## 4. Module contracts

### C1 `types.ts` / C2 `reason-key.ts`
Full source in §2. **Must NOT import:** anything from `@/lib/supabase/*`, `@/lib/documents/coe-facts`, `@/lib/payment-catalog/*`, `next/*`, or any Node builtin. C1 may import nothing at all; C2 imports only `./types`. **These two must remain safe to import from a `'use client'` file** — the panel does.

### C3 `termination-search.ts`

```ts
import 'server-only';
export async function searchTerminationCandidates(
  query: string,
): Promise<{ candidates: TerminationSearchCandidate[]; degraded: string[]; error: string | null }>;
```
Imports (verified paths): `@/lib/supabase/server` (`createSupabaseServiceRoleClient`), `@/lib/supabase/select-all-paged` (`selectAllPaged`), `@/lib/email/norm-email` (`normEmail`), `@/lib/roster/master-date` (`normalizeMasterDate`), `@/lib/roster/offboard-date-sanity` (`sanitizeOffboardDay`), `@/lib/roster/gml-status` (`fetchGmlStatusMap`), `@/lib/hr/offboard-reasons` (`offboardReasonLabel`), `@/lib/departments/hsl-subdept` (`formatDeptLabel`), `./types`, `./reason-key`.

Algorithm (frozen):
1. `const q = normEmail(query)`; bail `{candidates:[],degraded:[],error:null}` on null.
2. `const pat = escapeLikePattern(q)`.
3 . `selectAllPaged` over `global_master_list`, select **verbatim**
   `'id,"Name","Work Email","Personal Email","Alternate Work Email","Alternate Work Email 2","Department","Start Date",off_boarded_at,off_boarded_reason,last_seen_upload_id'`,
   `.order('id', { ascending: true }).range(from, to)`. Run **one pass per email column** (four passes), each `.ilike('"<Column>"', pat)`.
4. Two more paged passes on `offboarded_sheet`: `.ilike('work_email', pat)` and `.ilike('personal_email', pat)`, select `'id,personal_email,work_email,name,department,start_date,off_boarded_at,off_boarded_reason,origin'`.
5. One paged pass on `offboarding_queue` `.eq('status','completed')` matching `employee_personal_email` then `employee_email` (**both hold personal addresses**), harvesting `employee_work_email` only.
6. Union candidates keyed on `normEmail(work_email)`. Rows with a null work email keep `workEmail: null` and carry `blockedCode: 'no_master'`.
7. `fetchGmlStatusMap()` once; stamp `active`. `sanitizeOffboardDay(normalizeMasterDate(raw))` for `offDate`. `formatDeptLabel` for `departmentLabel`. `reasonKey` + the allowlist to precompute `blockedCode`.
8. Every `selectAllPaged` `error` is pushed into `degraded` **and** returned; never swallowed.

**MUST NOT:** call `getEmployeeMasterRecord` (see §6). **MUST NOT** use PostgREST `.or(...)` for any email value.

### C4 `termination-facts.ts`

```ts
import 'server-only';
export async function resolveTerminationFacts(
  workEmail: string,
): Promise<TerminationFactsResult>;
```
Additional imports: `@/lib/roster/offboard-evidence` (`loadOffboardEvidenceByEmail`), `@/lib/name/name-parts` (`parseNameParts`), `@/lib/documents/coe-facts` (`formatCoeStartDate` ONLY), `./termination-rates`.

Frozen order — first refusal wins:
1. Offboard-safe master read: paged `global_master_list` on `"Work Email" ILIKE escapeLikePattern(norm)`, **NO `off_boarded_at` filter**. Zero rows → `no_master`.
2. Arbitrate: read the current upload id from `master_list_uploads where is_current = true`; the row with `last_seen_upload_id === currentUploadId` wins for `Name`/`Department`/`Start Date`/alternates ("PROMOTION", `src/lib/roster/recently-offboarded.ts:497-520`); if none is on the current upload, the highest `last_seen_upload_id` wins. Record every candidate id.
3. `fetchGmlStatusMap()` → `active === true` ⇒ **`still_active`** (G3).
4. `loadOffboardEvidenceByEmail('work')` — **`'work'` is not optional** (G1). No entry ⇒ `no_departure_evidence`. **Note the verified signature returns `Promise<Map<…>>` with NO error channel and every source read is `.catch(() => {})`** — so "no entry" can mean "the read broke". Cross-check: if the arbitrated master row itself carries `off_boarded_at`, use it; if neither the map nor any master row nor `offboarded_sheet` has anything, and any read errored, return **`evidence_read_failed`**, not `no_departure_evidence`.
5. `const k = reasonKey(evidence.reason)`. `k === 'temporary_pause'` ⇒ **`temporary_pause`** (G2). `k !== null && !TERMINATION_DEPARTURE_REASON_SET.has(k)` ⇒ **`not_a_departure`** with `rawReason`. `k === null` ⇒ reason is a **BLANK** (fillable), permitted only because step 4 proved a departure stamp exists.
6. Name: `parseNameParts(master.Name)` → join `[first, middle, last]` + `extension`, collapse whitespace. Refuse on `!composed || /[,"“”]/.test(composed)` ⇒ **`bad_name`**. **Additional refusal the COE lacks (recon 1's proven hole): also refuse when `composed.includes('@')`** — `parseNameParts` returns an `@`-address parked in the Name column whole in `first` (`name-parts.ts:163`) and it passes the comma/quote guard, so `jasminec@simple.biz` would print as the legal name.
7. `offDate = sanitizeOffboardDay(normalizeMasterDate(rawOff))`. null ⇒ `terminationDate` is a **BLANK** with `blankReason: 'date_failed_sanity'`. **`loadOffboardEvidenceByEmail` does NOT sanitize** — it only runs `normalizeMasterDate` (`offboard-evidence.ts:81`) — which is how `franm@`'s hand-typed `2027-04-20` rides through. Sanitizing here is mandatory.
8. `startDate = normalizeMasterDate(master['Start Date'])`. If both dates resolve and `offDate <= startDate` ⇒ **`rehire_after_offboard`** (G4).
9. Department: keep raw; `formatDeptLabel(raw)` for the label; blank when raw is empty.
10. `resolveTerminationRates(...)` from C5.
11. Assemble `blanks[]` from every null-valued printed fact.

**MUST NOT:** print `master.department` raw (the COE bug at `coe-facts.ts:237,380`). **MUST NOT** reuse the COE's employee-voice `message` strings. **MUST NOT** print bonus lines — `isDeptEligible` fails OPEN on a null deptKey (`src/lib/payment-catalog/system-bonus.ts:207`), so an unresolvable leaver appears to qualify for PAB/Tech.

### C5 `termination-rates.ts`

```ts
import 'server-only';
export async function resolveTerminationRates(args: {
  workEmail: string;
  aliases: string[];
  departmentRaw: string | null;
  offDate: string | null;
}): Promise<{ starting: TerminationRate; ending: TerminationRate; degraded: string[] }>;
```

**Starting rate**, first hit wins:
1. `hr_pending_employees` — paged, `.ilike('work_email', pat)` then `.ilike('personal_email', pat)`. `parseRateText(row.regular_rate)` (**TEXT column**). `source: 'hr_pending'`. **The row survives promotion** — `setHrPromotionOutcome` (`hr-pending-employees.ts:1147`) only UPDATEs status. **Never call `listHrPendingEmployees()`** — it is `.range(0, 1999)` with no paging (`:265`).
2. `employee_rate_history` — select **exactly** `'employee_email, regular_rate, ot_rate, effective_from, note, created_by'`, `.in('employee_email', aliases)`, paged. Drop rows where `effective_from` starts `'1970'` OR `created_by === 'GSheets Sync'` (the literal `SYNC_HISTORY_AUTHOR`, `src/lib/supabase/rates-upload-db.ts:14`) OR `created_by === 'system'`. Earliest remaining `effective_from` wins. `source: 'rate_history'`.
3. The 1970 baseline row, if one exists → `source: 'rate_history_baseline'`.
4. Otherwise **BLANK**, `blankReason: 'no_hire_record'`.

**Ending rate**, first hit wins:
1. `listPaymentDispatches({ recipientEmail: workEmail })`; keep `r.status === 'paid' && r.cycle_source_file && r.payee_type !== 'contractor'` (the exact filter at `app/api/employee/paystub/route.ts:911-913`); take max `sent_date`.
2. `getFreshPaystubEntry(sourceFile, workEmail)` → `mapPayloadToPayStub(payload, payPeriod).mfRate`. Source is `'wizard_snapshot'` when `refreshed === true`, else `'paystub_locked'`. If `staleRateSnapshot === true`, push a `degraded` note.
3. `disbursement_records` for the same `source_file` + `recipient_email` → `parseRateText(String(regular_rate_php))`. `source: 'disbursement_record'`.
4. `resolveRateAsOfDate(buildRateHistoryByEmail(rows), offDate)` → `source: 'rate_history_as_of'`.
5. No paid week at all ⇒ **BLANK**, `blankReason: 'never_paid'`.

Both rates: **`amount === 0` is BLANK with `blankReason: 'zero_rate'`** — "a zero rate is not a rate" lives in the document layer, not the shared resolver (`coe-facts.ts:322-335`); `computePersonComp` treats a stored 0 as present. Currency is `'PHP'` for every carrier above (rate history, `hr_pending_employees` and `rates_php` are PHP by construction). If a `winningRate(computePersonComp(...))` cross-check reports `USD`/`COP`, return **BLANK** with `blankReason: 'non_php_payee'` and let the rep type it.

**MUST NOT:** read `employee_hourly_rates.updated_at` to date anything (`updateEmployeeRates` rewrites `"Regular Rate"` in place with no stamp, `employee-hourly-rates.ts:389-392`; only 21/22,347 rows differ). **MUST NOT** copy the column names from `scripts/find-email-everywhere.mjs:51` — `["work_email","email"]` are **both wrong**, the column is `employee_email`, and the script swallows the 42703 at `:78`. **MUST NOT** treat an absent history row as evidence of a flat rate — the sheet sync wrote no history for years.

### C6 `termination-document.ts`

```ts
export interface TerminationRenderParams {
  facts: TerminationFacts;
  documentId: string;
  generatedAtIso: string;
  signature: { dataUrl: string; name: string; title: string; email: string; signedAtIso: string };
}
export async function renderTerminationDocument(p: TerminationRenderParams): Promise<Uint8Array>;
export const __terminationInternals: { formatTerminationRate: (n: number, c: TerminationCurrency) => string };
```
`signature` is **required, not optional** — the document is signed at generation.

Imports: `pdf-lib` (`PDFDocument`, `rgb`, type `PDFFont`, `PDFPage`), `@/lib/pdf/fonts` (`embedPdfFonts`), `@/lib/pdf/logo` (`embedSimpleLogo`, `simpleLogoWidthForHeight`), `@/lib/documents/coe-document` (`__coeInternals` — `formatDotDate`, `wrapText`, `trackedWidth` are the **only three** importable helpers), `./types`.

**Duplicate, do not import:** `text`, `tracked`, `rule`, `richParagraph`, `sectionLabel`, `leaderRow`, `ensureSpace` are **closures inside `renderCoeDocument`** (`coe-document.ts:171-331`) over `let page`, `let y`, `doc`, `{regular,bold,sanitize}`. They are unreachable by import. Duplication is the shipped precedent — `sign-pdf.ts` already re-implements `text()`, its own wrap loop, and `dataUrlToBytes`. Also duplicate: `dataUrlToBytes` (regex `/^data:([^;,]+);base64,(.+)$/`), the layout constants (`PAGE_W 612`, `PAGE_H 792`, `MARGIN 64`, `CONTENT_W 484`, `BOTTOM_LIMIT MARGIN+14`, `BODY_SIZE 10.5`, `BODY_LEADING 16.5`), the colour set, and **`formatCoeRate`** — it is **private** at `coe-facts.ts:141` (verified) and is the only formatter that always shows cents. `₱225` vs `₱225.50` must not collapse on a start→end rate line, so the exported `formatCoeMoney` is wrong here.

Hard rules:
- `embedPdfFonts(doc)` and `embedSimpleLogo(doc)` **exactly once per document** (`fonts.ts:105-107`: a second call duplicates ~70 KB).
- **Every** string handed to `drawText` goes through `fonts.sanitize()` — pdf-lib THROWS on an unencodable glyph.
- Signature scale: `Math.min(maxW / img.width, maxH / img.height, 1)` with `maxH <= 58`. The trailing `1` is the never-upscale clamp; `TYPED_EXPORT_HEIGHT = 160` (`signature-render.ts:33`) sits above both existing caps so typed signatures always downscale. If you introduce a third cap, add it to `PDF_SIGNATURE_MAX_HEIGHTS` (`:118`) and its pinning test.
- **Do NOT route through `stampSignedDocument`** — it re-embeds fonts+logo into already-embedded bytes (~184 KB vs ~97 KB, `docs/features/documents-tab.md:220-224`). One page, signature drawn in.
- `embedSimpleLogo` may return `null`; fall back to drawing "Simple" as type. Never `assert(logo)`.
- **Add every new fixed prose sentence to the `SAMPLES` array in `src/lib/pdf/fonts.test.ts:70-80`.** fontkit applies the `liga` GSUB feature; a pruned ligature renders as a blank gap with the full 602-unit advance — that is how "Certifi cate of Engagement" shipped. Words at risk in this feature's prose: *effective, offboarded, official, certifies, notification, classification, staff, differential*. No sanitiser test catches this. **Do not regenerate the font subset** — the charset already covers everything.
- Date-only values: `formatCoeStartDate` (`coe-facts.ts:152`) parses parts into a **local** Date. `new Date('2026-08-18')` is UTC midnight and reads as Aug 17 in Manila.

### C7 `termination-log.ts`

```ts
import 'server-only';
export async function createTerminationDocument(params: {
  facts: TerminationFacts;
  filled: TerminationBlankField[];
  bytes: Uint8Array;
  generatedBy: string; generatedByName: string | null; generatedByTitle: string | null;
  generatedAtIso: string;
  documentId: string;
  writebacks: TerminationWritebackRecord[];
}): Promise<{ row: TerminationDocumentRow | null; error: string | null }>;

export async function listTerminationDocuments(opts?: {
  query?: string; before?: string; limit?: number;
}): Promise<{ rows: TerminationDocumentRow[]; truncated: boolean; error: string | null }>;

export async function getTerminationDocumentById(
  id: string,
): Promise<{ row: TerminationDocumentRow | null; error: string | null }>;

export async function signedUrlForTerminationDocument(
  row: TerminationDocumentRow,
): Promise<{ url: string | null; error: string | null }>;
```
`const TABLE = 'termination_documents';` — a **module const literal**, never a parameter (G8).

Storage path (frozen): `` `termination/${emailPathSegment(workEmail)}/${id}/termination.pdf` `` in `DOCUMENT_REQUESTS_BUCKET`. Duplicate `emailPathSegment` (3 lines, private at `requests.ts:35`): `(email || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_')` — lowercase FIRST, then strip.
Upload: `{ contentType: 'application/pdf', upsert: false }`. On a failed row insert, `.remove([filePath]).catch(() => {})`.
Signed URL: `createSignedUrl(path, 3600, { download: fileName })`.

Audit (one row, action string `'documents.termination_generated'`, resource `'termination_documents'`, `resource_id: row.id`). Follows the **two**-dot-segment `documents.<noun>_<verb>` convention, NOT the three-segment `hr.*` one. **Departure from the documents precedent, mandatory:** the existing documents audit writes are all fire-and-forget `void (async () => …)()` with `{error}` discarded. Here the audit insert is **awaited and its error surfaced** — the feature's "permanent log" is the `termination_documents` row, and its insert error must abort the generation, never be swallowed.

`listTerminationDocuments`: paged with `selectAllPaged` or explicit keyset paging on `generated_at desc, id desc`; **never a bare `.limit(200)`**. PostgREST truncates at 1000 rows even with `.range()`.

### C8 `termination-writeback.ts`

```ts
import 'server-only';
export async function applyTerminationWriteBack(args: {
  masterRowId: string;
  values: Partial<Record<TerminationWritebackColumn, string>>;
  actorEmail: string;
}): Promise<{
  applied: TerminationWritebackRecord[];
  skipped: Array<{ column: TerminationWritebackColumn; rowId: string; reason: string }>;
  error: string | null;
}>;

/** PURE — lives in C1, re-exported here for the tests. */
export function isBlankCell(v: unknown): boolean; // String(v ?? '').trim() === ''
```

Per column, in this exact order:
1. Guarded UPDATE: `.update({ [col]: value }).eq('id', masterRowId).is(col, null).select('id')`.
   `.select()` is **mandatory** — a guard-filtered UPDATE matching zero rows returns `{ data: [], error: null }`; without `.select()` it reports success while writing nothing.
2. `data.length === 1` ⇒ record `{ before: null, after: value }`. Done.
3. `data.length === 0` ⇒ **two-phase empty-string handling** (`.is(col,null)` cannot express `col = ''`, and these text columns genuinely hold `''` — hence the SQL-side `COALESCE(NULLIF(TRIM(x),''), old)` at `references/sql/seed/seed_global_master_list_addresses.sql:1052`): re-read the single row `select('id, "<col>"').eq('id', masterRowId).maybeSingle()`. If `isBlankCell(cur[col])`, fire ONE unguarded retry `.update(...).eq('id', masterRowId).select('id')` and record `{ before: '', after: value }`. Otherwise **SKIP** with reason `` `filled since selection ('${cur[col]}')` ``. This is the only precedent that closes the hole: `scripts/seed-hurupay-higlobe-emails.mjs:493-518`.
4. **Never widen the guard to an unfiltered `.eq('id', …)` to make a skip go away.**

**MUST NOT touch, ever:** `employee_rate_history`, `employee_hourly_rates`, `payment_catalog_pay_structures`, `paystub_dispatch_queue`, `disbursement_records`, `app_settings`, `offboarded_sheet`, `offboarding_queue`, or `global_master_list."Department"`. Both rate tables are live pay paths — `insertRateHistoryRow` persists `effective_from` verbatim and both engines prorate per-day from it (`rate-history.ts:57-71`), so a "filled-in starting rate" silently re-prices historical weeks. `"Department"` is excluded because it is the most-clobbered cell in the system (memory `transfer-sheet-sync-false-success`, `hris-is-dept-source-of-truth`) and it is a display-only fact here.

**MUST NOT** call `updateMasterListProfile` — verified: it returns `{ok:false, code:'not_found'}` when `off_boarded_at` is set (`master-list-profile.ts:172`) and its UPDATE carries `.is('off_boarded_at', null)` (`:257`). Every subject of this feature is offboarded, so it fails 100% of the time.

**Do NOT** store a supabase update builder in a variable and chain `.is()` onto it in a loop — TypeScript hits "excessively deep instantiation" (`src/lib/contractor/contractor-dispatch-queue.ts:151-153`). Chain inline, at most twice.

### C12–C15 Routes — frozen shape

Every route module opens with:
```ts
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
```
(`runtime = 'nodejs'` is not optional — pdf-lib and the service-role client need it, and omitting it fails at build time with no obvious error.)

Gates, matching the sibling Documents routes exactly:
- `GET` (search, facts, log list, file) → `await requireFeatureAccess('accounting', 'documents', 'view')` — **the third argument is mandatory; it defaults to `'edit'`** (`authorize-feature.ts:52`), which would 403 view-only reps.
- `POST` (generate) → `await requireFeatureEdit('accounting', 'documents')`.
- Both: `if (!authz.ok) return deniedResponse(authz);` and nothing else. Never call `deniedResponse` on the ok branch (it 500s).
- **Do NOT use `requireElevatedSession()`** even though the nearest offboarded-list precedent does (`app/api/hr/offboard-history/route.ts:32`) — it admits `hr_coordinator`.
- Actor is always `authz.sessionEmail`, **never a body field**.

`POST` status mapping (frozen, mirroring `app/api/accounting/documents/[id]/route.ts:70-76`):
| Condition | Status |
|---|---|
| missing/invalid `work_email` | 400 |
| a `filled` key not present in `facts.blanks` | 400 |
| `blocked` returned | **409**, body `{ blocked, error: blocked.message }` |
| error message includes `'No saved signature'` or `'switched off'` | **412** — reproduce those substrings **verbatim** (`requests.ts:332`, `:335`); the UI's steer-into-capture-dialog behaviour is a substring match at `[id]/route.ts:73` |
| anything else | 500 |

Signature load: `getDocumentSignature(authz.sessionEmail)` → **check `error` first** (a null row with `error: 'Supabase not configured'` is a config failure, not a missing signature), then `!row` → throw `'No saved signature — draw and save your signature in the Documents tab first'`, then `!row.enabled` → throw `'Your signature is switched off — turn it back on to sign documents'`.

### C16/C17 UI — frozen conventions

`import { motion, useReducedMotion } from 'motion/react';` — **never `framer-motion`**.
`layoutId="terminationDocsTabPill"` — `offboardTabPill` and `catalogTabPill` are taken; `layoutId` is a global shared-element key.
`transition={{ duration: reduce ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}` with `const reduce = useReducedMotion();` (ui-standards §11.1; both shipped precedents ship an ungated spring — the doc is the tighter rule).

Tablist (C17) — **`role="tablist"` and `role="tab"` are mandatory**: the whole tab renders inside `<ReadOnlyTab>` (`src/App.tsx:322-327`), whose capture listener swallows clicks unless the target matches `ALLOW_SELECTOR` (`ReadOnlyTab.tsx:45-51`), which exempts `[role="tab"]`/`[role="tablist"]`. Without them a view-only rep cannot switch tabs. **`role="tabpanel"` is deliberately NOT exempted — do not add it to unblock the pane.**

Search box in C16: keep the word **"Search"** in both `placeholder` and `aria-label`, or add `data-readonly-allow` — that heuristic (`ReadOnlyTab.tsx:56-66`) is what keeps it typeable for view-only reps.

Dialogs are portaled outside `ReadOnlyTab`, so **every mutating control inside a dialog is independently gated on `canEdit`.**

Any `p-0` dialog (the PDF preview) **must** carry, per `docs/design/responsive-design.md:95-110` and verified against `components/ui/dialog.tsx:55` (`grid … gap-4 … sm:max-w-sm`, **no max-height**):
`flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[min(820px,calc(100%-1.5rem))] flex-col gap-0 overflow-hidden p-0 sm:max-h-[92dvh] sm:max-w-[min(820px,calc(100%-4rem))]` + `shrink-0` chrome + `min-h-0 flex-1 overflow-y-auto overscroll-contain` body. Reference: `src/components/employee/GiftShippingCard.tsx:494-497`, `:769`. Do **not** copy `DocumentDetailDialog`'s inline `style={{ maxHeight: 'min(92vh, 900px)' }}` — `vh`, not `dvh`. Use `blob:` URLs for the iframe preview (`AccountingDocuments.tsx:1230-1269`); a `Content-Disposition: attachment` signed URL downloads instead of painting.

Orange palette (copy verbatim from `AccountingDocuments.tsx`): panel border `border-orange-100/80 dark:border-orange-950/40` · header tint `bg-orange-50/40 dark:bg-orange-950/20` · thead tint `bg-orange-50/30 dark:bg-orange-950/10` · row hover `hover:bg-orange-50/40 dark:hover:bg-orange-950/10` · divider `divide-orange-100/70 dark:divide-orange-950/40` · eyebrow `text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300` · primary CTA `bg-orange-500 text-white hover:bg-orange-600` · outline CTA `border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300` · input focus `focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20` · pill indicator `bg-gradient-to-r from-orange-500 to-amber-500 shadow-sm` (matches the in-file `PaneButton` at `:1553`) · shimmer `animate-pulse … motion-reduce:animate-none` (mandatory) · full-bleed table Card needs **`py-0`** (`components/ui/card.tsx:15` base is `py-4`).
**Amber is caution/warning only** — never an amber chip or border to mean "termination"; amber-as-gradient-partner is fine.
`useLiveRefresh` channel base must be `'accounting-termination-docs'`, not `'accounting-documents'`.
`DocStat`/`STAT_PALETTE`/`STATUS_STYLE`/`PaneButton` are **file-private** in `AccountingDocuments.tsx` — duplicate the tile in C16 from the palette values in §Recon; do **not** add an `export` (that is a modified pre-existing line).
`@/components/ui/*` resolves to the **repo-root** `components/ui/*` (`tsconfig.json:27-29`); every other `@/…` resolves under `src/`.

---

## 5. Guards — mechanical assertions

### G1 — Personal email SEARCHES; work email IDENTIFIES. **UNMISSABLE.**

**Assertion:** no code path may derive off-board evidence, a rate, a paystub, or a printed fact from a personal email. A personal email is only ever an argument to search, and search only ever yields a **set** of candidate work emails.

**Mechanism:**
- `searchTerminationCandidates` returns `TerminationSearchCandidate[]`; `resolveTerminationFacts` takes exactly one argument, `workEmail: string`, and never sees the rep's raw query.
- `loadOffboardEvidenceByEmail('work')` — the argument is **required at the call site by convention and by test**. Under `'work'` only `global_master_list."Work Email"`, `offboarded_sheet.work_email` and `offboarding_queue.employee_work_email` are indexed (`offboard-evidence.ts:74`, `:120`, `:133`, `:151-152`).
- `paystub_dispatch_queue` is matched `.eq('recipient_email', norm(email))` — exact, work email only (`paystub-dispatch-queue.ts:230`, `:260`).
- Every `.ilike` on an email passes through `escapeLikePattern` (C2). Unescaped, `_` is an ILIKE single-char wildcard: `a_b@x.com` matches `axb@x.com`. `coe-facts.ts:191` has this bug — **do not inherit it.**
- The `>1 candidate work email` case is `blocked: { code: 'ambiguous_identity', candidates }`; **never auto-pick**.

**Test:** `termination-facts` unit test with a fixture where two master rows share one personal email (the documented `carla@simple.biz` / `carlath@simple.biz` cross-wire via `carlathomas0112@gmail.com`, `offboard-evidence.ts:41-48`) and only `carlath@` is stamped. Assert: searching the shared gmail returns **two** candidates; `carla@` carries `active: true`; `resolveTerminationFacts('carla@simple.biz')` returns `blocked.code === 'still_active'`; and `resolveTerminationFacts('carlath@simple.biz')` returns facts. Plus a source-level assertion: `grep -n "loadOffboardEvidenceByEmail(" src/lib/documents/termination/` must show `'work'` on every line.

### G2 — `temporary_pause` can never produce a document. **UNMISSABLE. Four independent layers.**

**Assertion:** for any input whose latest departure evidence normalizes to `temporary_pause` in any casing or spelling variant, no PDF is rendered, no storage object is written, no row is inserted, and no field is written back.

**Mechanism:**
1. **Type layer** — `TerminationDepartureReason` = `TERMINATION_DEPARTURE_REASONS` (7 values) which structurally **excludes** `temporary_pause`. `TerminationFacts.reasonKey` and `TerminationGenerateRequest.filled.reason` are both that type, so a paused reason cannot be represented. `tsc --noEmit` is layer 1.
2. **Resolver layer** — `resolveTerminationFacts` step 5: `reasonKey(evidence.reason) === 'temporary_pause'` ⇒ `blocked: { code: 'temporary_pause' }`, returned **before** any rate read and any render. Normalization is required: the column holds `"Temporary Pause"` and `temporary_pause`; `reasonKey` collapses both.
3. **Route layer** — `POST` re-resolves facts server-side and returns **409** on any `blocked`; it never trusts a client-supplied reason. A `filled.reason` is validated with `isTerminationDepartureReason` before use.
4. **Database layer** — `constraint termination_documents_reason_key_check check (reason_key in ('ncns',…,'other'))`. Even a bug in layers 1–3 cannot land the row.

**Test:** table-driven over `['temporary_pause', 'Temporary Pause', 'TEMPORARY_PAUSE', ' temporary-pause ', 'Temporary  Pause']` — assert `reasonKey(x) === 'temporary_pause'` for all five, `isTerminationDepartureReason(reasonKey(x)) === false` for all five, and that a `resolveTerminationFacts` fixture for each returns `blocked.code === 'temporary_pause'` with `facts === null`. Plus a negative control: `'resigned'` must produce facts, so the test cannot pass by blocking everything.

### G3 — A currently-active person can never be terminated on paper

**Assertion:** `fetchGmlStatusMap()` reporting `active: true` for the work email is an absolute refusal.
**Mechanism:** `resolveTerminationFacts` step 3, before evidence resolution. **Copy `fetchGmlStatusMap`'s polarity exactly** (`gml-status.ts:32-34`): *if ANY row containing this email is unstamped, that email counts ACTIVE, full stop.* A `rows.find(r => r.off_boarded_at)` first-match check would declare working people terminated — the stamp routinely lands on a duplicate row (measured 2026-08-21: 1,287 active rows, **zero** carrying `off_boarded_at`, while 294 of those people were offboarded, `offboard-evidence.ts:8-11`). **`active_employees` is useless and actively misleading here.**
**Test:** fixture with two rows for `jan@simple.biz` — one stamped `duplicate_cleanup`, one unstamped. Assert `blocked.code === 'still_active'`. (Real case: `jan@` carries a `duplicate_cleanup` stamp across 95 master rows while working normally.)

### G4 — Re-hire guard

**Assertion:** `offDate <= startDate` ⇒ not a departure.
**Mechanism:** `resolveTerminationFacts` step 8 ⇒ `blocked: { code: 'rehire_after_offboard' }`. Restated as DB data: `check (start_date is null or termination_date > start_date)`.
**Test:** fixture `startDate 2026-07-01`, `offDate 2026-06-15` ⇒ blocked. Negative control `offDate 2026-08-01` ⇒ facts. Measured: 18 people whose evidence clears this guard still logged hours in the Aug 9–15 timesheet.

### G5 — No impossible date on a signed page

**Assertion:** every printed date is `sanitizeOffboardDay(normalizeMasterDate(raw))` — in that order — and a null result is a BLANK the rep must fill, never a printed guess.
**Mechanism:** `sanitizeOffboardDay` nulls anything more than one day after `now` (`offboard-date-sanity.ts:39`); it only accepts an ISO-prefixed string (`^(\d{4})-(\d{2})-(\d{2})`, `:28-31`), so `normalizeMasterDate` **must** run first. `loadOffboardEvidenceByEmail` does **not** sanitize (`:81`). Date-only rendering goes through `formatCoeStartDate`, never `new Date('YYYY-MM-DD')`.
**Test:** `'2027-04-20'` (franm@'s real year typo) ⇒ `terminationDate === null`, `blanks` includes `'termination_date'`, `blankReason === 'date_failed_sanity'`. `'5/4/2026'` ⇒ `'2026-05-04'` (parsed by PARTS, never `new Date` — Node's locale parse flips it to April 5). `'13/45/25'`, `'n/a'`, `'TBD'`, `''`, `'   '` ⇒ null. Reverse order (`sanitizeOffboardDay('5/4/2026')`) ⇒ null, proving the ordering matters.

### G6 — Nothing false or unrenderable reaches the page

**Assertions and mechanisms:**
- **No ₱0.00.** `amount === 0` ⇒ BLANK `'zero_rate'` (C5). DB: `check (starting_rate is null or starting_rate > 0)` ×2.
- **No raw `hsl:*`.** Only `endingDepartmentLabel` (via `formatDeptLabel`) is rendered; `endingDepartmentRaw` is audit + rate-resolution only. DB: `check (ending_department_label not like 'hsl:%')`.
- **No `@`-address as a legal name.** The `bad_name` refusal adds `composed.includes('@')` to the COE's `/[,"“”]/` guard.
- **Every `drawText` string sanitized.** `fonts.sanitize()` at every call site including loops.
- **`fonts.unicode === true` asserted in the test** — `embedPdfFonts` never throws; it silently falls back to Helvetica with `unicode: false` and a sanitizer that rewrites `₱` → `"PHP "`.
- **No bonus lines** — `isDeptEligible` fails OPEN on a null deptKey.

**Test:** in `termination-document.test.ts`, render with a facts fixture whose `endingDepartmentRaw` is `'hsl:intake_specialist'` and assert the rendered `endingDepartmentLabel` fed in is `'HSL — Intake Specialist'`; render with `workerName` fixtures from `coe-document.test.ts:218-238` and assert the accepted three produce a page and the refused seven plus `'jasminec@simple.biz'` are refused upstream; assert `fonts.unicode === true`; assert `getPageCount() === 1` for **(a)** the 1×1 `PNG_1PX`, **(b)** the full-height `makePng(Math.round(TYPED_EXPORT_HEIGHT * 12 + RASTER_PADDING * 2), TYPED_EXPORT_HEIGHT + RASTER_PADDING * 2)` = **1944 × 184** fixture, and **(c)** a worst case (longest name + `"A, B, C"` department + longest reason label + both rates present). Copy the whole `makePng` helper (`coe-document.test.ts:262-296`, uses `zlib.crc32`, Node ≥ 20.12) **including** the `'the PNG helper produces something pdf-lib will actually embed'` guard at `:305-311` — without it a one-page assertion can pass because the image silently failed to load.

### G7 — The write-back fills blanks only, and is reversible

**Assertions:**
1. Only the three columns in `TERMINATION_WRITEBACK_COLUMNS` are ever written.
2. A column that holds any non-blank value is **never** overwritten.
3. Zero returned rows is **SKIPPED**, never success.
4. Every applied write is recorded with `before` distinguishing `null` from `''`.
5. The reverse is keyed on `global_master_list.id`, never an email.

**Mechanisms:** the allowlist is a `const … as const` and `TerminationWritebackColumn` types every call; the `.is(col, null)` filter + the two-phase empty-string re-read (C8); `.select('id')` on every UPDATE; `field_writebacks` jsonb; `master_row_id` column.

**Tests:**
- Pure: `isBlankCell` over `[null, undefined, '', '   ', '\t', 0, 'x', ' x ']` ⇒ `[T,T,T,T,T,F,F,F]`.
- Pure: `TERMINATION_WRITEBACK_COLUMNS` has exactly `['off_boarded_at','off_boarded_reason','Start Date']` — a **pinning test** that fails if anyone adds `"Department"` or a rate column.
- Source assertion (grep-based test or review gate): every `.update(` in `src/lib/documents/termination/` is followed by `.select(` in the same chain.
- Round-trip: for `{before: null}` and `{before: ''}` records, the reverse mapping restores `null` and `''` respectively — never collapsing them.

### G8 — Zero leak to the employee surface

**Assertion:** no termination document, its facts, or its file can appear in any `/api/employee/*` response.
**Mechanism (proof, not policy):** `GET /api/employee/documents` calls `listDocumentRequests({ email })` → `supabase.from(TABLE)` where `TABLE` is the module-const literal `'document_requests'` (`requests.ts:32`, verified). There is **no `from(<variable>)` anywhere in that path**. A separate table therefore cannot appear. Preconditions that keep the proof valid: (a) no `table`/`type` option is added to `listDocumentRequests`; (b) no termination doc is stored as a `document_requests` row with a new `document_type`; (c) `termination-log.ts`'s own `TABLE` is likewise a module-const literal.
**Test / gate:** `grep -rn "termination" app/api/employee/ src/lib/documents/requests.ts` must return **zero** matches, and `grep -n "from(" src/lib/documents/termination/termination-log.ts` must show only `from(TABLE)` and `from(DOCUMENT_REQUESTS_BUCKET)`.
Also mirror the id-probing defence: the `[id]` download route returns **404**, not 403, for an id that does not exist (`app/api/employee/documents/[id]/route.ts:44`).

### G9 — The signature is the generating rep's own, and live

**Assertion:** the PDF is signed with `getDocumentSignature(authz.sessionEmail).row` and only when `row.enabled === true`.
**Mechanism:** `TerminationRenderParams.signature` is **required, non-optional** — a missing signature is a type error, not a silently unsigned page. The route loads it from `authz.sessionEmail`, never a body field. Order of checks: `error` first (a null row with `error: 'Supabase not configured'` is a config failure, not a revoked signer), then `!row`, then `!row.enabled`. Both thrown messages reproduce the substrings the UI matches on; the route maps them to **412**.
**Test:** three route-level cases — no row ⇒ 412 with a message containing `'No saved signature'`; `enabled: false` ⇒ 412 with `'switched off'`; `error: 'Supabase not configured'` ⇒ 500, **not** 412.

---

## 6. Verified API reference

Every entry below was read in this session unless marked. Import paths are exactly as written.

**Auth — `@/lib/auth/authorize-feature`** (module opens `import 'server-only'`)
- `authorize-feature.ts:49` `export async function requireFeatureAccess(view: FeatureViewKey, feature: string, level: 'view' | 'edit' = 'edit'): Promise<AuthzResult>` — **third arg defaults to `'edit'`**
- `authorize-feature.ts:67` `export function requireFeatureEdit(view: FeatureViewKey, feature: string): Promise<AuthzResult>` — not `async`; returns the inner promise

**Auth — `@/lib/auth/authorize-email`**
- `:21` `AuthzOk = { ok: true; sessionEmail: string; effectiveEmail: string; elevated: boolean; roles: string[] }`
- `:29` `AuthzDenied = { ok: false; status: 401 | 403; message: string }` · `:35` `AuthzResult`
- `:174` `export function deniedResponse(result: AuthzResult): NextResponse` — 500s if handed an ok result

**RBAC**
- `@/lib/rbac/feature-permissions` `:8` `FeatureViewKey = "accounting" | "manager" | "hr" | "orphanage" | "ceo" | "contractor" | "qc" | "tickets"`

**Supabase plumbing**
- `@/lib/supabase/server` `:123` `createSupabaseServerClient(): SupabaseClient | null` · `:131` `createSupabaseServiceRoleClient(): SupabaseClient | null` — **both return `null` when unconfigured**
- `@/lib/supabase/select-all-paged` `:24`
  ```ts
  export async function selectAllPaged<T>(
    buildPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    pageSize = 1000,
  ): Promise<{ rows: T[]; error: string | null }>
  ```
  Never throws; on error returns **partial rows plus `error.message`**. Build the query inside the closure (builders are single-use), apply the handed `.range(from, to)`, add a stable `.order()`.

**Email / name / dates**
- `@/lib/email/norm-email` `:2` `normEmail(s: string | undefined | null): string | null`
- `@/lib/name/name-parts` `:80` `NameParts { first; middle; last; extension; nickname }` · `:114` `stripMiddleMarker(s: string): string` · `:160` `parseNameParts(input: string | null | undefined): NameParts` · `:249` `composeMasterListName(p: NameParts): string`
- `@/lib/roster/master-date` `:28` `normalizeMasterDate(raw: string | null | undefined): string | null` (pure, client-safe)
- `@/lib/roster/offboard-date-sanity` `:39` `sanitizeOffboardDay(day: string | null, now: Date = new Date()): string | null` (pure)

**Offboard evidence / status**
- `@/lib/roster/offboard-evidence` — module opens `import 'server-only'`. `:50` `OffboardEvidenceKeys = 'all' | 'work'` · `:52` `OffboardEvidence { offDate: string; reason: string | null }` · `:71` `loadOffboardEvidenceByEmail(keys: OffboardEvidenceKeys = 'all'): Promise<Map<string, OffboardEvidence>>` — **returns the Map directly; NO error channel; every source read is `.catch(() => {})`, so a smaller map is indistinguishable from "nobody left".** *(Recon agent 1 cited `:52`/`:54`/`:71`; agent 2 cited `:50`/`:52`/`:71`. **Agent 2 is correct** — verified.)*
- `@/lib/roster/gml-status` `:8` `GmlEmailStatus { active: boolean; offBoardedAt: string | null; offBoardedReason: string | null }` · `:36` `fetchGmlStatusMap(): Promise<{ map: Map<string, GmlEmailStatus>; error: string | null }>` (pages internally)

**Reasons**
- `@/lib/hr/offboard-reasons` (pure, client-safe) `:11` `VALID_OFFBOARD_REASONS` (8-tuple) · `:22` `OffboardReason` · `:24` `OFFBOARD_REASON_OPTIONS` · `:38` `OFFBOARD_REASON_LABELS: Record<string,string>` · `:49` `isValidOffboardReason` · `:62` `QueueableOffboardReason` · `:64` `isQueueableOffboardReason` · `:70` `offboardReasonLabel(v): string` (null/'' ⇒ `'—'`; unknown ⇒ raw)
- `@/lib/payroll/offboarded-final-pay-eligibility` `:12` `isEligibleForFinalPayReview(reason: string | null): boolean`
- **PRIVATE, reimplement in C2:** `catalog-roster-visibility.ts:74` `DEPARTURE_REASONS`, `:80` `reasonKey` — **verified not exported.** Note the route `app/api/hr/offboard/route.ts:40-49` keeps its own divergent copy of the enum (same 8 values, different order).

**Departments**
- `@/lib/departments/hsl-subdept` `:115` `hslSubDeptLabel` · `:124` `hslSubKeyFromRaw` · `:134` `isHslSubDeptLabel` · **`:149` `isHslFamilyLabel`** *(recon said `:148` — corrected)* · **`:162` `formatDeptLabel(raw: string | null | undefined): string`** · `:181` `collapseHslFamilyLabel` — **option lists / filters ONLY; never a stored value, never a sheet-sync path**

**Documents — reusable**
- `@/lib/documents/types` `:97` `DocumentSignatureRow` · `:108` `DOCUMENT_REQUESTS_BUCKET = 'document-requests'` · `:111` `MAX_DOCUMENT_BYTES` · `:116` `formatDocumentDate` · `:127` `formatDocumentDateTime` (forced `Asia/Manila`, `'—'` fallback) · `:142` `formatRelativeTime` · `:157` `elapsedLabel` · `:173` `shortReferenceId` · `:178` `formatFileSize`
- `@/lib/documents/signatures` `:19` `getDocumentSignature(email: string): Promise<{ row: DocumentSignatureRow | null; error: string | null }>`
- `@/lib/documents/coe-facts` `:62` `coeWorkerName(rawName): string | null` · `:128` `formatCoeMoney(amount, currency): string` · **`:141` `formatCoeRate` — PRIVATE, duplicate it** · `:152` `formatCoeStartDate(raw: string): string | null` · `:216` `resolveCoeFacts` · `:396` `coeSummaryLabel`
- `@/lib/documents/coe-document` `:55` `CoeRenderParams` · `:116` `Span` · `:140` `renderCoeDocument` · **`:555` `export const __coeInternals = { formatDotDate, wrapText, trackedWidth }` — the ONLY three importable helpers**
- `@/lib/documents/signature-render` `:33` `TYPED_EXPORT_HEIGHT = 160` · `:47` `MAX_RASTER_WIDTH = 2400` · `:51` `RASTER_PADDING = 12` · `:79` `planSignatureRaster` · `:107` `planRasterAttempts` · `:112` `exceedsSignatureBudget` · `:118` `PDF_SIGNATURE_MAX_HEIGHTS = { coeBlock: 46, certificationPage: 58 }`
- **PRIVATE, duplicate:** `requests.ts:35` `emailPathSegment`, `:40` `looksLikePdf`

**PDF**
- `@/lib/pdf/fonts` `:54` `PdfFontSet { regular: PDFFont; bold: PDFFont; unicode: boolean; sanitize(text: string): string }` · `:108` `embedPdfFonts(doc: PDFDocument): Promise<PdfFontSet>` (never throws) · `:130` `__sanitizers`
- `@/lib/pdf/logo` `:15` `SIMPLE_LOGO_SIZE` (900×324) · `:29` `embedSimpleLogo(doc): Promise<PDFImage | null>` · `:44` `simpleLogoWidthForHeight(height: number): number`

**Rates**
- `@/lib/payment-catalog/person-comp` `:30` `SheetRate` · `:37` `PersonCompSubject` · `:51` `PersonCompIndexes` · `:62` `PersonSystemBonusRow` · `:70` `PersonComp` · `:86` `resolveRosterDeptKey` · **`:99` `parseRateText(v: string | null | undefined): number | null`** (strips commas — `Number('1,234.50')` is `NaN`) · `:107` `computePersonComp` · `:211` `winningRate`
- `@/lib/payroll/rate-history-resolve` (pure) `:11` `RateHistoryRow` · `:19` `RateHistoryByEmail` · `:21` `parseRateNum` · `:28` `parseEffectiveDate` · `:39` `resolveRateAsOfDate` · `:53` `resolveRateFromMap` · `:90` `historyMatchesCatalogAsOf` · **`:114` `buildRateHistoryByEmail`** *(recon said `:110` — corrected)*
- `@/lib/payroll/rate-history` `:35` `fetchAllRateHistory(): Promise<RateHistoryByEmail>` — **whole-table, heavy; query per person instead.** `:73` `insertRateHistoryRow` — **WRITE PATH, FORBIDDEN here.**
- `@/lib/supabase/rates-upload-db` `:14` `const SYNC_HISTORY_AUTHOR = "GSheets Sync"` — **private const; hard-code the literal in C5 and cite this line.**
- `@/lib/payment-catalog/pay-structure` `:12` `PayCurrency = 'PHP' | 'USD' | 'COP'` · `:40` `CURRENCY_SYMBOL` (COP is the literal `'$COP'`) · `:58` `CURRENCY_LOCALE = { PHP:'en-PH', USD:'en-US', COP:'es-CO' }` · `:68` `defaultOtRate(regularRate): number`

**Paystubs / dispatches (ending rate)**
- `@/lib/supabase/payment-dispatches` `:5` `PaymentDispatchRow` · `:152` `listPaymentDispatches(params: { cycleId?: string | null; recipientEmail?: string } = {}): Promise<{ rows: PaymentDispatchRow[]; error: string | null }>`
- `@/lib/payroll/paystub-fresh` `:36` `FreshPaystubEntry { staged; payload; payPeriod; refreshed; staleRateSnapshot?; error }` · `:514` `finalPaySnapshotKey(sourceFile): string` → `` `payroll.wizard.final_pay.${sourceFile}` `` · `:522` `getFreshPaystubEntry(sourceFile, recipientEmail, …)` — **UNVERIFIED beyond the first two params; read `src/lib/payroll/paystub-fresh.ts:522` before calling.**
- `@/lib/payroll/paystub-view` `:651` `mapPayloadToPayStub(payload, payPeriod?): PayStubView` — `mfRate = num(payload.rates_php.regular)`. **UNVERIFIED exact param types; read the file.**
- `@/lib/payroll/disbursement-reports` `:50` `DisbursementRecordRow` (rate columns `regular_rate_php`, `ot_rate_php`, both `number | string | null`) · `:303` `loadDisbursementRecordsForCycle(sourceFile): Promise<DisbursementRecordRow[]>` — **UNVERIFIED; read the file.**
- `@/lib/supabase/paystub-dispatch-queue` `:189` `getPaystubDispatchEntry` · `:243` `listPaystubPayloadsForEmployee` — **UNVERIFIED; read the file. Both match `.eq('recipient_email', norm(email))`: WORK EMAIL ONLY, no aliases.**

**Audit / settings**
- `@/lib/supabase/audit-log` `:125` `NewAuditLog = { user_name: string; user_role: string; action: AuditAction | string; resource: string; resource_id?: string | null; details?: Record<string, unknown> | null; ip_address?: string | null }` (**verified**) · `:137` `insertAuditLog(entry): Promise<{ error: string | null }>` writing exactly those seven columns to `audit_log` · `:159` `insertAuditLogs` · `:179` `clearAuditLog()` **truncates the table**
- `@/lib/supabase/pab-day-disputes` `:122` `resolveUserRole(email, fallback = 'Employee'): Promise<string>` — **UNVERIFIED signature; read the file.**
- `@/lib/auth/session-actor` `:11` `getSessionActor(): Promise<{ user_name: string; user_role: string }>` — **UNVERIFIED; read the file.** Prefer this in routes (zero DB).
- `@/lib/supabase/app-settings` `:26` `getAppSetting` (null for absent AND for read error AND for no client — indistinguishable) · `:45` `getAppSettingStrict` (**throws** on read error; null only when genuinely absent) · `:117` `upsertAppSetting(key: string, value: string)` — value is a **TEXT column holding a JSON string, not jsonb**

**UI**
- `@/hooks/useLiveRefresh` `:42` `useLiveRefresh({ tables, onRefresh, channel, pollMs = 30_000, debounceMs = 600, enabled = true, onStatusChange })` — **verified**
- `@/components/common/SignaturePad` `:42` default export `SignaturePad({ onChange, heightClassName = 'h-40', className, defaultName = '' })` — **UNVERIFIED; read the file before mounting.**
- `src/components/accounting/AccountingDocuments.tsx:80` `export default function AccountingDocuments({ sessionEmail, canEdit }: { sessionEmail: string | null; canEdit: boolean })` — **verified**
- State names for E1.3, **verified**: `signature` (`:92`), `signatureLoaded` (`:93`), `sigDialogOpen` (`:94`), `openSignatureDialog` (`:173`), `counts` (`:311`)

**Forbidden call — the single biggest trap**
- `@/lib/supabase/employees` `:536` `getEmployeeMasterRecord(email): Promise<{ employee: EmployeeRow | null; error: string | null }>` — **hard-wires `.is('off_boarded_at', null)` at `:568` (verified, with the work-email-recycling rationale in the comment at `:561-567`). It returns `{employee: null, error: null}` — a SUCCESS with no row — for every offboarded person. Calling it would block 100% of this feature's subjects with `no_master`. Build the parallel read described in C4 step 1.**

---

## 7. Revert procedure

Named audit data the reverse depends on: **`public.termination_documents.field_writebacks`** (jsonb array of `TerminationWritebackRecord`) plus **`master_row_id`** on the same row. There is **no other copy**. `audit_log` is not a fallback — `clearAuditLog()` (`audit-log.ts:179`) truncates it behind `DELETE /api/audit-log`.

Ordered steps. **Steps 1–3 must precede step 5.**

**1. Reverse the field write-back — DRY RUN (the default):**
```
node --import tsx scripts/revert-termination-doc-writebacks.mts
```
Reads every `termination_documents` row with `jsonb_array_length(field_writebacks) > 0` (paged — the table will cross 1000). Prints one padded line per `(rowId, column, before, after)`. Exits **0**. Missing `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` ⇒ `console.error` + exit **1**.

**2. Reverse for real:**
```
node --import tsx scripts/revert-termination-doc-writebacks.mts --apply
```
The script must, in this order:
a. Write a `SELECT` backup of every affected `global_master_list` row to
`references/backups/termination_writeback_revert_${new Date().toISOString().replace(/[:.]/g,'-')}.json`
(**stamped form, not date-only — a date-only name overwrites the first run's backup the same day**). `references/backups/` is **gitignored** (`.gitignore:26-27`). **Never write PII to `reports/` or `scripts/backups/` — both are tracked in git.**
b. Per record, **re-read and re-verify the signature at write time** (the `restore-clobbered-bank-submissions.mjs:181-194` pattern): read `select('id, "<col>"').eq('id', rowId).maybeSingle()`; proceed only if the current value **equals `record.after`**. If it differs, print `SKIP <rowId>.<col>: changed since generation ('<current>') — untouched` and count it failed. **This is what makes the reverse safe without a `.is()` guard, and it is why the reverse cannot infer its own targets from "the field is now populated".**
c. Write `{ [col]: record.before }` (**exactly `null` or `''` — never collapse them**) `.eq('id', rowId).select('id')`; zero returned rows ⇒ SKIP, not success.
d. `console.log` the counts and end with `process.exit(failed ? 1 : 0)`.

**Note before running:** a master-list sheet sync between generation and revert can already have clobbered `off_boarded_reason` / `"Start Date"` (memory `hris-is-dept-source-of-truth`, `transfer-sheet-sync-false-success`). Step 2b will then SKIP those, correctly — a non-zero exit here is information, not a failure of the script.

**3. Confirm zero remain:**
```sql
select count(*) from public.termination_documents where jsonb_array_length(field_writebacks) > 0;  -- expect 0
```
(The script clears each row's `field_writebacks` to `'[]'::jsonb` after a successful reverse.)

**4. Revert the code — one command, because the whole feature is one commit:**
```
git revert --no-commit <feature-commit-sha>
git status                      # confirm ONLY the 20 feature paths + the 3 doc/index files
git commit -m "revert: Termination Docs [TERMINATION-DOCS]"
```
Manual fallback if the revert conflicts:
a. `rm -rf src/lib/documents/termination/`
b. `rm -rf src/components/accounting/termination-docs/`
c. `rm -rf app/api/accounting/documents/termination/`
d. `rm scripts/revert-termination-doc-writebacks.mts`
e. In `src/components/accounting/AccountingDocuments.tsx`, delete every block bracketed by a `[TERMINATION-DOCS]` marker — `grep -n "\[TERMINATION-DOCS\]" src/components/accounting/AccountingDocuments.tsx` prints the ranges in pairs (expect **8** hits: 2 import, 2 state, 3 in the E1.3 block, 1 at E1.4). **Nothing else in that file was modified; there is nothing to un-reindent.**
f. Delete `docs/features/termination-docs.md`, its `docs/features/INDEX.md` row (a whole-line delete — that is why a new row was appended rather than editing line 30), its `docs/README.md` row, `memory/termination-docs.md`, and its `MEMORY.md` line.
g. `npx tsc --noEmit && npm test`. **Never `next build`.**

**5. Drop the DB objects — Kane pastes this in the Supabase SQL editor:**
`references/sql/fix/drop_termination_docs.sql` (§3). Run its PRE-CHECK first; it must return 0.

**6. Delete the storage objects** (the `delete from storage.objects … name like 'termination/%'` statement inside N2). The `termination/` prefix is exclusive to this feature; `document_requests` objects live at `<email-segment>/<id>/original.pdf` and cannot be hit. **Do not rely on `.remove()` from app code** — every `.remove()` in `requests.ts` is called with `.catch(() => {})`, so a failed cleanup is invisible; drive the deletion from the DB list.

**Not reverted, deliberately:** the `document-requests` bucket, `document_requests`, `document_signatures`, and every `audit_log` row with `action = 'documents.termination_generated'` (the audit trail outlives the feature).
**Left inert:** nothing. No env var, no `app_settings` key, no cron, no n8n webhook, no notification type, no `localStorage` key. State this negative inventory verbatim in N4's Removal section — it is the shape the `[WIZARD-TUTORIAL]` precedent established (`docs/features/payroll-wizard-tutorial-mode.md:161-163`).

---

## 8. Open risks — questions for Kane

1. **`"Department"` is excluded from the write-back.** I froze the allowlist to `off_boarded_at`, `off_boarded_reason`, `"Start Date"`. Department is the most-clobbered cell in the system (the next master sync reverts a DB-only edit, memory `hris-is-dept-source-of-truth`) and it is a display-only fact here. **Should a blank ending department the rep fills be written back at all, knowing the sheet will likely revert it?** My answer is no.

2. **Rates are never written back.** `employee_rate_history` and `employee_hourly_rates` are live pay paths — `insertRateHistoryRow` persists `effective_from` verbatim and both engines prorate per-day from it, so a "filled-in starting rate" would silently re-price historical weeks. A rep-supplied rate therefore lives **only** on the `termination_documents` row. **Confirm that is acceptable, or say where else it should go.**

3. **No kill switch.** Recon disagreed: one agent proposed `app_settings` key `documents.termination_docs.enabled` read with `getAppSettingStrict`; another argued there is no feature-flag framework in this repo and the approved revertibility shape is marker + directory + down-migration + reverse script. I froze **no kill switch**, partly because the generic `POST /api/app-settings` gates only on `requireElevatedSession()` (which admits `hr_coordinator`) and a `documents.*` key trips none of `isSensitiveKey`/`isAdminOnlyKey`/`isPayrollLockKey` — so the write would be **unaudited and HR-flippable**. **Do you want one anyway?**

4. **Non-PHP payees.** The page prints PHP only; a USD/COP payee's rates come back BLANK with `blankReason: 'non_php_payee'` for the rep to type. **Should the PDF instead print the native currency (which means a currency picker beside each rate field and a `*_currency` the rep controls)?**

5. **The hero header still says "Signing queue"** on both inner tabs (`AccountingDocuments.tsx:397-408`). Making it tab-aware means **modifying** two pre-existing lines, which the marker contract wants to avoid. I left it. **Accept, or accept two marked modified lines?**

6. **Regeneration.** No uniqueness constraint — a rep may generate a second letter for the same person and both rows persist (a permanent log of every generation). **Should a second generation for the same `work_email` require a confirmation, or be blocked outright?**

7. **`ambiguous_identity`.** Where a personal email backs several master rows the rep disambiguates in the UI. **Confirm the rep is the right adjudicator here, versus refusing outright and routing to HR.**

8. **Merged empty/no-match state.** `AccountingDocuments.tsx:645-660` merges the two states that `ui-standards` §12.1/§12.2 asks be distinct. Following the doc in the new panel makes the two panes look different. I froze **follow the doc in the new panel only**. **Confirm.**

9. **`.or()` and admin-tools.** `src/lib/anthropic/admin-tools.ts:1415` does use `.or('"Work Email".ilike.${email},…')` on emails containing dots, which the documented rule at `src/lib/supabase/global-master-list-db.ts:1359-1373` says mis-parses ("PostgREST's logical-filter string parses `column.op.value`, and our email values contain dots… the parser mis-splits and reports a bogus 'column … does not exist'"). **Recon agent 2 is right and `admin-tools.ts:1415` looks like a live latent bug** — Penny's alias expansion for leavers may be silently returning nothing. This contract forbids `.or()` for email values everywhere. **Flagging it as a separate bug for a separate commit; not fixed here.**