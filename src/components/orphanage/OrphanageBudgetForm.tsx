'use client';

import { useState, type ReactNode } from 'react';
import { CircleHelp, HeartHandshake, Lock, PiggyBank, Plane } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Static "Orphanage Budget Request" form — visual scaffold only. No state
 * persistence, no validation, no submit handler beyond `preventDefault`.
 *
 * The "Type of Visit" radio drives a conditional block of fields:
 *   Monthly Visit → per-category amounts (gift / lootbag / cake / …),
 *                   collaborator splits, locked Gift-Efficiency calc.
 *   Frequent Travelers Budget → traveler-by-traveler text block + travel total.
 *   Special Project → free-form description + a single amount.
 *
 * Common fields (email, date requested, notes, mission-trip flag, bank info)
 * always render regardless of visit type. Once HR locks in the data shape
 * we'll convert this to a controlled form + POST endpoint.
 */
type VisitType = 'monthly' | 'frequent' | 'special' | '';

export default function OrphanageBudgetForm() {
  const [visitType, setVisitType] = useState<VisitType>('');

  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="flex flex-col gap-6"
      aria-label="Orphanage Budget Request"
    >
      {/* ─── Common header · always shown ──────────────────────────────── */}
      <FormSection>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
          <FormField label="Simple Email" required>
            <Input type="email" placeholder="name@simple.biz" autoComplete="off" />
          </FormField>
          <FormField label="Date Requested" required>
            <Input type="date" />
          </FormField>
          <FormField label="Type of Visit" required hint="Pick one to load the matching fields">
            <div className="flex flex-col gap-1.5 pt-1.5">
              <RadioOption
                name="visit-type"
                value="monthly"
                label="Monthly Visit"
                checked={visitType === 'monthly'}
                onChange={() => setVisitType('monthly')}
              />
              <RadioOption
                name="visit-type"
                value="frequent"
                label="Frequent Travelers Budget"
                checked={visitType === 'frequent'}
                onChange={() => setVisitType('frequent')}
              />
              <RadioOption
                name="visit-type"
                value="special"
                label="Special Project"
                checked={visitType === 'special'}
                onChange={() => setVisitType('special')}
              />
            </div>
          </FormField>
        </div>
      </FormSection>

      <FormField label="Notes for Bob">
        <Textarea rows={3} placeholder="Anything Bob should know about this request" />
      </FormField>

      <FormSection>
        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <FormField label="Is this a Mission Trip?" required>
            <div className="flex gap-4 pt-1.5">
              <RadioOption name="mission-trip" value="yes" label="Yes" />
              <RadioOption name="mission-trip" value="no" label="No" defaultChecked />
            </div>
          </FormField>
          <div /> {/* spacer to keep alignment on wide screens */}
        </div>
      </FormSection>

      {/* ─── Type-specific section · swaps with visitType ──────────────── */}
      {visitType === '' && <PickTypeHint />}
      {visitType === 'monthly' && <MonthlyVisitFields />}
      {visitType === 'frequent' && <FrequentTravelersFields />}
      {visitType === 'special' && <SpecialProjectFields />}

      {/* ─── Bank account · always shown ──────────────────────────────── */}
      <FormSection title="Bank Account Information">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Account Name" required>
            <Input type="text" />
          </FormField>
          <FormField label="Account Number" required>
            <Input type="text" inputMode="numeric" />
          </FormField>
          <FormField label="Bank Name" required>
            <Input type="text" />
          </FormField>
          <FormField label="Swift Code" required>
            <Input type="text" />
          </FormField>
        </div>
      </FormSection>

      {/* ─── Submit row ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-pink-100/70 pt-5 dark:border-pink-950/45">
        <Button type="button" variant="outline">
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={visitType === ''}
          className="bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25 hover:from-pink-700 hover:to-rose-800 disabled:from-pink-300 disabled:to-rose-300 disabled:opacity-70"
        >
          Submit Request
        </Button>
      </div>
    </form>
  );
}

// ───────────────────────── Type-specific blocks ─────────────────────────

function PickTypeHint() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-pink-200/80 bg-pink-50/30 px-4 py-10 text-center dark:border-pink-900/50 dark:bg-pink-950/15">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-pink-500/10 text-pink-600 dark:bg-pink-500/15 dark:text-pink-300">
        <PiggyBank className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        Pick a Type of Visit above
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        The fields you need depend on whether this is a regular monthly visit, a
        frequent travelers&apos; budget, or a one-off special project. Choose above
        and the form will fill in.
      </p>
    </div>
  );
}

function MonthlyVisitFields() {
  return (
    <div className="flex flex-col gap-6 rounded-xl border border-pink-100/80 bg-white/60 px-4 py-5 dark:border-pink-950/45 dark:bg-zinc-950/40">
      <SectionHeader
        Icon={HeartHandshake}
        title="Monthly visit details"
        subtitle="Per-category breakdown for the visit. Required fields are marked *."
      />

      <FormSection>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="Date of Visit" required>
            <Input type="date" />
          </FormField>
          <FormField label="No. of Children" required>
            <Input type="number" min={0} step={1} />
          </FormField>
          <FormField label="No. of Celebrants" required>
            <Input type="number" min={0} step={1} />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Budget items">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="Gift Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Lootbag Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Cake Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Grocery Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Prepared Food Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Travel Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Misc. Amount" required>
            <CurrencyInput />
          </FormField>
          <div className="lg:col-span-2">
            <FormField label="If misc, please explain">
              <Input type="text" placeholder="Brief description" />
            </FormField>
          </div>
        </div>
      </FormSection>

      <FormField label="Collaborators">
        <Textarea rows={3} placeholder="One name per line, plus their split if relevant" />
      </FormField>

      <FormSection>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Leftover from prev month" required>
            <CurrencyInput />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Calculations">
        <div className="flex flex-col gap-3 rounded-xl border border-pink-100/80 bg-pink-50/40 px-4 py-3 dark:border-pink-950/45 dark:bg-pink-950/20">
          <CalculationRow label="Total for Gifts, Lootbags, and Cakes" locked />
          <CalculationRow label="Subtotal" />
          <CalculationRow label="Gift Efficiency" locked />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Estimated Total">
            <Input
              type="text"
              defaultValue="0.00"
              readOnly
              className="bg-zinc-50 dark:bg-zinc-900/50"
            />
          </FormField>
          <FormField
            label="Estimated Total (Monthly Visit)"
            hint="Auto-calculated from the budget items above"
            tooltip
          >
            <div className="flex items-center gap-2">
              <Input
                type="text"
                defaultValue="0.00"
                readOnly
                className="bg-zinc-50 dark:bg-zinc-900/50"
              />
              <Button type="button" variant="outline" size="sm" className="shrink-0">
                Calculate
              </Button>
            </div>
          </FormField>
        </div>
      </FormSection>
    </div>
  );
}

function FrequentTravelersFields() {
  return (
    <div className="flex flex-col gap-6 rounded-xl border border-pink-100/80 bg-white/60 px-4 py-5 dark:border-pink-950/45 dark:bg-zinc-950/40">
      <SectionHeader
        Icon={Plane}
        title="Frequent travelers budget"
        subtitle="One traveler per line — name, accommodation, travel amount."
      />

      <FormField
        label="Frequent Travelers' Budget"
        hint="Format: Name, Accommodation Amount, Travel Amount"
        required
      >
        <Textarea
          rows={5}
          placeholder={
            'Name, Accommodation Amount, Travel Amount\nName, Accommodation Amount, Travel Amount\nName, Accommodation Amount, Travel Amount'
          }
        />
      </FormField>

      <FormSection>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Total Travel Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Leftover from prev month" required>
            <CurrencyInput />
          </FormField>
        </div>
      </FormSection>

      <FormField
        label="Estimated Total"
        hint="Auto-calculated from rows above plus leftover"
        tooltip
      >
        <div className="flex items-center gap-2">
          <Input
            type="text"
            defaultValue="0.00"
            readOnly
            className="bg-zinc-50 dark:bg-zinc-900/50"
          />
          <Button type="button" variant="outline" size="sm" className="shrink-0">
            Calculate
          </Button>
        </div>
      </FormField>
    </div>
  );
}

function SpecialProjectFields() {
  return (
    <div className="flex flex-col gap-6 rounded-xl border border-pink-100/80 bg-white/60 px-4 py-5 dark:border-pink-950/45 dark:bg-zinc-950/40">
      <SectionHeader
        Icon={PiggyBank}
        title="Special project"
        subtitle="One-off initiative outside the regular monthly cycle."
      />

      <FormField label="Special Project" required>
        <Textarea
          rows={5}
          placeholder="Describe the project — purpose, scope, beneficiaries, timeline"
        />
      </FormField>

      <FormSection>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Amount" required>
            <CurrencyInput />
          </FormField>
          <FormField label="Leftover from prev month" required>
            <CurrencyInput />
          </FormField>
        </div>
      </FormSection>

      <FormField
        label="Estimated Total"
        hint="Amount minus leftover applied as a credit"
        tooltip
      >
        <div className="flex items-center gap-2">
          <Input
            type="text"
            defaultValue="0.00"
            readOnly
            className="bg-zinc-50 dark:bg-zinc-900/50"
          />
          <Button type="button" variant="outline" size="sm" className="shrink-0">
            Calculate
          </Button>
        </div>
      </FormField>
    </div>
  );
}

// ───────────────────────── Subcomponents ─────────────────────────

function SectionHeader({
  Icon,
  title,
  subtitle,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-white">{title}</h4>
        {subtitle && (
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

function FormSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {title && (
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-pink-700/85 dark:text-pink-300/85">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

function FormField({
  label,
  required,
  hint,
  tooltip,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  tooltip?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
        <span>
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
        {tooltip && (
          <CircleHelp
            className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500"
            aria-hidden
          />
        )}
      </Label>
      {children}
      {hint && !tooltip && (
        <p className="text-[10.5px] text-zinc-500 dark:text-zinc-500">{hint}</p>
      )}
    </div>
  );
}

function RadioOption({
  name,
  value,
  label,
  defaultChecked,
  checked,
  onChange,
}: {
  name: string;
  value: string;
  label: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: () => void;
}) {
  // Controlled if the parent passes `checked`; otherwise uncontrolled with
  // `defaultChecked`. Avoids React's controlled/uncontrolled warning.
  const isControlled = checked !== undefined;
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-zinc-700 dark:text-zinc-300">
      <input
        type="radio"
        name={name}
        value={value}
        {...(isControlled ? { checked, onChange } : { defaultChecked })}
        className="h-3.5 w-3.5 cursor-pointer accent-pink-600 dark:accent-pink-500"
      />
      {label}
    </label>
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

function CalculationRow({ label, locked }: { label: string; locked?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {label && (
        <Label className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          <span>{label}:</span>
          {locked && (
            <Lock
              className="h-3 w-3 text-rose-500"
              aria-label="Locked — auto-calculated"
            />
          )}
        </Label>
      )}
      <span className="font-mono text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
        0.00
      </span>
      <Button type="button" variant="outline" size="sm" className="h-7 px-3 text-[11px]">
        Calculate
      </Button>
    </div>
  );
}
