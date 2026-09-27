# Accounting dashboard — payroll cycle greeting modal ("Hi Kane")

When an Accounting person opens the Accounting dashboard, a modal greets them by first name. It
shows the **live** payroll cycle's Wizard Setup checklist (Payroll Wizard Steps 1–8) with the
**unfinished steps first**, so they are in the person's face and get fixed right away. Examples:
USD → PHP / COP conversion rates not updated for the cycle, or orphanage hours not synced. Each
item has a **Go to Step N** button that opens the wizard on that step. Mounted by the Accounting
shell (`src/App.tsx`). Built 2026-09-26 for Kane (audit item 234; blueprint answers in
`docs/superpowers/plans/2026-09-26-payroll-cycle-greeting-modal.md`). Committed locally, **not
pushed / not deployed**.

## Key files

| Piece | File |
| --- | --- |
| The modal (fetch, name, open timing, render) | `src/components/accounting/PayrollCycleGreetingModal.tsx` |
| What it says: items, order, headlines, "next up" (pure, tested) | `src/lib/payroll/cycle-greeting.ts` (+ `.test.ts`) |
| Priority order, shared with the Overview card | `openStepsBySeverity` in `src/lib/payroll/wizard-setup-spotlight.ts` |
| Whether a jump is honoured and what it does (pure, tested) | `src/lib/payroll-wizard/step-jump.ts` (+ `.test.ts`) |
| The wizard side of a jump | `PayrollWizard`'s `jumpRequest` prop + its one effect (`src/components/PayrollWizard.tsx`) |
| Gate, mount, `goToWizardStep` / `openPayrollWizard` | `src/App.tsx` |
| "Shown this session" flag | `TAB_CACHE_KEYS.cycleGreetingShown` (`src/lib/accounting/tab-cache.ts`) |
| Readiness snapshot (shared per-week cache) | `src/lib/payroll/readiness-cache.ts` |
| Status pill + step icon | `src/components/accounting/wizard-setup-meta.ts` |

## Who sees it — BOTH tabs, and the server still decides

The shell mounts the modal only after perms **and** page visibility have loaded, and only for a
viewer who can open **the Overview and the Payroll Wizard** (`canAccessAccountingTabForUser` +
`visibilityOf(...) === 'visible'` for each). Kane answered Q1 (a) on 2026-09-26. Overview alone is
not enough, because `overview` is the **fallback landing** (`accounting-tabs.ts:64-68`): anyone
with no other grant lands on it, and most of those people cannot read the checklist.

The data comes from `GET /api/payroll-wizard/readiness`, whose own gate is the
`accounting.payroll_wizard` **view** grant. **A 401/403 or any failed read means the modal never
opens.** It never greets someone with empty, cached or made-up steps.

## When it opens

- **At most once per browser session** (Q2 a). The flag is a UI value in the Accounting tab cache
  (`cycleGreetingShown`, value `true`). That store's lifetime is exactly "once per session": it is
  stamped with the viewer's identity, purged on sign-out and on a viewer swap, and treated as absent
  after 12h. The flag is written **only when the modal actually opens**. If the shell unmounts, or
  another dialog stays up for 20s, the next load tries again.
- **Only when something is unfinished** (Q4 "don't open"): `buildCycleGreeting(...).shouldOpen`
  is `items.length > 0`. A fully done cycle with no newer closed week never opens.
- **About 600ms after the data is ready**, so it lands after the dashboard has painted. The
  shared dialog's own open animation (fade + zoom from 0.94 + a small rise) runs, then the items
  animate in one by one (reduced motion: fade only).
- **Never over another dialog.** While any `[data-slot="dialog-content"]` / `role="dialog"` /
  `role="alertdialog"` is open, for example the Start Processing broadcast or Penny's greeting
  balloon, it re-checks every second for up to 20s, then gives up for this load.
- It waits up to 1.5s for the viewer's real name (`/api/employees?email=` + `resolveFirstName`,
  the Overview hero's lookup), then falls back to the email-derived first name.

## What it shows — the checklist as sent

- **The week** is the live cycle: `?source_file` is omitted, so the server picks the newest
  `is_current` upload, which is the **same rule the wizard uses** for its live period
  (`pickCurrentSourceFile` / `loadUploadedSourceFiles`). The modal and the wizard therefore
  describe the same week.
- **Every status, detail and step number is `wizardSetup` as the server derived it.**
  `buildCycleGreeting` adds only a **headline per step key**, such as "Update the USD → PHP / COP
  conversion rates" or "Sync the orphanage hours", and it does so only for actionable
  (`attention` / `blocked`) rows. A `pending` row keeps its plain label, because `pending` can mean
  "not sent yet", "nothing due" or "couldn't read", and an imperative would claim a problem the row
  doesn't prove. The detail under it is the server's string, untouched ("PHP still 0 — Step 2",
  "COP still 0 — Step 2", "Paste hours or confirm none on Step 3"). The one exception: a CSV row at
  `attention` means the newest upload's **name** is unparseable, so it reads "Check…", not
  "Upload…".
- **Order:** a later pay week that has **closed with no CSV** (`awaitingWeekLabel`) leads, as
  "Upload the Sep 20 – Sep 26 Hubstaff CSV" (Q5 a). Its Step 1 jump carries no file, since there is
  nothing to point at yet. After it come the open rows, **most severe first** (`blocked` →
  `attention` → `pending`, with rail order breaking ties). That is `openStepsBySeverity`, the same
  function the Overview card uses, so the two can never disagree about what to fix first. Done
  rows fold into one "Done:" line.
- **"You're on Step N · label"** is **derived**: the first unfinished row in **rail** order for the
  cycle in view. If that cycle is fully done and a closed week is waiting, it names that week's CSV
  instead. The wizard's own `currentStep` is in-memory state (resets to 1 on mount), and a
  processing driver's step is **broadcast only** (`useWizardFollow`), so nothing stored can say
  which screen anyone is on. The wording never claims a person is on a step.

## "Go to Step N" — never more than a rail click

Kane chose per-item jumps (Q3). A jump's rule is `planWizardJump`, and a jump can never do more
than clicking the wizard's own step rail:

- **Edit grant only.** The wizard tab is wrapped in `ReadOnlyTab strict` because "a view-only user
  must not touch its step / department navigation" (`App.tsx`). So the modal passes
  `canJump = canEditAccountingTab('payroll-wizard', …)`. A view-only viewer sees no Go buttons and
  gets a line saying someone with edit access has to make the changes. **Open Payroll Wizard**
  still works for them.
- **Refused while spectating** another operator's processing run. The rail sits behind the
  spectator overlay then, and the follow channel would snap the step back anyway. The wizard
  toasts "<driver> is running this cycle — you're following their step."
- **The cycle only ever switches BACK to the live period.** If the wizard is replaying an older
  week and the jump names the newest upload, it returns to the current period, the same move as the
  replay banner's "Return to current period". It **never** switches into a replay, even if the
  request names an older file.
- Step 4 (PAB) exists on the rail only in the payout week. A request for it outside that week lands
  on 5, the step the rail's Next skips to. The checklist never asks for 4 or 7 today.
- Mechanics: `App.tsx` sets `wizardJump = { step, sourceFile, nonce }`, flips the Payroll Wizard
  tab off the **Interns** rail if needed, and navigates. `PayrollWizard` applies each `nonce`
  **once**, after its upload list has loaded, so it also works on the first visit before the wizard
  was ever mounted. It stays mounted afterwards (`payroll-wizard-tab-persist`).

## Things that look like bugs but aren't

- **It didn't open, and there is plenty to fix.** Check, in this order: it already opened this
  session; the viewer lacks the Payroll Wizard grant (403); another dialog was up for 20s; the
  readiness read failed. Every one of these fails closed.
- **The first landing makes two readiness pulls.** The modal reads the live week (cache key `''`)
  and the Overview card reads the selected upload (its filename key). This happens once per session.
- **Penny's greeting balloon delays it.** That balloon carries `role="dialog"`; waiting for it is
  deliberate so the two never stack.

## Deploy notes

**No migration.** No new route, env var, grant or n8n import. Client-only, plus one new optional
prop on `PayrollWizard`. **PENDING:** push, then a production click-through: the populated modal,
a view-only viewer (no Go buttons), a viewer without the wizard grant (never opens), a jump from a
replayed week, and a jump while spectating. Also `next build`, skipped because a dev server was
live on :3000.
