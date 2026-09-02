# Payment Dispatch "paid" toast — lower-left, every Accounting tab

**Date:** 2026-09-02 · **Approved:** Kane, same day (Q1: every Accounting tab, every
permission; Q2: chime on remote screens too; Q3 unanswered → the standalone /payroll-clerk
shell stays out).

While processing is ON, every open Accounting dashboard shows one card in the lower-left per
Paid dispatch row — `lenny@simple.biz paid kaner@simple.biz  $2,700.00` (₱ small beneath) —
sliding in from the left, resting ~6 s, then fading out to the right. The paying browser
shows it instantly from its own Mark Paid handler; every other Accounting screen gets it over
a new Realtime **Broadcast** topic `payment-dispatch-paid` (RLS never lets `postgres_changes`
on `payment_dispatches` reach the anon browser — `docs/features/payment-dispatch.md` §5.1.1).

Precedent: the CEO "Being paid now" rail (`CeoPayrollLive.tsx` PaymentsFeedRail) for the
event + the USD-lead/PHP-small amount, `CarlaSongToast.tsx` for an own fixed toast with
reduced-motion-guarded motion, and `usePaymentsLivePublisher` for Accounting publishing on
a Broadcast topic.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `src/lib/payroll/dispatch-paid-toast.ts` — pure: `PaidToastEvent` shape,
      `PAID_TOAST_TOPIC`/`PAID_TOAST_EVENT` constants (own topic, never
      `payment-dispatch-sync`), `shouldAnnouncePaid(status, locked)`, `formatPaidLine`,
      `paidAmountParts` (USD lead → PHP small; COP-only payee → COP lead), `pushPaidToast`
      (dedupe by id, cap 4 oldest-drops), `parsePaidToastPayload` (shape guard).
      `dispatch-paid-toast.test.ts` beside it (node:test).
- [x] 2. `src/hooks/useDispatchPaidToasts.ts` — subscribes the topic (`self: false`), keeps
      the stack in state, `announce(evt)` pushes locally AND broadcasts, `dismiss(id)`,
      per-toast auto-dismiss timer, clears the stack when `locked` flips false. Remote
      arrivals play `playPaymentConfirmed` (staggered 160 ms like the CEO rail); local
      arrivals do NOT — MarkPaidDialog already chimed on that browser.
- [x] 3. `src/components/accounting/DispatchPaidToasts.tsx` — fixed bottom-left stack,
      `motion/react` AnimatePresence: enter x −48→0 + fade, exit x 0→+24 + fade;
      `useReducedMotion` → opacity only. Emerald paid accent, tabular-nums, dismiss ×.
      Mounts nothing while `locked` is false.
- [x] 4. Wiring — announce from `PayrollDispatch.tsx` handleMarkPaid after each successful
      POST leg when `payload.status === 'paid'` (row id from `json.row`), via a
      document-level CustomEvent so the shell hook picks it up without prop drilling
      (`window.dispatchEvent(new CustomEvent('hris:dispatch-paid', { detail }))` — same
      pattern as `useDispatchLock`'s `hris:dispatch-lock:optimistic`).
- [x] 5. `src/App.tsx` — mount `<DispatchPaidToasts locked={dispatchLock.locked} />` beside
      `<Toaster>`; `useDispatchLock` is already there.
- [x] 6. Typecheck (`tsc --noEmit`; dev server is live so no `next build`) + tests.
- [x] 7. Docs: `docs/features/dispatch-paid-toast.md`, INDEX row, memory
      `dispatch-paid-toast` + MEMORY.md pointer. One commit with the code.

## Follow-up, same day — poll fallback (hardening)

First live test: Kane on localhost, Lenny paying from the production build → nothing appeared.
Broadcast needs the PAYER's browser on this code. Fix: a server poll that does not.

- [x] 8. `listRecentPaidDispatches(sinceIso | null)` in `src/lib/supabase/payment-dispatches.ts` —
      null = watermark only; else PAID rows after `since`, oldest first, `RECENT_PAID_LIMIT` 50 +
      `truncated`, server `now`.
- [x] 9. `app/api/payment-dispatches/recent-paid/route.ts` — GET, same gate as the dispatch list.
- [x] 10. `foldRecentPaidRows` in the toast lib (+ 4 tests): own rows skipped, stale (>90 s by
      server clock) skipped, nobody-rows dropped, oldest first.
- [x] 11. Hook: poll effect while locked + visible, 10 s, immediate on visibilitychange,
      continue-at-once on `truncated` only if the watermark moved, 401/403 stops. `selfEmail`
      threaded from App.tsx through the component.
- [x] 12. Docs rewritten: the "missed toasts are accepted" stance is gone.

