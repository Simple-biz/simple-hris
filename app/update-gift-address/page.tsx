'use client';

import { useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  CheckCircle2,
  Gift,
  Heart,
  Loader2,
  Mail,
  MapPin,
  Package,
  PartyPopper,
  Phone,
  ShieldCheck,
  Shirt,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { APPAREL_SIZES, HEARTS_FLOAT } from '@/lib/gift-tracker/milestone-copy';

/**
 * PUBLIC tenure-gift address page. No login.
 *
 * Someone types their Simple.biz address, receives a 6-digit code in that work
 * inbox, then sees every tenure gift they have reached since their start date
 * and gives one delivery address covering the ones still waiting.
 *
 * It exists because HRIS is not public yet and the gifts recorded as owed have
 * no other collection path — the in-app form only ever asks about the milestone
 * whose 30-day window is open.
 *
 * SHAPE AND COPY COME FROM THE SAME MODULE AS THE EMPLOYEE DASHBOARD CARD
 * (`@/lib/gift-tracker/milestone-copy`), so the thank-you a person reads here is
 * the one they would read signed in. A second copy would drift.
 *
 * Nothing on this page can mark a gift RECEIVED — it writes an address and
 * nothing else. See app/api/gift-address/save/route.ts.
 */

type Step = 'email' | 'code' | 'gifts' | 'done';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Milestone {
  milestoneIndex: number;
  date: string;
  label: string;
  tenure: string;
  message: string;
  state: 'received' | 'pending';
  hasAddress: boolean;
}

/** Shared animated ornaments — the same recipe as the dashboard gift card. */
function GiftKeyframes() {
  return (
    <style>{`
      @keyframes floatHeart {
        0%   { transform: translateY(8px)   scale(0.85) rotate(var(--heart-rot)); opacity: 0; }
        10%  { opacity: 0.55; }
        60%  { opacity: 0.35; }
        100% { transform: translateY(-120px) scale(0.45) rotate(var(--heart-rot)); opacity: 0; }
      }
      @keyframes giftWiggle {
        0%, 100% { transform: rotate(-8deg) scale(1); }
        45%      { transform: rotate(-2deg) scale(1.06); }
        55%      { transform: rotate(-14deg) scale(1.06); }
      }
    `}</style>
  );
}

function FloatingHearts() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {HEARTS_FLOAT.map((h, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            bottom: 0,
            left: h.left,
            ['--heart-rot' as string]: `${h.rotate}deg`,
            animation: `floatHeart ${h.dur} ease-in ${h.delay} infinite`,
          }}
        >
          <Heart
            className="text-white/70"
            style={{ width: h.size, height: h.size }}
            fill="currentColor"
            strokeWidth={0}
          />
        </span>
      ))}
    </div>
  );
}

function GiftSticker() {
  return (
    <div className="relative shrink-0">
      <span aria-hidden className="absolute -inset-2 rounded-full bg-white/30 blur-md" />
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-white via-pink-50 to-fuchsia-100 text-pink-600 shadow-lg shadow-pink-900/30 ring-4 ring-white/80 sm:h-16 sm:w-16"
        style={{ transform: 'rotate(-8deg)', animation: 'giftWiggle 3.6s ease-in-out infinite' }}
      >
        <Gift className="h-7 w-7 sm:h-8 sm:w-8" strokeWidth={2.5} />
      </span>
    </div>
  );
}

export default function UpdateGiftAddressPage() {
  const [step, setStep] = useState<Step>('email');
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [name, setName] = useState('');

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [receivedCount, setReceivedCount] = useState(0);
  const [blocked, setBlocked] = useState<'missing' | 'shared' | null>(null);

  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [size, setSize] = useState('');
  const [notes, setNotes] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  const requestCode = async () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      toast.error('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/gift-address/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e }),
      });
      const json = (await res.json()) as { message?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not send the code.');
      // The answer is deliberately the same whether or not the address belongs to
      // anyone, so the page advances either way — it must not become a way to
      // find out who works here.
      toast.success(json.message ?? 'Check your work inbox.');
      setStep('code');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  const loadGifts = useCallback(async (token: string) => {
    const res = await fetch('/api/gift-address/owed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: token }),
    });
    const json = (await res.json()) as {
      name?: string;
      milestones?: Milestone[];
      pendingCount?: number;
      receivedCount?: number;
      blocked?: 'missing' | 'shared' | null;
      prefill?: { location: string; contact: string; size: string; notes: string };
      error?: string;
    };
    if (!res.ok || json.error) throw new Error(json.error ?? 'Could not load your gifts.');
    setName(json.name ?? '');
    setMilestones(json.milestones ?? []);
    setPendingCount(json.pendingCount ?? 0);
    setReceivedCount(json.receivedCount ?? 0);
    setBlocked(json.blocked ?? null);
    if (json.prefill) {
      setLocation(json.prefill.location);
      setContact(json.prefill.contact);
      setSize(json.prefill.size);
      setNotes(json.prefill.notes);
    }
  }, []);

  const verifyCode = async () => {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      toast.error('The code is 6 digits.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/gift-address/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code: c }),
      });
      const json = (await res.json()) as { sessionToken?: string; error?: string };
      if (!res.ok || json.error || !json.sessionToken) {
        throw new Error(json.error ?? 'That code did not work.');
      }
      setSessionToken(json.sessionToken);
      await loadGifts(json.sessionToken);
      setStep('gifts');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That code did not work.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!location.trim()) {
      toast.error('Enter a delivery address.');
      return;
    }
    if (!contact.trim()) {
      toast.error('Enter a contact number.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/gift-address/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken, location, contact, size, notes }),
      });
      const json = (await res.json()) as { saved?: number[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not save.');
      setSavedCount(json.saved?.length ?? 0);
      setStep('done');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const firstName = name ? name.replace(/"[^"]*"/g, '').split(/[,\s]+/).filter(Boolean)[1] ?? '' : '';

  return (
    <main className="min-h-dvh bg-gradient-to-br from-pink-50 via-white to-fuchsia-50 px-4 py-8 dark:from-pink-950/40 dark:via-zinc-950 dark:to-fuchsia-950/30 sm:px-6 sm:py-12">
      <GiftKeyframes />

      <div className="mx-auto w-full max-w-2xl">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-pink-500 via-rose-500 to-fuchsia-600 px-5 py-7 text-white shadow-xl shadow-pink-500/25 sm:px-8 sm:py-9">
          <FloatingHearts />
          <div className="relative flex items-center gap-4">
            <GiftSticker />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-pink-100/95">
                Simple.biz
              </p>
              <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                {step === 'done'
                  ? 'All set — thank you!'
                  : firstName
                    ? `Your tenure gifts, ${firstName}`
                    : 'Your tenure gift'}
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-pink-50/90">
                {step === 'done'
                  ? 'We have your address. Your gift is on our list.'
                  : 'Every 6 months with us earns a gift. Tell us where to send yours.'}
              </p>
            </div>
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="mt-5"
          >
            {/* ── Step 1: email ──────────────────────────────────────────── */}
            {step === 'email' && (
              <section className="rounded-2xl border border-pink-100 bg-white/90 p-5 shadow-sm backdrop-blur-sm sm:p-6 dark:border-pink-950/50 dark:bg-zinc-950/80">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-pink-700 dark:text-pink-300">
                  <Mail className="h-4 w-4" />
                  Start with your Simple.biz email
                </div>
                <Label htmlFor="gift-email" className="text-xs text-zinc-600 dark:text-zinc-400">
                  Work email
                </Label>
                <Input
                  id="gift-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !busy && void requestCode()}
                  placeholder="you@simple.biz"
                  className="mt-1.5 border-pink-200/80 bg-white dark:border-pink-900/50 dark:bg-zinc-900"
                />
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  We&rsquo;ll send a 6-digit code to that inbox to make sure it&rsquo;s you. Only
                  current team members can use this page.
                </p>
                <Button
                  onClick={() => void requestCode()}
                  disabled={busy}
                  className="mt-4 w-full bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-md shadow-pink-600/30 hover:brightness-110 sm:w-auto"
                >
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  Send my code
                </Button>
              </section>
            )}

            {/* ── Step 2: code ───────────────────────────────────────────── */}
            {step === 'code' && (
              <section className="rounded-2xl border border-pink-100 bg-white/90 p-5 shadow-sm backdrop-blur-sm sm:p-6 dark:border-pink-950/50 dark:bg-zinc-950/80">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-pink-700 dark:text-pink-300">
                  <ShieldCheck className="h-4 w-4" />
                  Enter the code we emailed you
                </div>
                <Input
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && !busy && void verifyCode()}
                  placeholder="000000"
                  aria-label="6-digit code"
                  className="border-pink-200/80 bg-white text-center text-2xl font-bold tracking-[0.5em] dark:border-pink-900/50 dark:bg-zinc-900"
                />
                <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Sent to your work inbox. It expires in 10 minutes.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void verifyCode()}
                    disabled={busy}
                    className="bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-md shadow-pink-600/30 hover:brightness-110"
                  >
                    {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Confirm
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setCode('');
                      setStep('email');
                    }}
                    disabled={busy}
                    className="text-zinc-600 hover:text-pink-700 dark:text-zinc-300"
                  >
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    Use a different email
                  </Button>
                </div>
              </section>
            )}

            {/* ── Step 3: the gifts + the address ─────────────────────────── */}
            {step === 'gifts' && (
              <div className="flex flex-col gap-5">
                {/* Summary */}
                <section className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-pink-100 bg-white/90 px-4 py-3.5 dark:border-pink-950/50 dark:bg-zinc-950/80">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-pink-600 dark:text-pink-400">
                      <Package className="h-3.5 w-3.5" />
                      Waiting to be sent
                    </div>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
                      {pendingCount}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-emerald-100 bg-white/90 px-4 py-3.5 dark:border-emerald-950/50 dark:bg-zinc-950/80">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Already received
                    </div>
                    <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
                      {receivedCount}
                    </p>
                  </div>
                </section>

                {/* Timeline */}
                <section className="rounded-2xl border border-pink-100 bg-white/90 p-5 shadow-sm dark:border-pink-950/50 dark:bg-zinc-950/80 sm:p-6">
                  <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-pink-700 dark:text-pink-300">
                    <Gift className="h-4 w-4" />
                    Your milestones so far
                  </h2>

                  {milestones.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-pink-200 bg-pink-50/50 px-4 py-6 text-center text-sm text-pink-900 dark:border-pink-900/50 dark:bg-pink-950/20 dark:text-pink-100">
                      You haven&rsquo;t reached your first 6-month milestone yet — we&rsquo;ll be in
                      touch when you do.
                    </p>
                  ) : (
                    <ol className="relative ml-1 flex flex-col gap-3 border-l-2 border-pink-200/70 pl-5 dark:border-pink-900/60">
                      {milestones.map((m, i) => (
                        <motion.li
                          key={m.milestoneIndex}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.24 }}
                          className="relative"
                        >
                          <span
                            aria-hidden
                            className={cn(
                              'absolute -left-[27px] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white dark:ring-zinc-950',
                              m.state === 'received'
                                ? 'bg-gradient-to-br from-emerald-500 to-teal-600'
                                : 'bg-gradient-to-br from-pink-500 to-rose-600',
                            )}
                          />
                          <div
                            className={cn(
                              'rounded-xl border px-3.5 py-3',
                              m.state === 'received'
                                ? 'border-emerald-200/70 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/25'
                                : 'border-pink-200/70 bg-pink-50/60 dark:border-pink-900/50 dark:bg-pink-950/25',
                            )}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[13px] font-bold text-zinc-900 dark:text-zinc-50">
                                {m.tenure}
                              </span>
                              <span
                                className={cn(
                                  'text-[11px]',
                                  m.state === 'received'
                                    ? 'text-emerald-800/70 dark:text-emerald-200/70'
                                    : 'text-pink-800/70 dark:text-pink-200/70',
                                )}
                              >
                                {new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </span>
                              <span
                                className={cn(
                                  'ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                                  m.state === 'received'
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                    : 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
                                )}
                              >
                                {m.state === 'received' ? 'Received' : 'Waiting'}
                              </span>
                            </div>
                            {/* Ink warms WITH its ground — neutral zinc on a
                                tinted fill reads washed out, the same rule the
                                My Hours tiles follow. */}
                            <p
                              className={cn(
                                'mt-1.5 text-[12px] leading-relaxed',
                                m.state === 'received'
                                  ? 'text-emerald-900/85 dark:text-emerald-100/85'
                                  : 'text-pink-900/85 dark:text-pink-100/85',
                              )}
                            >
                              {m.message}
                            </p>
                          </div>
                        </motion.li>
                      ))}
                    </ol>
                  )}
                </section>

                {/* Address form — or the reason we cannot take one */}
                {blocked ? (
                  <section className="rounded-2xl border border-amber-200 bg-amber-50/80 p-5 dark:border-amber-900/50 dark:bg-amber-950/25 sm:p-6">
                    <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                      We need HR to sort one thing first
                    </h2>
                    <p className="mt-2 text-[13px] leading-relaxed text-amber-900/90 dark:text-amber-100/90">
                      {blocked === 'missing'
                        ? 'We don’t have a personal email on file for you, which we need to file your address safely.'
                        : 'Our records show your personal email shared with another teammate, so filing an address here could mix up your gifts.'}{' '}
                      Please message HR and they&rsquo;ll fix it in a moment.
                    </p>
                  </section>
                ) : pendingCount === 0 ? (
                  <section className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-6 text-center dark:border-emerald-900/50 dark:bg-emerald-950/25">
                    <PartyPopper className="mx-auto h-7 w-7 text-emerald-600 dark:text-emerald-400" />
                    <p className="mt-2 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                      You&rsquo;re all caught up
                    </p>
                    <p className="mt-1 text-[13px] text-emerald-900/80 dark:text-emerald-100/80">
                      Every gift you&rsquo;ve earned so far has been sent. Nothing to do here.
                    </p>
                  </section>
                ) : (
                  <section className="rounded-2xl border border-pink-100 bg-white/90 p-5 shadow-sm dark:border-pink-950/50 dark:bg-zinc-950/80 sm:p-6">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-pink-700 dark:text-pink-300">
                      <MapPin className="h-4 w-4" />
                      Where should we send {pendingCount === 1 ? 'it' : 'them'}?
                    </h2>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      One address covers {pendingCount === 1 ? 'the gift' : `all ${pendingCount} gifts`} above.
                    </p>

                    <div className="mt-4 flex flex-col gap-4">
                      <div>
                        <Label htmlFor="gift-loc" className="text-xs text-zinc-600 dark:text-zinc-400">
                          Delivery address
                        </Label>
                        <textarea
                          id="gift-loc"
                          value={location}
                          onChange={(e) => setLocation(e.target.value)}
                          rows={3}
                          maxLength={500}
                          placeholder="House/unit, street, barangay, city, province, postal code"
                          className="mt-1.5 w-full rounded-md border border-pink-200/80 bg-white px-3 py-2 text-sm outline-none ring-pink-500/30 focus:ring-2 dark:border-pink-900/50 dark:bg-zinc-900"
                        />
                      </div>

                      <div>
                        <Label htmlFor="gift-contact" className="text-xs text-zinc-600 dark:text-zinc-400">
                          <Phone className="mr-1 inline h-3 w-3" />
                          Contact number
                        </Label>
                        <Input
                          id="gift-contact"
                          inputMode="tel"
                          value={contact}
                          onChange={(e) => setContact(e.target.value)}
                          maxLength={60}
                          placeholder="09XX XXX XXXX"
                          className="mt-1.5 border-pink-200/80 bg-white dark:border-pink-900/50 dark:bg-zinc-900"
                        />
                      </div>

                      <div>
                        <Label className="text-xs text-zinc-600 dark:text-zinc-400">
                          <Shirt className="mr-1 inline h-3 w-3" />
                          Shirt size{' '}
                          <span className="font-normal text-zinc-400">
                            — optional, not every gift is apparel
                          </span>
                        </Label>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {APPAREL_SIZES.map((s) => {
                            const active = size === s;
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={() => setSize(active ? '' : s)}
                                aria-pressed={active}
                                className={cn(
                                  'min-w-[44px] rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                                  active
                                    ? 'border-pink-600 bg-pink-600 text-white shadow-sm'
                                    : 'border-pink-200 text-pink-700 hover:bg-pink-50 hover:text-pink-900 dark:border-pink-900/60 dark:text-pink-300 dark:hover:bg-pink-950/40 dark:hover:text-pink-100',
                                )}
                              >
                                {s}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="gift-notes" className="text-xs text-zinc-600 dark:text-zinc-400">
                          Anything else we should know?{' '}
                          <span className="font-normal text-zinc-400">— optional</span>
                        </Label>
                        <textarea
                          id="gift-notes"
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          rows={2}
                          maxLength={500}
                          placeholder="Landmark, best delivery time, anything that helps it arrive"
                          className="mt-1.5 w-full rounded-md border border-pink-200/80 bg-white px-3 py-2 text-sm outline-none ring-pink-500/30 focus:ring-2 dark:border-pink-900/50 dark:bg-zinc-900"
                        />
                      </div>

                      <Button
                        onClick={() => void save()}
                        disabled={busy}
                        className="w-full bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-md shadow-pink-600/30 hover:brightness-110 sm:w-auto sm:self-start"
                      >
                        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                        Save my address
                      </Button>
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* ── Step 4: done ───────────────────────────────────────────── */}
            {step === 'done' && (
              <section className="relative overflow-hidden rounded-2xl border border-pink-100 bg-white/90 p-8 text-center shadow-sm dark:border-pink-950/50 dark:bg-zinc-950/80">
                <motion.div
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                  className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-lg shadow-pink-500/35"
                >
                  <CheckCircle2 className="h-8 w-8" />
                </motion.div>
                <h2 className="mt-4 text-lg font-bold text-zinc-900 dark:text-zinc-50">
                  Address saved
                </h2>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                  We&rsquo;ve noted it for{' '}
                  <strong className="font-semibold text-pink-700 dark:text-pink-300">
                    {savedCount} {savedCount === 1 ? 'gift' : 'gifts'}
                  </strong>
                  . You can close this page — someone from the team will take it from here.
                </p>
              </section>
            )}
          </motion.div>
        </AnimatePresence>

        <p className="mt-6 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
          Simple.biz · This page only collects a delivery address.
        </p>
      </div>
    </main>
  );
}
