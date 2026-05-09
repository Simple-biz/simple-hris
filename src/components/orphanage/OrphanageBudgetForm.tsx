'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  CheckCircle2,
  HeartHandshake,
  Landmark,
  Loader2,
  Lock,
  PiggyBank,
  Plane,
  Sparkles,
  StickyNote,
  User,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Orphanage Budget Request — single-page form with a sticky live-summary
 * sidebar. The right rail computes everything in real time (no manual
 * "Calculate" buttons), the visit-type chooser is a 3-tile picker, and the
 * remaining sections flow vertically once the type is picked.
 *
 * Persistence is still client-only — `onSubmit` just preventDefaults. Once
 * HR locks the data shape, this hands off to a POST endpoint cleanly: every
 * field already lives in typed local state.
 */

type VisitType = 'monthly' | 'frequent' | 'special' | '';

interface VisitTypeOption {
  value: Exclude<VisitType, ''>;
  label: string;
  blurb: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** tailwind classes for the gradient strip when the tile is selected */
  selectedAccent: string;
}

const VISIT_TYPES: VisitTypeOption[] = [
  {
    value: 'monthly',
    label: 'Monthly Visit',
    blurb: 'Per-category breakdown · gifts, food, travel, misc.',
    Icon: HeartHandshake,
    selectedAccent: 'from-pink-500 to-rose-600',
  },
  {
    value: 'frequent',
    label: 'Frequent Travelers',
    blurb: 'Recurring traveler accommodations + travel amounts.',
    Icon: Plane,
    selectedAccent: 'from-sky-500 to-blue-600',
  },
  {
    value: 'special',
    label: 'Special Project',
    blurb: 'One-off initiative outside the regular cycle.',
    Icon: PiggyBank,
    selectedAccent: 'from-violet-500 to-fuchsia-600',
  },
];

/** Empty / unparseable → 0 so partially-typed values don't break running totals. */
function toNumber(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatPhp(n: number): string {
  return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface BankAccount {
  name: string;
  number: string;
  bankName: string;
  swift: string;
}

interface MonthlyState {
  dateOfVisit: string;
  children: string;
  celebrants: string;
  gift: string;
  lootbag: string;
  cake: string;
  grocery: string;
  food: string;
  travel: string;
  misc: string;
  miscExplain: string;
  collaborators: string;
  leftover: string;
}

const MONTHLY_INIT: MonthlyState = {
  dateOfVisit: '',
  children: '',
  celebrants: '',
  gift: '',
  lootbag: '',
  cake: '',
  grocery: '',
  food: '',
  travel: '',
  misc: '',
  miscExplain: '',
  collaborators: '',
  leftover: '',
};

interface FrequentState {
  travelers: string;
  totalTravel: string;
  leftover: string;
}

const FREQUENT_INIT: FrequentState = {
  travelers: '',
  totalTravel: '',
  leftover: '',
};

interface SpecialState {
  description: string;
  amount: string;
  leftover: string;
}

const SPECIAL_INIT: SpecialState = {
  description: '',
  amount: '',
  leftover: '',
};

const BANK_INIT: BankAccount = {
  name: '',
  number: '',
  bankName: '',
  swift: '',
};

interface OrphanageBudgetFormProps {
  /** Session email from the logged-in user. Pre-fills the requester field
   *  read-only — the form is always submitted on behalf of the signed-in user. */
  viewerEmail?: string | null;
  /** Called after a successful submit. The Orphanage shell uses this to flip
   *  to the Budget History tab so the user sees their newly-created request. */
  onSubmitted?: () => void;
}

export default function OrphanageBudgetForm({
  viewerEmail = null,
  onSubmitted,
}: OrphanageBudgetFormProps = {}) {
  const [visitType, setVisitType] = useState<VisitType>('');

  // Common — email comes from session, date defaults to today; both are
  // read-only since they describe "who's submitting and when" right now.
  const email = viewerEmail ?? '';
  const dateRequested = todayIso();
  const [notes, setNotes] = useState('');
  const [missionTrip, setMissionTrip] = useState<'yes' | 'no'>('no');
  const [bank, setBank] = useState<BankAccount>(BANK_INIT);

  // Visit-specific
  const [monthly, setMonthly] = useState<MonthlyState>(MONTHLY_INIT);
  const [frequent, setFrequent] = useState<FrequentState>(FREQUENT_INIT);
  const [special, setSpecial] = useState<SpecialState>(SPECIAL_INIT);

  // ─── Derived totals ─────────────────────────────────────────────────
  const monthlyTotals = useMemo(() => {
    const directGiving =
      toNumber(monthly.gift) + toNumber(monthly.lootbag) + toNumber(monthly.cake);
    const subtotal =
      directGiving +
      toNumber(monthly.grocery) +
      toNumber(monthly.food) +
      toNumber(monthly.travel) +
      toNumber(monthly.misc);
    const giftEfficiency = subtotal > 0 ? (directGiving / subtotal) * 100 : 0;
    const leftover = toNumber(monthly.leftover);
    const finalAmount = Math.max(0, subtotal - leftover);
    return { directGiving, subtotal, giftEfficiency, leftover, finalAmount };
  }, [monthly]);

  const frequentTotals = useMemo(() => {
    const subtotal = toNumber(frequent.totalTravel);
    const leftover = toNumber(frequent.leftover);
    const finalAmount = Math.max(0, subtotal - leftover);
    return { subtotal, leftover, finalAmount };
  }, [frequent]);

  const specialTotals = useMemo(() => {
    const subtotal = toNumber(special.amount);
    const leftover = toNumber(special.leftover);
    const finalAmount = Math.max(0, subtotal - leftover);
    return { subtotal, leftover, finalAmount };
  }, [special]);

  const finalAmount =
    visitType === 'monthly'
      ? monthlyTotals.finalAmount
      : visitType === 'frequent'
        ? frequentTotals.finalAmount
        : visitType === 'special'
          ? specialTotals.finalAmount
          : 0;

  // ─── Submission readiness ──────────────────────────────────────────
  const requiredCount = useMemo(() => {
    let total = 0;
    let filled = 0;
    const tally = (ok: boolean) => {
      total += 1;
      if (ok) filled += 1;
    };
    tally(email.trim().length > 0);
    tally(dateRequested.trim().length > 0);
    tally(visitType !== '');
    tally(bank.name.trim().length > 0);
    tally(bank.number.trim().length > 0);
    tally(bank.bankName.trim().length > 0);
    tally(bank.swift.trim().length > 0);

    if (visitType === 'monthly') {
      tally(monthly.dateOfVisit.trim().length > 0);
      tally(monthly.children.trim().length > 0);
      tally(monthly.celebrants.trim().length > 0);
      tally(monthlyTotals.subtotal > 0);
      tally(monthly.leftover.trim().length > 0);
    } else if (visitType === 'frequent') {
      tally(frequent.travelers.trim().length > 0);
      tally(frequent.totalTravel.trim().length > 0);
      tally(frequent.leftover.trim().length > 0);
    } else if (visitType === 'special') {
      tally(special.description.trim().length > 0);
      tally(special.amount.trim().length > 0);
      tally(special.leftover.trim().length > 0);
    }
    return { total, filled };
  }, [email, dateRequested, visitType, bank, monthly, monthlyTotals.subtotal, frequent, special]);

  const canSubmit = visitType !== '' && requiredCount.filled === requiredCount.total;
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const payload =
        visitType === 'monthly'
          ? {
              dateOfVisit: monthly.dateOfVisit,
              children: toNumber(monthly.children),
              celebrants: toNumber(monthly.celebrants),
              gift: toNumber(monthly.gift),
              lootbag: toNumber(monthly.lootbag),
              cake: toNumber(monthly.cake),
              grocery: toNumber(monthly.grocery),
              food: toNumber(monthly.food),
              travel: toNumber(monthly.travel),
              misc: toNumber(monthly.misc),
              miscExplain: monthly.miscExplain,
              collaborators: monthly.collaborators,
              directGiving: monthlyTotals.directGiving,
              giftEfficiency: monthlyTotals.giftEfficiency,
            }
          : visitType === 'frequent'
            ? { travelers: frequent.travelers }
            : { description: special.description };
      const subtotal =
        visitType === 'monthly'
          ? monthlyTotals.subtotal
          : visitType === 'frequent'
            ? frequentTotals.subtotal
            : specialTotals.subtotal;
      const leftover =
        visitType === 'monthly'
          ? monthlyTotals.leftover
          : visitType === 'frequent'
            ? frequentTotals.leftover
            : specialTotals.leftover;

      const res = await fetch('/api/orphanage-budget-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submitter_email: email,
          visit_type: visitType,
          mission_trip: missionTrip === 'yes',
          notes: notes || null,
          subtotal: Math.round(subtotal * 100) / 100,
          leftover: Math.round(leftover * 100) / 100,
          final_amount: Math.round(finalAmount * 100) / 100,
          payload,
          bank_account_name: bank.name,
          bank_account_number: bank.number,
          bank_name: bank.bankName,
          swift_code: bank.swift,
        }),
      });
      const json = (await res.json()) as { row?: { id: string }; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Submit failed');

      toast.success('Budget request submitted', {
        description: 'Now visible to Accounting · check Budget History for status.',
      });
      onSubmitted?.();
    } catch (err) {
      toast.error('Submit failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5"
      aria-label="Orphanage Budget Request"
    >
      {/* ─── Step 1 · Visit type chooser ─────────────────────────────── */}
      <VisitTypeChooser value={visitType} onChange={setVisitType} />

      {/* ─── Step 2 · Form body — fades in once a type is picked ───── */}
      <AnimatePresence initial={false}>
        {visitType !== '' && (
          <motion.div
            key="body"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]"
          >
            {/* Left column: form fields */}
            <div className="flex min-w-0 flex-col gap-5">
              <BasicsSection
                email={email}
                dateRequested={dateRequested}
                missionTrip={missionTrip}
                setMissionTrip={setMissionTrip}
              />

              <AnimatePresence mode="wait">
                <motion.div
                  key={visitType}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="transform-gpu"
                >
                  {visitType === 'monthly' && (
                    <MonthlySection
                      state={monthly}
                      setState={setMonthly}
                      directGiving={monthlyTotals.directGiving}
                    />
                  )}
                  {visitType === 'frequent' && (
                    <FrequentSection state={frequent} setState={setFrequent} />
                  )}
                  {visitType === 'special' && (
                    <SpecialSection state={special} setState={setSpecial} />
                  )}
                </motion.div>
              </AnimatePresence>

              <NotesSection notes={notes} setNotes={setNotes} />

              <BankSection bank={bank} setBank={setBank} />
            </div>

            {/* Right column: sticky live summary */}
            <div className="lg:sticky lg:top-4 lg:self-start">
              <LiveSummary
                visitType={visitType}
                monthly={monthlyTotals}
                frequent={frequentTotals}
                special={specialTotals}
                requiredFilled={requiredCount.filled}
                requiredTotal={requiredCount.total}
                canSubmit={canSubmit}
                finalAmount={finalAmount}
                submitting={submitting}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

// ──────────────────────────── Step 1 · Visit type ────────────────────────────

function VisitTypeChooser({
  value,
  onChange,
}: {
  value: VisitType;
  onChange: (v: VisitType) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-sm shadow-pink-500/25">
          <span className="font-mono text-[11px] font-bold">1</span>
        </span>
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            What kind of request is this?
          </h3>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
            Pick one — the form fills in the matching fields below.
          </p>
        </div>
      </header>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {VISIT_TYPES.map((opt) => {
          const selected = value === opt.value;
          const Icon = opt.Icon;
          return (
            <motion.button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              whileTap={{ scale: 0.98 }}
              className={cn(
                'group relative flex items-start gap-3 overflow-hidden rounded-xl border p-3.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500/40',
                selected
                  ? 'border-pink-300 bg-gradient-to-br from-pink-50/80 to-rose-50/40 shadow-md shadow-pink-500/15 dark:border-pink-700/60 dark:from-pink-950/30 dark:to-rose-950/15'
                  : 'border-zinc-200 bg-white hover:border-pink-200 hover:bg-pink-50/30 dark:border-zinc-800 dark:bg-zinc-950/40 dark:hover:border-pink-900/50 dark:hover:bg-pink-950/15',
              )}
              aria-pressed={selected}
            >
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-sm transition-colors',
                  selected
                    ? `bg-gradient-to-br ${opt.selectedAccent} text-white`
                    : 'bg-zinc-100 text-zinc-500 group-hover:bg-pink-100 group-hover:text-pink-600 dark:bg-zinc-900 dark:text-zinc-500 dark:group-hover:bg-pink-950/40 dark:group-hover:text-pink-400',
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'text-[13px] font-semibold',
                      selected
                        ? 'text-pink-900 dark:text-pink-100'
                        : 'text-zinc-800 dark:text-zinc-200',
                    )}
                  >
                    {opt.label}
                  </span>
                  {selected && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400" />
                  )}
                </div>
                <p
                  className={cn(
                    'mt-0.5 text-[11px] leading-snug',
                    selected
                      ? 'text-pink-700/80 dark:text-pink-300/80'
                      : 'text-zinc-500 dark:text-zinc-500',
                  )}
                >
                  {opt.blurb}
                </p>
              </div>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}

// ──────────────────────────── Section: basics ────────────────────────────

function BasicsSection({
  email,
  dateRequested,
  missionTrip,
  setMissionTrip,
}: {
  email: string;
  dateRequested: string;
  missionTrip: 'yes' | 'no';
  setMissionTrip: (v: 'yes' | 'no') => void;
}) {
  // Friendly Date label, e.g. "Sat, May 9, 2026"
  const dateLabel = dateRequested
    ? new Date(dateRequested + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  return (
    <Section
      step={2}
      title="Basics"
      blurb="Who's submitting and when — auto-filled from your session."
      Icon={Sparkles}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ReadOnlyTile
          icon={<User className="h-3.5 w-3.5" />}
          caption="Logged in as"
          primary={email || 'Not signed in'}
          missingHint={!email ? 'Sign in to submit a request.' : undefined}
        />
        <ReadOnlyTile
          icon={<Lock className="h-3.5 w-3.5" />}
          caption="Date requested"
          primary={dateLabel || '—'}
          secondary={dateRequested}
        />
      </div>
      <div className="mt-4">
        <FormField
          label="Is this a Mission Trip?"
          required
          hint="Mission trips have different reporting requirements."
        >
          <PillToggle
            value={missionTrip}
            onChange={setMissionTrip}
            options={[
              { value: 'no', label: 'No' },
              { value: 'yes', label: 'Yes' },
            ]}
          />
        </FormField>
      </div>
    </Section>
  );
}

function ReadOnlyTile({
  icon,
  caption,
  primary,
  secondary,
  missingHint,
}: {
  icon: React.ReactNode;
  caption: string;
  primary: string;
  secondary?: string;
  missingHint?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5',
        missingHint
          ? 'border-amber-200/80 bg-amber-50/50 dark:border-amber-900/45 dark:bg-amber-950/20'
          : 'border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40',
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
        {icon}
        {caption}
      </div>
      <div
        className={cn(
          'mt-1 truncate text-[13px] font-semibold',
          missingHint
            ? 'text-amber-800 dark:text-amber-300'
            : 'text-zinc-900 dark:text-zinc-100',
        )}
        title={primary}
      >
        {primary}
      </div>
      {secondary && (
        <div className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-500">
          {secondary}
        </div>
      )}
      {missingHint && (
        <div className="mt-0.5 text-[10.5px] text-amber-700 dark:text-amber-300/80">
          {missingHint}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────── Section: monthly ────────────────────────────

function MonthlySection({
  state,
  setState,
  directGiving,
}: {
  state: MonthlyState;
  setState: React.Dispatch<React.SetStateAction<MonthlyState>>;
  directGiving: number;
}) {
  const setField = <K extends keyof MonthlyState>(key: K, value: MonthlyState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  return (
    <Section
      step={3}
      title="Monthly visit details"
      blurb="Per-category amounts and trip headcount."
      Icon={HeartHandshake}
      accent="pink"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Date of Visit" required>
          <Input
            type="date"
            value={state.dateOfVisit}
            onChange={(e) => setField('dateOfVisit', e.target.value)}
          />
        </FormField>
        <FormField label="No. of Children" required>
          <Input
            type="number"
            min={0}
            step={1}
            value={state.children}
            onChange={(e) => setField('children', e.target.value)}
          />
        </FormField>
        <FormField label="No. of Celebrants" required>
          <Input
            type="number"
            min={0}
            step={1}
            value={state.celebrants}
            onChange={(e) => setField('celebrants', e.target.value)}
          />
        </FormField>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <SubsectionHeader title="Direct giving" hint="Goes straight to the kids" />
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Gift Amount" required>
            <CurrencyInput
              value={state.gift}
              onChange={(e) => setField('gift', e.target.value)}
            />
          </FormField>
          <FormField label="Lootbag Amount" required>
            <CurrencyInput
              value={state.lootbag}
              onChange={(e) => setField('lootbag', e.target.value)}
            />
          </FormField>
          <FormField label="Cake Amount" required>
            <CurrencyInput
              value={state.cake}
              onChange={(e) => setField('cake', e.target.value)}
            />
          </FormField>
        </div>
        {directGiving > 0 && (
          <div className="rounded-md bg-emerald-50/60 px-3 py-1.5 text-[11px] text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
            Direct giving subtotal:{' '}
            <span className="font-mono font-semibold">{formatPhp(directGiving)}</span>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <SubsectionHeader title="Operations & travel" hint="Supports the visit" />
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Grocery Amount" required>
            <CurrencyInput
              value={state.grocery}
              onChange={(e) => setField('grocery', e.target.value)}
            />
          </FormField>
          <FormField label="Prepared Food" required>
            <CurrencyInput
              value={state.food}
              onChange={(e) => setField('food', e.target.value)}
            />
          </FormField>
          <FormField label="Travel" required>
            <CurrencyInput
              value={state.travel}
              onChange={(e) => setField('travel', e.target.value)}
            />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <FormField label="Misc. Amount" required>
            <CurrencyInput
              value={state.misc}
              onChange={(e) => setField('misc', e.target.value)}
            />
          </FormField>
          <FormField label="If misc, please explain">
            <Input
              type="text"
              placeholder="Brief description"
              value={state.miscExplain}
              onChange={(e) => setField('miscExplain', e.target.value)}
              disabled={toNumber(state.misc) === 0}
            />
          </FormField>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[2fr_1fr]">
        <FormField label="Collaborators" hint="One name per line + their split if relevant">
          <Textarea
            rows={3}
            placeholder={'e.g.\nJane Doe — handling cake order\nMark Reyes — driver'}
            value={state.collaborators}
            onChange={(e) => setField('collaborators', e.target.value)}
          />
        </FormField>
        <FormField label="Leftover from prev month" required>
          <CurrencyInput
            value={state.leftover}
            onChange={(e) => setField('leftover', e.target.value)}
          />
        </FormField>
      </div>
    </Section>
  );
}

// ──────────────────────────── Section: frequent ────────────────────────────

function FrequentSection({
  state,
  setState,
}: {
  state: FrequentState;
  setState: React.Dispatch<React.SetStateAction<FrequentState>>;
}) {
  const setField = <K extends keyof FrequentState>(key: K, value: FrequentState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  return (
    <Section
      step={3}
      title="Frequent travelers"
      blurb="One traveler per line — name, accommodation, travel amount."
      Icon={Plane}
      accent="sky"
    >
      <FormField
        label="Frequent travelers' budget"
        hint="Format: Name, Accommodation Amount, Travel Amount"
        required
      >
        <Textarea
          rows={5}
          placeholder={
            'Name, Accommodation Amount, Travel Amount\nName, Accommodation Amount, Travel Amount'
          }
          value={state.travelers}
          onChange={(e) => setField('travelers', e.target.value)}
        />
      </FormField>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FormField label="Total Travel Amount" required>
          <CurrencyInput
            value={state.totalTravel}
            onChange={(e) => setField('totalTravel', e.target.value)}
          />
        </FormField>
        <FormField label="Leftover from prev month" required>
          <CurrencyInput
            value={state.leftover}
            onChange={(e) => setField('leftover', e.target.value)}
          />
        </FormField>
      </div>
    </Section>
  );
}

// ──────────────────────────── Section: special ────────────────────────────

function SpecialSection({
  state,
  setState,
}: {
  state: SpecialState;
  setState: React.Dispatch<React.SetStateAction<SpecialState>>;
}) {
  const setField = <K extends keyof SpecialState>(key: K, value: SpecialState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  return (
    <Section
      step={3}
      title="Special project"
      blurb="One-off initiative outside the regular monthly cycle."
      Icon={PiggyBank}
      accent="violet"
    >
      <FormField label="Special project description" required>
        <Textarea
          rows={5}
          placeholder="Describe the project — purpose, scope, beneficiaries, timeline"
          value={state.description}
          onChange={(e) => setField('description', e.target.value)}
        />
      </FormField>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FormField label="Amount" required>
          <CurrencyInput
            value={state.amount}
            onChange={(e) => setField('amount', e.target.value)}
          />
        </FormField>
        <FormField label="Leftover from prev month" required>
          <CurrencyInput
            value={state.leftover}
            onChange={(e) => setField('leftover', e.target.value)}
          />
        </FormField>
      </div>
    </Section>
  );
}

// ──────────────────────────── Section: notes ────────────────────────────

function NotesSection({
  notes,
  setNotes,
}: {
  notes: string;
  setNotes: (v: string) => void;
}) {
  return (
    <Section
      step={4}
      title="Notes for Bob"
      blurb="Optional — anything you'd like Bob to know."
      Icon={StickyNote}
    >
      <Textarea
        rows={3}
        placeholder="e.g. Visit moved earlier this month, leftover from March covers half the gifts…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </Section>
  );
}

// ──────────────────────────── Section: bank ────────────────────────────

function BankSection({
  bank,
  setBank,
}: {
  bank: BankAccount;
  setBank: React.Dispatch<React.SetStateAction<BankAccount>>;
}) {
  const setField = <K extends keyof BankAccount>(key: K, value: BankAccount[K]) =>
    setBank((prev) => ({ ...prev, [key]: value }));

  return (
    <Section
      step={5}
      title="Bank account"
      blurb="Where the disbursement should land."
      Icon={Landmark}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Account Name" required>
          <Input
            type="text"
            value={bank.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </FormField>
        <FormField label="Account Number" required>
          <Input
            type="text"
            inputMode="numeric"
            value={bank.number}
            onChange={(e) => setField('number', e.target.value)}
          />
        </FormField>
        <FormField label="Bank Name" required>
          <Input
            type="text"
            value={bank.bankName}
            onChange={(e) => setField('bankName', e.target.value)}
          />
        </FormField>
        <FormField label="Swift Code" required>
          <Input
            type="text"
            value={bank.swift}
            onChange={(e) => setField('swift', e.target.value)}
          />
        </FormField>
      </div>
    </Section>
  );
}

// ──────────────────────────── Sticky live summary ────────────────────────────

interface LiveSummaryProps {
  visitType: VisitType;
  monthly: {
    directGiving: number;
    subtotal: number;
    giftEfficiency: number;
    leftover: number;
    finalAmount: number;
  };
  frequent: { subtotal: number; leftover: number; finalAmount: number };
  special: { subtotal: number; leftover: number; finalAmount: number };
  requiredFilled: number;
  requiredTotal: number;
  canSubmit: boolean;
  finalAmount: number;
  submitting: boolean;
}

function LiveSummary({
  visitType,
  monthly,
  frequent,
  special,
  requiredFilled,
  requiredTotal,
  canSubmit,
  finalAmount,
  submitting,
}: LiveSummaryProps) {
  const ratio = requiredTotal === 0 ? 0 : requiredFilled / requiredTotal;
  return (
    <aside
      className="flex flex-col gap-3 rounded-2xl border border-pink-200/70 bg-gradient-to-br from-white via-pink-50/30 to-rose-50/30 p-4 shadow-sm dark:border-pink-900/45 dark:from-zinc-950/80 dark:via-pink-950/15 dark:to-rose-950/15"
      aria-label="Live request summary"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-500/25">
          <Wallet className="h-3.5 w-3.5" />
        </span>
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-pink-900/80 dark:text-pink-200/85">
            Live summary
          </h3>
          <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">Updates as you type</p>
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={visitType}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="flex flex-col gap-2"
        >
          {visitType === 'monthly' && (
            <>
              <SummaryRow
                label="Direct giving"
                hint="Gifts + Lootbags + Cakes"
                value={formatPhp(monthly.directGiving)}
                emphasis="emerald"
              />
              <SummaryRow
                label="Total budget items"
                value={formatPhp(monthly.subtotal)}
              />
              <GiftEfficiencyBar pct={monthly.giftEfficiency} subtotal={monthly.subtotal} />
              <SummaryRow
                label="Leftover from prev mo."
                value={formatPhp(monthly.leftover)}
                muted={monthly.leftover === 0}
              />
            </>
          )}
          {visitType === 'frequent' && (
            <>
              <SummaryRow
                label="Total travel"
                value={formatPhp(frequent.subtotal)}
              />
              <SummaryRow
                label="Leftover from prev mo."
                value={formatPhp(frequent.leftover)}
                muted={frequent.leftover === 0}
              />
            </>
          )}
          {visitType === 'special' && (
            <>
              <SummaryRow label="Amount" value={formatPhp(special.subtotal)} />
              <SummaryRow
                label="Leftover from prev mo."
                value={formatPhp(special.leftover)}
                muted={special.leftover === 0}
              />
            </>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="my-1 h-px bg-pink-200/60 dark:bg-pink-900/40" />

      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-pink-700/80 dark:text-pink-300/80">
          Final amount
        </span>
        <AnimatedAmount value={finalAmount} />
        <span className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
          Subtotal − leftover
        </span>
      </div>

      <div className="mt-1 flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10.5px] text-zinc-500 dark:text-zinc-400">
          <span>Required fields</span>
          <span className="font-mono tabular-nums">
            {requiredFilled} / {requiredTotal}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <motion.div
            initial={false}
            animate={{ width: `${Math.round(ratio * 100)}%` }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className={cn(
              'h-full rounded-full',
              canSubmit
                ? 'bg-gradient-to-r from-emerald-500 to-emerald-600'
                : 'bg-gradient-to-r from-pink-500 to-rose-600',
            )}
          />
        </div>
      </div>

      <div className="mt-1 flex flex-col gap-2">
        <Button
          type="submit"
          disabled={!canSubmit || submitting}
          className="h-10 gap-2 bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25 hover:from-pink-700 hover:to-rose-800 disabled:from-pink-300 disabled:to-rose-300 disabled:opacity-70"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Submitting…
            </>
          ) : (
            <>
              Submit request
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
        <Button type="button" variant="outline" className="h-9 text-xs" disabled={submitting}>
          Cancel
        </Button>
      </div>
    </aside>
  );
}

function SummaryRow({
  label,
  hint,
  value,
  emphasis,
  muted,
}: {
  label: string;
  hint?: string;
  value: string;
  emphasis?: 'emerald';
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-pink-100/50 pb-1.5 last:border-b-0 last:pb-0 dark:border-pink-900/30">
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200">
          {label}
        </div>
        {hint && (
          <div className="text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</div>
        )}
      </div>
      <span
        className={cn(
          'font-mono text-[12.5px] font-semibold tabular-nums',
          muted
            ? 'text-zinc-400 dark:text-zinc-600'
            : emphasis === 'emerald'
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-zinc-900 dark:text-zinc-100',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function GiftEfficiencyBar({
  pct,
  subtotal,
}: {
  pct: number;
  subtotal: number;
}) {
  const tier =
    subtotal === 0
      ? 'idle'
      : pct >= 70
        ? 'excellent'
        : pct >= 50
          ? 'good'
          : 'below';
  const tierMeta: Record<typeof tier, { label: string; barClass: string; textClass: string }> = {
    idle: {
      label: 'Awaiting amounts',
      barClass: 'bg-zinc-300 dark:bg-zinc-700',
      textClass: 'text-zinc-500 dark:text-zinc-500',
    },
    below: {
      label: 'Below target',
      barClass: 'bg-gradient-to-r from-amber-500 to-orange-500',
      textClass: 'text-amber-700 dark:text-amber-400',
    },
    good: {
      label: 'Good',
      barClass: 'bg-gradient-to-r from-emerald-400 to-emerald-500',
      textClass: 'text-emerald-700 dark:text-emerald-400',
    },
    excellent: {
      label: 'Excellent',
      barClass: 'bg-gradient-to-r from-emerald-500 to-emerald-600',
      textClass: 'text-emerald-700 dark:text-emerald-400',
    },
  };
  const meta = tierMeta[tier];

  return (
    <div className="flex flex-col gap-1.5 border-b border-pink-100/50 pb-2 dark:border-pink-900/30">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200">
            Gift efficiency
          </div>
          <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
            % of budget that's direct giving
          </div>
        </div>
        <span
          className={cn(
            'font-mono text-[12.5px] font-semibold tabular-nums',
            meta.textClass,
          )}
        >
          {subtotal > 0 ? `${pct.toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <motion.div
          initial={false}
          animate={{ width: subtotal > 0 ? `${Math.min(100, Math.max(0, pct))}%` : '0%' }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={cn('h-full rounded-full', meta.barClass)}
        />
      </div>
      <span className={cn('text-[10px] font-medium', meta.textClass)}>{meta.label}</span>
    </div>
  );
}

/** Animated counter for the final amount. Counts up smoothly when the value
 *  changes so the totals feel alive without being distracting. */
function AnimatedAmount({ value }: { value: number }) {
  const [displayed, setDisplayed] = useState(value);
  useEffect(() => {
    const start = displayed;
    const target = value;
    if (start === target) return;
    const startedAt = performance.now();
    const dur = 220;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - startedAt) / dur);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - p, 3);
      const next = start + (target - start) * eased;
      setDisplayed(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <span className="font-mono text-2xl font-bold tabular-nums tracking-tight text-pink-900 dark:text-pink-100">
      {formatPhp(displayed)}
    </span>
  );
}

// ──────────────────────────── Building blocks ────────────────────────────

function Section({
  step,
  title,
  blurb,
  Icon,
  accent = 'pink',
  children,
}: {
  step?: number;
  title: string;
  blurb?: string;
  Icon?: React.ComponentType<{ className?: string }>;
  accent?: 'pink' | 'sky' | 'violet';
  children: ReactNode;
}) {
  const accentMap = {
    pink: 'from-pink-500 to-rose-600',
    sky: 'from-sky-500 to-blue-600',
    violet: 'from-violet-500 to-fuchsia-600',
  } as const;
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40 sm:p-5">
      <header className="mb-4 flex items-start gap-2.5">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm',
            accentMap[accent],
          )}
        >
          {step != null ? (
            <span className="font-mono text-[11px] font-bold">{step}</span>
          ) : Icon ? (
            <Icon className="h-3.5 w-3.5" />
          ) : null}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h3>
            {Icon && step != null && (
              <Icon className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
            )}
          </div>
          {blurb && (
            <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
              {blurb}
            </p>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}

function SubsectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600 dark:text-zinc-400">
        {title}
      </h4>
      {hint && (
        <span className="text-[10.5px] text-zinc-400 dark:text-zinc-500">— {hint}</span>
      )}
    </div>
  );
}

function FormField({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
        <span>
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
      </Label>
      {children}
      {hint && (
        <p className="text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-500">
          {hint}
        </p>
      )}
    </div>
  );
}

function PillToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex w-fit items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative rounded px-3 py-1 text-[12px] font-medium transition-colors',
              selected
                ? 'bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-500/25'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
            aria-pressed={selected}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-[80px] w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-pink-400 focus:outline-none focus:ring-2 focus:ring-pink-400/30 disabled:cursor-not-allowed disabled:opacity-60',
        'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-pink-500 dark:focus:ring-pink-500/30',
        className,
      )}
      {...props}
    />
  );
}

function CurrencyInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-zinc-400 dark:text-zinc-500">
        ₱
      </span>
      <Input
        type="number"
        min={0}
        step="0.01"
        placeholder="0.00"
        className={cn('pl-7', className)}
        {...props}
      />
    </div>
  );
}
