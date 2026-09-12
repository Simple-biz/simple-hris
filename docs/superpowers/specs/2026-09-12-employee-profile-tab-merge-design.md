# Employee → Profile — tab merge, caching conformance, and the payee's own bank card

**Date:** 2026-09-12
**Surface:** `src/components/employee/EmployeeProfile.tsx` (2,552 lines), `src/components/employee/EmployeeApp.tsx`
**Skills:** `hardening` (doc-check duty), `impeccable` (Operate mode), `superpowers:brainstorming` (architectural path)
**Status:** design approved by Kane 2026-09-12 on four blocking questions; spec awaiting review

---

## 1. What this is

Nine in-page section chips become five. The chips are a real ARIA tablist inside one page —
not routes, not sidebar items (`EmployeeSidebar.tsx:78`, one `profile` key at
`src/lib/pages/visibility.ts:147`) — so this is a presentational reshuffle plus one new
component reuse, not a routing change.

| # | id | label | sub | contains |
|---|---|---|---|---|
| 1 | `overview` | Overview | Identity, employment & ID | Personal · Employment · Address (`hasAnyAddress`-gated) · **ID card** |
| 2 | `compensation` | Compensation | Rates, stubs & payout | sections: **Rates** · **Pay Stubs** · **Payout** |
| 3 | `skills` | Skill Sets | Skills & commendations | Skill sets · Commendations (stacked) |
| 4 | `requestDocuments` | Request Documents | COE, pay stubs & certificates | unchanged |
| 5 | `resign` | Resign | End your employment | unchanged |

Retired ids: `id`, `payStubs`, `payment`, `reports`.

**Two merge geometries, and the rule that picks between them.** A merged tab gets an inner
section strip **only when a section owns a long workspace and its own Save or export controls**.
Compensation qualifies (a paginated statement list with XLSX/PDF exports, and a payout form with
its own Save and its own payroll lock). Overview+ID and Skill Sets+Reports do not — they stack,
because a second navigation level for two short blocks costs more than it returns.

---

## 2. Decisions recorded (Kane, 2026-09-12)

These four answers supersede three documented positions. Each doc gets corrected **in the same
commit as the code**, per CLAUDE.md.

| # | Question | Ruling | Docs corrected in the same commit |
|---|---|---|---|
| Q1 | Payment folds into the merged money tab? | **Yes**, with three hard conditions (§5) | `implementation-plan-employee-surface-and-qc.md:565-568`; `docs/meetings/2026-09-09-…:75-77`; `docs/features/employee-dashboard-cache.md:118-126` |
| Q2 | Where does Compensation live? | **With Pay Stubs + Payout**, not with Overview+ID | plan §7 (`:475-481`, `:572-576`); meeting `:52` |
| Q3 | What does "proper caching" mean? | **Conform to the existing contract.** No new keys. | none — this ruling *upholds* plan `:487-489` |
| Q4 | What does the employee's bank card show? | **Card is the read view, masked to last-4 with an in-card reveal** | new rules → new feature doc |

Q1's ruling also re-opens the `?email=` preview-download decision at
`docs/features/employee-id-card.md:217-221`, whose stated justification — *"the card carries no
bank data"* — no longer holds once payout data shares the Profile. That re-decision is recorded
in the new feature doc.

This message is also the approval for the plan's **Wave 4**, which
`docs/audits/audit-2026-09-10-session-log.md:345` left open. Recorded in the session log in the
same commit. Q7 (Award/Certificate picker) and Q8 (Skill Sets cap) stay **explicitly out of
scope** — the cap of 2 on Current projects is untouched.

---

## 3. Blocking pre-fixes — separate, reviewable steps *before* the merge

### 3.1 Rules-of-hooks violation (verified live on `main`)

`if (loading) return <ProfileSkeleton />;` at `EmployeeProfile.tsx:1294` sits **above** two hooks:
`useMemo` at `:1315` and `useState` at `:1338`. `loading` initialises to `master === null`
(`:666`) and `master` is seeded from the session cache (`useEmployeeCachedState`, `:654`), so on
any **cold** load — first visit, new device, post-sign-out purge, or past the 12h `MAX_AGE_MS` —
render 1 returns early with N hooks and render 2 runs N+2. React throws *"Rendered more hooks
than during the previous render."*

There is **no** `app/error.tsx`, `app/global-error.tsx`, `componentDidCatch` or `ErrorBoundary`
anywhere in `app/` or `src/` (verified), so the throw blanks the route.

This is **not** the Chrome-renderer OOM recorded in
`memory/employee-page-crash-is-browser-not-vercel.md` — that investigation stands on its own
evidence and still needs Kane's tab-memory capture. This is a separate, independently reachable
defect on the file the merge rewrites.

**Fix:** hoist `idCard` (`:1315`) and `savingId` (`:1338`) above `:1294`. Its own commit, before
any merge edit. Closed by an `eslint react-hooks/rules-of-hooks` run on the file.

### 3.2 Red test baseline

`node --import tsx --test src/lib/departments/dept-label-render.test.ts` **fails on `main`
today** (verified), naming two offenders:

```
src/components/employee/EmployeeIdCard.tsx:205  {card.department}
src/components/manager/ManagerApp.tsx:1669      {dept || 'No department'}
```

`EmployeeIdCard.tsx` is a file this merge touches, so a genuine regression would be
indistinguishable from the known failure. The baseline is recorded in the session log before any
merge edit. `EmployeeIdCard.tsx:205` is a **false positive** — the value is already through
`formatDeptLabel` inside `buildIdCard` — and is resolved by widening the scanner's
`ALLOWED_SNIPPETS` **with a stated reason**, as its own reviewable step. Never by deleting the
assertion. `ManagerApp.tsx:1669` is out of scope and stays recorded.

### 3.3 Build hygiene

`.next/` exists and is shared by `next build` and a running `next dev`. Check for a live dev
server before any build (CLAUDE.md § Build).

---

## 4. Navigation, deep links, and the five copies of one union

### 4.1 The defect being closed

`TabId` (`EmployeeProfile.tsx:151`) is **not exported**. The narrower focus union is
hand-maintained in **five** places:

- `EmployeeApp.tsx:59` — `type EmployeeProfileFocusTab = 'overview' | 'payment' | 'skillsets'`
- `EmployeeDashboard.tsx:291` — third copy in a prop type
- `ProfileCompletionCard.tsx:14`, `:33` — fourth and fifth

`navigateToProfileSetup` (`EmployeeApp.tsx:426-428`) resolves to
`needsPhoto ? 'overview' : needsBank ? 'payment' : 'skillsets'`, handed to `focusTab` (`:483`)
and applied verbatim by `useEffect(() => setActiveTab(focusTab), [focusTab])`
(`EmployeeProfile.tsx:691-693`). The render chain (`:1581-2308`) is nine bare
`activeTab === '…' &&` guards with **no default branch** — so retiring `'payment'` and
`'skillsets'` without changing those five copies yields a silently **empty pane**, with no
TypeScript error, because the narrow union still satisfies the wide one.

### 4.2 The replacement

Deep links become **intents**, not tab ids, resolved through one exported table:

```ts
// EmployeeProfile.tsx — exported, the single source
export type TabId = 'overview' | 'compensation' | 'skills' | 'requestDocuments' | 'resign';
export type SectionId = 'rates' | 'payStubs' | 'payout' | 'skillSets' | 'commendations';
export type ProfileIntent = 'photo' | 'bank' | 'skillSet';

export const INTENT_TARGET: Record<ProfileIntent, { tab: TabId; section?: SectionId }> = {
  photo:    { tab: 'overview' },
  bank:     { tab: 'compensation', section: 'payout' },
  skillSet: { tab: 'skills',       section: 'skillSets' },
};
```

**A `SectionId` means two different things depending on the tab, and both are legitimate.** In
**Compensation** — the only tab with an inner strip — it *selects* a section. In the **stacked**
tabs (Overview, Skill Sets) it is a **scroll anchor**: the intent lands on the tab and scrolls the
named block into view. The resolution test asserts the id exists in that tab's canonical array
either way, so a renamed block cannot silently become an unreachable target.

All five copies are deleted and import `ProfileIntent` from this module.
`navigateToProfileSetup` maps `needsPhoto → 'photo'`, `needsBank → 'bank'`,
`needsSkillSet → 'skillSet'`.

**Closed by:** a test asserting every `ProfileIntent` key resolves to a `tab` present in the
`tabs` array and, when `section` is set, to a section present in that tab's canonical section
array.

### 4.3 Repeat deep links (pre-existing, made permanent by the merge)

`focusTab` is a **value-keyed** effect, and `EmployeeApp` never unmounts a visited tab
(`Array.from(mountedTabs)`, `:613`; grow-only `Set` at `:398-401`). Firing the same nudge twice
sets state to its current value, React bails out, the effect does not re-run, and the user does
not move. Fixed with a nonce beside the target — the shipped precedent is `HrApp`'s
`deepLinkNonce`. **Closed by:** a test asserting two consecutive
`navigate('profile', 'bank')` calls both move the pane.

### 4.4 Strings that fail the build if they move

`src/lib/penny/employee-guides.test.ts:165-169` source-scans `EmployeeProfile.tsx` for
`label: 'Pay Stubs'` and `label: 'Request Documents'` and **fails the build** if either moves.
`pay-status.test.ts:41` pins `/Pay Stubs/`.

Both literals survive: `Request Documents` keeps its chip, and `Pay Stubs` becomes a **section
label** in the same file. This also keeps Penny's guidance (*"Employee → Profile → Pay Stubs"*,
`employee-guides.ts:53`) literally true after the merge, and keeps the immutable notification
body *"Review them under Profile → Payment"* (`app/api/payment-dispatch/bank-override/route.ts:149`)
approximately true — the Payout section is inside Compensation. That residual drift is recorded
in the feature doc rather than papered over. Neither assertion is loosened.

### 4.5 Nudge dots

`hasIssue` / `escalated` are four literal id comparisons (`EmployeeProfile.tsx:528-534`).
Merging leaves `needsBank` (which Accounting escalates to rose via `escalatePayment`,
`EmployeeApp.tsx:392`) and `needsSkillSet` with no chip, while the sidebar badge
(`EmployeeSidebar.tsx:206-233`) still counts them — a badge pointing at nothing.

Dots roll up through `INTENT_TARGET`: a cause pings the chip its intent resolves to, and the
inner section strip carries its own dot. **Closed by:** a test asserting every nudge cause maps
to a rendered tab.

---

## 5. The merged Compensation tab

### 5.1 The three hard conditions from Q1

1. **Three independent readiness states.** `rates` and `payStubs` paint from cache instantly;
   the **Payout section alone** renders its own skeleton behind `bankInfoLoaded`. The merged
   pane never awaits `bankInfoLoaded`, and `loading` is never widened to cover it. Derive the
   spinner per section (`loading = !settled && nothing-to-paint`,
   `manager-dashboard-cache.md:92`), never one `setLoading(true)` in a combined effect.
2. **No cache key touches `/api/employee-ids`.** `bankInfo`, `payout`, `walletRailEffective`,
   `bankPreferred` and `pendingBankPreferred` (`EmployeeProfile.tsx:662-687`) stay on plain
   `useState`.
3. **The paystub fetch re-gates on the section, not the tab.** Today's guard is
   `if (activeTab !== 'payStubs' || payStubsRequestedRef.current) return;` (`:828`). Gated on
   the tab, every employee opening Compensation to check a bank detail fires
   `/api/employee/paystub?summary=1`. Gated on the section, the plan's "Pay Stubs stays lazy"
   survives.

### 5.2 The inner section strip

Copy the **quieter** inner-tab treatment, not a second row of the outer underline.
`PayProcessorsTab.tsx:1329-1366` states the house rule verbatim: *"Inner tabs sit one level
below the Payment Catalog's own pill row, so they are quieter by design: a bordered segmented
control, not a second row of pills."* The Profile's outer strip is an orange underline
(`layoutId="profile-tab-underline"`, `:564`), so the inner level is a bordered segmented
control — the two levels read as a hierarchy rather than two competing rows.

Three rules copied from `PayrollWizard`'s additions strip (`:15699`, the only shipped case of
one tab hosting two genuinely different workspaces):

- The strip sits **above** the workspace and **below** the tab header, so tab-level controls stay
  shared while each section keeps its own Save and exports.
- The active section is **derived with a fallback, not stored** (`PayrollWizard.tsx:8934-8939`) —
  a stored section outlives the condition that offered it. Profile already hides content by state
  (`hasAnyAddress` at `:1607`), so this hazard is live.
- Slide direction is computed from the **canonical** array, never the filtered one
  (`:15713-15719`), so a dropped section cannot reverse a swap.

The strip gets its **own** `LayoutGroup` id and `layoutId` — sharing either makes Framer animate
the outer underline down into the inner strip — and is gated on `useReducedMotion()`
(`EmployeeTeam.tsx:96`). The existing outer strip lacks that gate; the gap is **not** propagated.

### 5.3 State that must survive a section swap

Panes live inside one `<motion.div key={activeTab}>` under `AnimatePresence mode="wait"`
(`:1573-1578`), so the subtree is destroyed on every switch. Parent-hoisted state survives;
child-local state does not. Any section-swap-surviving state is hoisted to `EmployeeProfile` —
the shipped precedent is `EmployeeTeam.tsx:515-517`, *"Held here (not in the pane) so it
survives sub-tab swaps."*

Each Save keeps its **own** section and its **exact** disable expression: payout
`payoutSaving || payrollLocked || !payoutEditing` (`:1950`), skill sets
`skillSetSaving || skillSetLoading || !skillSetDirty` (`:2136`). `savePaymentDetails`
(`:1173-1248`) has **no** client-side field validation beyond the payroll lock — the disabled
button *is* the guard — so a lifted or merged Save would fire a partial bank write and, via the
server-side wallet mirror, file an Accounting approval request the user never saw proposed.
**Closed by:** a test asserting `update-employee-ids` is called only from the payout section's
handler, and a test asserting the POST body (`:1185-1213`) contains no key the form did not
render (`memory/nobank-list-clobbered-submissions.md` — 28 self-submissions were orphaned once
already by exactly this).

### 5.4 Scroll and pagination

The root is the only scroll owner (`:1369`) and the tab strip is not sticky (`:1557`). The pager
mutates `payStubPage` (`:811`) with no scroll restoration and no reset on reload — only clamping.
`payStubPage` resets when the list identity changes, and page changes scroll to the section
anchor.

### 5.5 Copy

The *"Bonuses … are not shown here"* paragraph (`:1705-1708`) currently sits in Compensation. In
the merged tab it would sit inches from a statement list that itemises PAB and Tech — a visible
self-contradiction. It is re-worded to scope the claim to the rates block, or relocated. Plan
`:481-483` already requires re-wording both surviving chips' `label`/`sub`.

---

## 6. Caching — conform, do not extend (Q3)

**Reuse `src/lib/employee/tab-cache.ts`.** No fifth store. In-memory `Map` mirrored to
`sessionStorage`, prefix `emp-cache:`, `SCHEMA_VERSION = 1` (`:69`), `MAX_AGE_MS = 12h` (`:83`),
envelope `{ v, id, at, data }` (`:85-93`), reads fail closed. Identity is bound once upstream at
`EmployeeApp.tsx:290` and purged on sign-out at `EmployeeSidebar.tsx:390` — a new store would get
neither.

**The four Profile keys stay exactly as they are, and no key is added:**
`profileMaster` (`:654`) · `profileRate` (`:658`) · `paystubSummary` (`:804`) ·
`profileSkillSet` (`:869`).

Explicitly **not** done: no new key; no skip/freshness flag (a currently-**passing** test at
`tab-cache.test.ts:323` greps the module's exports for `/fetched|revalidat|skip|ttlHit/i`); no
`localStorage` (`employee-dashboard-cache.md:37`); no SWR/react-query; no server-side
`revalidate`/`s-maxage`; no cache read above the hydration gate at `EmployeeApp.tsx:449`.

**Two obligations the merge does create:**

- If the merge changes what any of the four keys **holds**, bump `SCHEMA_VERSION` (`:69`) in the
  same commit. Reads validate version, identity and age but never **shape** (`:85-93`), so a blob
  written by the current deploy would be read into a new shape for up to 12h and surface as wrong
  pesos, not a crash. *Current assessment: the merge changes placement, not payloads, so no bump
  is expected — this is verified against each key before commit, not assumed.*
- If the merge collapses a key's call site, **delete that key** in the same commit. No orphans.

**Never cached here, no exceptions:** the bank/payout row from `/api/employee-ids` — verbatim at
`tab-cache.ts:343-345`, *"Bank/payout rows are deliberately NOT cached: account numbers stay out
of storage"*, and at `EmployeeProfile.tsx:651-654`. **Closed by:** a guard test asserting no
`EMPLOYEE_CACHE_KEYS` entry is sourced from `/api/employee-ids`.

**Honest expectation, stated up front:** the Profile already caches four datasets and already
fetches in one `Promise.all` wave (`:993-1001`). This merge will change reload speed very little.
The measured lever for this surface is **code-splitting** — there is zero `next/dynamic` in the
employee tree (`audit-2026-09-10:331`) — and that is its own pass with its own brief. Claiming
the merge as a performance win would be false.

---

## 7. The payee's own bank card (Q4)

### 7.1 Shape

`BankCard` becomes the **read view** of the Payout section; `PayoutDetailsFields` remains the
edit view. This is not a UX change — the pane is already read-with-an-Edit-button
(`EmployeeProfile.tsx:1922`, gated on `!payrollLocked && bankInfo && !payoutEditing`). The card
renders when `!payoutEditing`; the form when editing.

This is the only arrangement that satisfies **one home per value** (`PeopleTab.tsx:3777-3781`):
*"the four values on its face are NOT repeated in the grid below — one home per value, or the
two copies drift the first time either is touched."* Routing number and full address stay in the
grid: they are wire instructions, not card-face values.

### 7.2 Masking

The employee sees **last-4 by default with an in-card reveal**, matching exactly what the pane
shows today — `maskSensitive` (`employee-payout-fields.tsx:662-663`) applied when
`masked && disabled` (`:679`). `BankCard` today takes `account: string | null` and prints it
verbatim with no `masked` prop (`bank-card.tsx:38-52`), so a `masked` capability is added to the
shipped component — a hardening edit to a component Accounting also uses, carrying its own doc
obligation.

**The copy button is disabled while masked.** Handing `••••••1234` to the clipboard on a money
field, silently, is worse than no button.

The reveal is **client-side only**. The full number is already in `bankInfo` client-side, so no
new route is needed. No audit row is written: `/api/people/[email]/reveal-banking` is gated by
`requireRateVisibilitySession()` (admin|accounting|ceo) and exists to record viewing **someone
else's** record (`reveal-banking/route.ts:35-42`). A payee viewing their own record is not that
event. `maskBanking` is **not** imported — it is `server-only`.

### 7.3 Feeding the brand

**One resolver, never forked:** `resolveBankBrand(spelling, registry?)` —
`src/lib/payment-catalog/banks.ts:327`. It routes through the same `groupKeyResolver` the Current
Banks fold uses, *"so a person's profile and the catalog card can never disagree about which bank
a spelling is"* (`banks.ts:313-322`).

The `registry` argument stays **unpassed**, matching the only existing caller
(`bank-card.tsx:53`). The `payment_catalog.banks.registry` `app_settings` row was probed and
**does not exist in prod**. Passing a registry on the employee surface alone would make the two
surfaces name different banks — the exact failure the shared resolver exists to prevent. Wire
both call sites together, or neither.

**Fed the PAID slot, never `bank_name` directly.** `docs/features/people-bank-card.md` §2:
*"Reading `employee_ids.bank_name` directly would put a bank's logo and colours on an account the
payment is not going to."* The cross-slot `pickFirst` rule (`PeopleTab.tsx:3192-3214`) is
currently **inline local consts** in the People component — not extracted. Reusing the card
without extracting them invites a retype or a shortcut to `payout.bankName`.

**Action:** extract one shared helper `pickPreferredBank(row)` and convert **both** call sites in
the same commit. A second copy is the drift §2 exists to prevent.

`bankInfo` already holds the complete slot pair (`employee-ids.ts:9-16`, `:43-44`, select at
`:92`), so **there is no data gap and zero new fetches.**

Never fed `payout: PayoutFields` — that draft is camelCase, uses `''` not `null`, and
`payoutDraftFromIdsRow` collapses `swift_code ?? routing_number` into one field
(`payout-completeness.ts:82`), so it would print a routing number in the SWIFT position with a
working copy button. Bind to `bankInfo`, repaint from the post-save re-read (`:1220-1226`).

### 7.4 Which payees get a card

Gate on `walletRailEffective` (`:683`) — the **server-resolved** rail, not `preferredProcessor`
(`:669`) and not `bankPreferred` (`:673`); those three are distinct and
*"changing one never changes the other"* (`employee-ids.ts:26-33`). `PeopleTab.tsx:3216-3220`:
*"Show the details of the rail Payment Dispatch ACTUALLY routes this person on … not the raw
Disbursement pick, which can disagree with how the person is really paid."*

The four-way rule is reproduced exactly, including the `(!proc && !!prefBank.name)` fallback:

| rail | card? | wallet fields? |
|---|---|---|
| `wires` | yes | no |
| `wise` | **yes** — Wise payees are paid into their bank account, same field set as wires | no |
| `jeeves` | yes | **yes** (plus phone) |
| `hurupay`/`kolan`, `wepay`, `higlobe` | **no** | **yes — never folded away** |

`PeopleTab.tsx:3792-3796`: *"for a Kolan, HiGlobe, WePay or Jeeves payee there is no card, and the
wallet address IS their payout record — collapsing it would leave the panel showing nothing but a
button."* 1,124 people have no bank on the paid slot.

The wallet-rail payload **fails closed** (`app/api/employee-ids/route.ts:24-26`): a missing
payload reads as **locked**, never as "no rail".

### 7.5 Brand rules that are not negotiable

- **No logo ⇒ no brand, never a monogram.** `banks.ts:297-300`: *"a wrong-bank logo is worse than
  none — it is a confident lie."* Escaped only via the card's exact `ProcessorLogo` props
  (`monogram=""`, `fallback="icon"`, `FallbackIcon={Landmark}`); re-wiring silently restores
  monograms. **162 people** bank with MariBank (104), Metrobank (31) and Security Bank (16),
  which ship no artwork — a neutral card is the **majority** outcome for them and is **correct**.
  Pinned by `bank-card-palette.test.ts`. It will be reported as a bug; it is not one, and the
  feature doc says so.
- **GoTyme resolves correctly today** — claimed at `banks.ts:107-109` with six aliases, measured
  `#2d2d3a` (`bank-card-palette.ts:40`) from `dominantInkColor`'s **second tier**: its wordmark
  has no real chroma, so the palette falls to the mean of its own ink, and `SAT_MIN = 14` stops it
  printing as flat charcoal. Three ways to break it, all forbidden: hand-editing
  `BANK_BRAND_HEX` (the test re-derives every hex off `public/banks/*.png`), removing the
  saturation weighting (every bank returns black), removing the tier-2 fallback (GoTyme goes
  neutral while every neighbour wears its colour).
- **One employee spells it `GoTyme Bank, Inc. (GoTyme Bank Corporation)`**, which no table claims,
  so they would see slate. Claiming it is a **declared** edit to `OFFICIAL_BANKS` requiring
  `scripts/audit-bank-spellings.mts` to be re-run — flagged in §10, not done as a side effect.
  Fuzzy matching is forbidden: *"guessing is exactly the invented equivalence §10.1 forbids."*
- **Colours are measured, never recalled.** **Contrast is searched, never constant**, and
  `CARD_TEXT_CONTRAST_FLOOR = 8.5` (`bank-card-palette.ts:62`) never moves — the flat-42%-mix
  failure (3.84:1 on AUB) was fixed by making the ink a search, not by lowering the threshold.
- **The card does not theme** (`bank-card.tsx:34-37`). If it is too loud on a white employee
  profile, change its **placement or size** — a "softer employee variant" invalidates the
  contrast proof.
- **The account number is never reformatted.** No 4-4-4-4 grouping whatever the card silhouette
  suggests; leading zeros preserved; the copy button hands over the same string
  (`bank-card.tsx:29-32`).
- **Display only.** `employee_ids` is never rewritten to make a brand resolve
  (`savePaymentDetails`, `:1191-1209`).

### 7.6 Two defects this reuse exposes

- **Alt-slot SWIFT is wrong today.** Every other card field goes through the cross-slot
  `pickFirst`, but `PeopleTab.tsx:3212` is `swift: banking?.swift_code ?? null` — the **primary**
  column regardless of `prefAlt`. There is no `alt_swift_code` column; the employee form writes
  alt-slot SWIFT into `alt_routing_number` (`EmployeeProfile.tsx:1208`). So an alternative-slot
  payee's card prints the **primary** slot's SWIFT and the copy button hands over a **wrong wire
  code**. Moving the card to the employee surface spreads this to the one person who would
  notice. **Fix the mapping.** Not closed by dropping the SWIFT field, and the `pickFirst` is not
  loosened. → **Q in §10.**
- **Copy must keep failing loudly.** The card throws when `navigator.clipboard?.writeText` is
  absent and raises a toast naming the field — justified verbatim in
  `people-bank-card.md` §5: *"On a money field, a tick that means 'possibly nothing happened' is
  worse than no button."* Employees are far more mobile than the accounting console, and
  `navigator.clipboard` is undefined in insecure contexts and several in-app webviews. Two ways
  to break it: the route not mounting sonner's `<Toaster>` (silent again), or someone adding an
  `execCommand` fallback "to make it work" (restores the swallow). Verify the `Toaster` mounts
  **exactly once** — `app/layout.tsx` and `EmployeeApp` both mount one.

### 7.7 Placement and bundle

`BankCard` lives in `src/components/people/`. Importing it from the employee tree couples the
employee bundle to the People tree on the one surface with **zero code-splitting and tabs that
never unmount**. Moving it to a neutral path (`src/components/banking/`) touches the shipped
Accounting call site. → **Q in §10.**

Its one-shot tilt-in fires on **mount**, and under a shell where mount ≠ visible the animation
plays behind a hidden panel while motion keeps the element alive. **Animate on activation, or
drop the motion wrapper for this host.**

---

## 8. Failure classes and how each closes

Every class below is closed by a test, a type, a guard, or a cited invariant. Nothing is closed
by loosening a type, guard, validation, limit, or test.

| # | Class | Closed by |
|---|---|---|
| 1 | Deep-link death (5 union copies) | Export `TabId`/`ProfileIntent`; delete all copies; test every intent resolves |
| 2 | Deep-link no-op on repeat | Nonce beside the target; test two consecutive nudges both move |
| 3 | Lazy paystub fetch never fires → false "No pay stubs yet" on a paid employee | Delete retired ids from the union so `tsc` raises TS2367 at every comparison; test the guard literal is a section member |
| 4 | Stale money on export (mount-lifetime `payStubsFullRef`) | Re-show/visibility refresh; never a skip flag |
| 5 | Cached PII | Guard test: no `EMPLOYEE_CACHE_KEYS` entry sourced from `/api/employee-ids` |
| 6 | Empty payout form flashing over saved details (matched guard pair `:1897`/`:1909`) | One derived `paymentVisible` const used by both; test `bankInfoLoaded=false` renders the skeleton |
| 7 | Cross-pane readiness coupling | Per-section `loading`; never one `setLoading(true)` |
| 8 | Rules-of-hooks crash | §3.1 pre-fix + eslint run |
| 9 | Build break on a label string | Literals survive on chip/section; Penny text and test move together if ever needed |
| 10 | Historical notifications → dead tab | Labels chosen to keep the text true; residual drift recorded in the doc |
| 11 | Nudge dot with no chip | `INTENT_TARGET` roll-up; test every cause maps to a rendered tab |
| 12 | Lost form state on section swap | Hoist to `EmployeeProfile` (`EmployeeTeam.tsx:515-517` precedent) |
| 13 | Double fetch (`RequestDocumentsTab` re-runs `?all=1` on every entry) | Share `ensurePayStubsFull`; test counting fetch call sites per endpoint |
| 14 | Mount/unmount memory growth | Lazy-render inside the merged pane on scroll (plan `:558-561`); measured before/after |
| 15 | ID-card layout collision (every dimension is `cqw`; screen and exported PNG diverge silently) | Keep a block that reaches **372px**; screenshots at 400 / 768 / 1400px |
| 16 | Shared `layoutId` collision | Distinct `LayoutGroup` id + `layoutId` per level; `useReducedMotion()` gate |
| 17 | Selection stranded on a hidden section | Derive with fallback; direction from the canonical array |
| 18 | Scroll / pagination jump | Reset `payStubPage` on list-identity change; scroll to section anchor |
| 19 | One Save, two write paths | Each Save keeps its section and exact disable expression; test `update-employee-ids` has one caller |
| 20 | Clobbered bank fields | Submit only dirty fields; test the POST body contains no unrendered key |
| 21 | Bank-preferred picker failing open | Option list derived from `preferredProcessor` state, never from cache |
| 22 | Start date contradicting itself on one pane | §10 Q — `formatStartDate` (`new Date(s)`, `:133`) vs `formatIdCardDate` (`parseDateOnlyLocal`) |
| 23 | Red baseline hiding a regression | §3.2 |
| 24 | Schema drift on a live `sessionStorage` blob | Verify each key's payload; bump `SCHEMA_VERSION` if any shape changed; delete collapsed keys |
| 25 | Quota exhaustion, silently (no `MAX_ENTRIES` trim on this store) | No new keys added, so no new pressure; recorded as a standing gap |
| 26 | Wallet payee shown an empty card | Four-way `walletRailEffective` gate; wallet fields never folded |
| 27 | Alt-slot SWIFT wrong wire code | §7.6 — fix the mapping |
| 28 | Card + editor both rendering the account number | Card is the read view, not an addition |
| 29 | Empty card saying the same thing as the rose bank nudge | Decide which speaks; do not ship both |

---

## 9. Out of scope

- The Skill Sets cap of 2 on Current projects — **not loosened**, not touched (plan Q8).
- The Award/Certificate picker (plan Q7).
- `ManagerApp.tsx:1669` dept-label failure — recorded, not fixed here.
- Code-splitting the employee tree — the real performance lever, its own brief.
- The `/employee` Chrome-renderer crash investigation — still needs Kane's tab-memory capture.
- Wiring the bank registry `app_settings` row — both call sites together, or neither.
- `/api/employee-ids` caching — permanently out of scope.

---

## 10. Questions that remain open

None of these block the build; each is flagged rather than silently decided.

1. **`formatStartDate` off-by-one** (plan Q5). The merge puts both parsers on one pane, so
   Overview's Start Date and the ID card's will differ by a day for every Manila viewer. Fixing
   `formatStartDate` also shifts two Pay Stubs pay dates and three resignation effective dates
   (`:1789`, `:1809`, `:2330`, `:2384`, `:2511`), and the unified formatter must keep the card's
   **verbatim pass-through** for unparseable values rather than Overview's `—`. Deleting the
   Overview row to hide the clash is not an option — it hides a known-wrong value.
2. **The alt-slot SWIFT mapping** (§7.6) — fix now, or record and defer?
3. **Claim `GoTyme Bank, Inc. (GoTyme Bank Corporation)`, `CIMB Bank`, `Philippines National
   Bank`** in `OFFICIAL_BANKS`? It is the difference between the GoTyme employee seeing GoTyme
   and seeing slate — but it is a declared claim needing `audit-bank-spellings.mts` re-run.
4. **Move `BankCard` out of `src/components/people/`?** (§7.7)
5. **Does the "Alternative account" chip stay, and in what words?** An employee may not know what
   a slot is; hiding it shows them a bank they are not paid into with no marker. Recommend
   keeping it with employee-facing wording.
6. **Offboarded employees — does the card render?** Unruled. Adjacent precedent cuts both ways
   (`payment-catalog-hides-offboarded` keeps four guards; `readiness-setrate-cannot-backdate`
   keeps rates editable for leavers). Needs a decision, not an inference.
7. **Does the card show `bank_last_self_updated_at`?** If yes it needs its own best-effort route —
   widening the shared `employee_ids` select reintroduces the column-missing failure
   `people-banking.ts:135-139` guards against.

---

## 11. Doc obligations shipping in the same commit as the code

- **New** `docs/features/employee-profile.md` — the Profile tab shell has **no** feature doc and
  **no** `INDEX.md` row today. A hardening lookup for "Employee Profile" resolves to nothing.
- **New** `docs/features/INDEX.md` row for it, wikilinked to `employee-id-card.md`,
  `employee-dashboard-cache.md`, `paystub-dispatch.md`, `bank-preferred-routing.md`,
  `people-bank-card.md`.
- **Corrections:** plan `:475-481`, `:565-568`, `:572-576`; meeting `:52`, `:75-77`;
  `employee-dashboard-cache.md:118-126`; `employee-id-card.md:217-221`.
- **Stale citations fixed in passing:** `audit-2026-09-10:309` and
  `pre-release-security-readiness.md:92` both locate `SHOW_UNPAID_STAGED_PAYSTUBS` at
  `paystub/route.ts:68`; it moved to `src/lib/payroll/employee-paystubs.ts:77`.
- **`docs/reference/components.md:692`** still describes the Profile as having "three tabs".
- **Doc-vs-doc contradiction to resolve, not act on:**
  `pre-release-security-readiness.md:104` and `audit-2026-09-09:295-296` say the
  `formatStartDate` off-by-one puts the wrong date on every **ID card**, while
  `employee-id-card.md:67` says *"Until then the ID card is the correct one."* The code confirms
  the feature doc — the card uses `parseDateOnlyLocal`. The readiness doc and the 09-09 audit are
  the ones needing correction.
- **Memory entry** for the merged surface, plus an Open-items row in the newest session log
  recording the Wave 4 approval and §10's open questions.
- **Git:** stage by explicit path, commit directly to `main`, never push. The working tree
  already carries unrelated in-flight work (`proxy.ts`, `GiftShippingCard.tsx`,
  `app/api/gift-address/`, `src/lib/otp/`) — `git status` re-run immediately before commit.
