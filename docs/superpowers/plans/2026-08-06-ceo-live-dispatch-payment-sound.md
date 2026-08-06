# CEO Live Dispatch Payment Sound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every person who gets marked paid while the CEO's "Live payroll processing" modal (Live Dispatch view) is open triggers the existing "Payment Confirmed" chime — once per person, never replaying the backlog already in the feed when the modal opens.

**Architecture:** A new pure helper (`selectNewlyPaidEntries`) diffs the feed's current recipient emails against a "seen" set kept in a ref inside `PaymentsFeedRail`. New arrivals get `playPaymentConfirmed()` (already used by Accounting's Mark Paid flow), staggered so simultaneous arrivals don't overlap into one chord, and the sound-tester reference page's existing "Payment Confirmed" card gets a second call site noted in its description.

**Tech Stack:** Next.js app router, React client component (`CeoPayrollLive.tsx`), Web Audio (existing `src/lib/sound/ping-chime.ts`), `node --import tsx --test` for the pure module.

**Spec:** `docs/superpowers/specs/2026-08-06-ceo-live-dispatch-payment-sound-design.md` (approved).

## Global Constraints

- **NEVER `git push`** — Kane handles git. Commit locally only, to `main`.
- **Multi-session shared checkout:** this working tree has unrelated uncommitted changes from other in-progress work (e.g. `app/api/payment-dispatches/route.ts`, several `payroll-clerk` components — see `git status --short`). `git add` ONLY the exact files each task names below — never `-A`, `-u`, or `.`. Re-run `git status --short` before every commit to confirm you're only staging what this plan touches.
- **Locate edits by searching the quoted code, not by line number.** Other sessions may shift line numbers between now and execution.
- **Live production DB:** `.env.local` holds production service-role credentials. Nothing in this plan touches the database — no task should add DB calls.
- **No `next build`.** A dev server may already be running against the shared `.next/` directory — check for one before starting `npm run dev`. Verification = `npm run lint` (`tsc --noEmit`) + targeted `node --import tsx --test <file>`, plus one manual pass in the existing running app for Task 2.
- **Sound scope is fixed by the approved spec:** the chime plays ONLY while the Live Dispatch modal is open — never in the background. It reuses `playPaymentConfirmed()` verbatim; this plan does not create a new sound cue, a mute/volume control, or touch Accounting's own Mark Paid sound.
- Commit style: conventional commits; body ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

### Task 1: `selectNewlyPaidEntries` pure helper

**Files:**
- Create: `src/lib/ceo/newly-paid-feed.ts`
- Create: `src/lib/ceo/newly-paid-feed.test.ts`

**Interfaces:**
- Consumes: `PaidFeedEntry` type from `@/hooks/usePaymentsLive` — `{ email: string; name: string | null; amountUsd: number | null; amountPhp: number | null; amountCop: number | null; paidAt: string }`. Import it with `import type` only — that module is a `'use client'` React hook file (React + Supabase browser client); a value import would pull that into the Node test run.
- Produces (Task 2 relies on this EXACT name/signature): `selectNewlyPaidEntries(recent: PaidFeedEntry[], seen: ReadonlySet<string>): PaidFeedEntry[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ceo/newly-paid-feed.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { selectNewlyPaidEntries } from "./newly-paid-feed";
import type { PaidFeedEntry } from "@/hooks/usePaymentsLive";

function entry(over: Partial<PaidFeedEntry> & { email: string }): PaidFeedEntry {
  return {
    name: null,
    amountUsd: null,
    amountPhp: null,
    amountCop: null,
    paidAt: "2026-08-06T00:00:00.000Z",
    ...over,
  };
}

test("returns entries whose email is not in the seen set, in feed order", () => {
  const recent = [entry({ email: "a@simple.biz" }), entry({ email: "b@simple.biz" })];
  const seen = new Set(["a@simple.biz"]);
  const result = selectNewlyPaidEntries(recent, seen);
  assert.deepEqual(result.map((e) => e.email), ["b@simple.biz"]);
});

test("returns an empty array when every email has already been seen", () => {
  const recent = [entry({ email: "a@simple.biz" })];
  assert.deepEqual(selectNewlyPaidEntries(recent, new Set(["a@simple.biz"])), []);
});

test("returns all entries when the seen set is empty", () => {
  const recent = [entry({ email: "a@simple.biz" }), entry({ email: "b@simple.biz" })];
  const result = selectNewlyPaidEntries(recent, new Set());
  assert.deepEqual(result.map((e) => e.email), ["a@simple.biz", "b@simple.biz"]);
});

test("an empty feed returns an empty array regardless of seen", () => {
  assert.deepEqual(selectNewlyPaidEntries([], new Set(["a@simple.biz"])), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test "src/lib/ceo/newly-paid-feed.test.ts"`
Expected: FAIL — `newly-paid-feed.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/ceo/newly-paid-feed.ts`:

```ts
import type { PaidFeedEntry } from '@/hooks/usePaymentsLive';

/**
 * Entries in `recent` whose email isn't yet in `seen` — payments that have
 * appeared in the feed since the caller last checked. Preserves the feed's
 * own order (newest-first).
 */
export function selectNewlyPaidEntries(
  recent: PaidFeedEntry[],
  seen: ReadonlySet<string>,
): PaidFeedEntry[] {
  return recent.filter((entry) => !seen.has(entry.email));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test "src/lib/ceo/newly-paid-feed.test.ts"`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no new errors from either new file.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ceo/newly-paid-feed.ts src/lib/ceo/newly-paid-feed.test.ts
git commit -m "$(cat <<'EOF'
feat(ceo): add selectNewlyPaidEntries helper for Live Dispatch sound

Pure diff of the payments-live feed against a seen-emails set, so the
next task can trigger one chime per newly-paid person without
replaying the existing backlog.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the chime into `PaymentsFeedRail` + update the sound reference page

**Files:**
- Modify: `src/components/ceo/CeoPayrollLive.tsx` (imports block, `PaymentsFeedRail`)
- Modify: `references/sound-tester/sound-tester.html` (the "Payment Confirmed" cue's `desc`)

**Interfaces:**
- Consumes: `selectNewlyPaidEntries` from Task 1 (`@/lib/ceo/newly-paid-feed`); `playPaymentConfirmed` from `@/lib/sound/ping-chime` (existing export, `(): void`).
- Produces: nothing — this is the final task.

- [ ] **Step 1: Add the two new imports**

In `src/components/ceo/CeoPayrollLive.tsx`, find the tail of the existing import block:

```tsx
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
```

Add immediately after it:

```tsx
import { playPaymentConfirmed } from '@/lib/sound/ping-chime';
import { selectNewlyPaidEntries } from '@/lib/ceo/newly-paid-feed';
```

- [ ] **Step 2: Add the stagger constant and sound effect to `PaymentsFeedRail`**

Find:

```tsx
function PaymentsFeedRail({ payments }: { payments: PaymentsLiveState }) {
  const feed = payments.recent;
  return (
```

Replace with:

```tsx
// Staggered so a burst of payments landing in one feed refresh reads as a
// rapid cascade instead of firing all at once as a single chord.
const PAID_SOUND_STAGGER_MS = 160;

function PaymentsFeedRail({ payments }: { payments: PaymentsLiveState }) {
  const feed = payments.recent;

  // Recipient emails already accounted for (sounded, or present when this
  // instance first mounted). Lives for as long as the modal stays open —
  // PaymentsFeedRail unmounts when the dialog closes, so reopening starts fresh.
  const seenEmailsRef = useRef<Set<string>>(new Set());
  const hasSeededRef = useRef(false);
  const pendingChimesRef = useRef<number[]>([]);
  const nextChimeAtRef = useRef(0);

  useEffect(() => {
    if (!hasSeededRef.current) {
      // The feed can already hold up to 60 past payments when the modal
      // opens mid-cycle — remember them silently, don't chime for history.
      hasSeededRef.current = true;
      feed.forEach((p) => seenEmailsRef.current.add(p.email));
      return;
    }
    const newlyPaid = selectNewlyPaidEntries(feed, seenEmailsRef.current);
    const now = Date.now();
    newlyPaid.forEach((p) => {
      seenEmailsRef.current.add(p.email);
      const playAt = Math.max(now, nextChimeAtRef.current);
      pendingChimesRef.current.push(window.setTimeout(playPaymentConfirmed, playAt - now));
      nextChimeAtRef.current = playAt + PAID_SOUND_STAGGER_MS;
    });
  }, [feed]);

  // Unmount only (modal closed): drop any chimes still queued so nothing
  // plays for a person after the CEO has stopped watching this feed.
  useEffect(() => {
    return () => {
      pendingChimesRef.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  return (
```

- [ ] **Step 3: Update the sound reference page**

In `references/sound-tester/sound-tester.html`, find the "Payment Confirmed" entry in the `CUES` array:

```js
  {
    name: 'Payment Confirmed',
    fn: playPaymentConfirmed,
    where: "ping-chime.ts · playPaymentConfirmed()",
    desc: 'Accounting → Payment Dispatch: plays when a payment is marked paid and “Confirm sent” succeeds. Crisp tick + warm rising resolve.',
  },
```

Replace its `desc` line with:

```js
    desc: 'Accounting → Payment Dispatch: plays when a payment is marked paid and “Confirm sent” succeeds. Also plays on the CEO’s Live Dispatch “Being paid now” feed for every new person paid. Crisp tick + warm rising resolve.',
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no new errors in `CeoPayrollLive.tsx`.

- [ ] **Step 5: Manual verification**

`sound-tester.html` is a standalone static file, not part of the Next.js build — open it directly in a browser (e.g. `start references/sound-tester/sound-tester.html` on Windows) and click the "Payment Confirmed" card's Play button once to confirm the page still loads and the cue still plays, then re-read its updated description.

For the actual feature, use whatever dev server is already running for this project (check before starting a new `npm run dev` — see Global Constraints):

1. Sign in as CEO, open Overview, open the "Live payroll processing" modal.
2. Confirm opening it plays no sound even if payments are already present in the "Being paid now" list.
3. From another session/role with Payment Dispatch access, mark one person paid.
4. Within the CEO tab, confirm the chime plays once as that person's row pops into the feed.
5. Close the modal, mark a second person paid, then reopen the modal — confirm no backlog of chimes fires on reopen (it re-seeds silently), and that the second person's row is now present in the list.

- [ ] **Step 6: Commit**

```bash
git add src/components/ceo/CeoPayrollLive.tsx references/sound-tester/sound-tester.html
git commit -m "$(cat <<'EOF'
feat(ceo): play payment-confirmed chime per person in Live Dispatch feed

Every recipient who newly appears in the CEO's "Being paid now" feed
while the Live Dispatch modal is open now triggers the existing
payment-confirmed cue, staggered for bursts. Silent on open/replay of
the existing feed backlog, and stops the moment the modal is closed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
