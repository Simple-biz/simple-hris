'use client';

import { useState } from 'react';
import { Building2, MapPin, Phone, Mail, Users } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Static directory of orphanages the team rotates through. Each row carries
 * the basic contact info plus a `leftoverBudget` input that the manager can
 * tweak — the value drives "Leftover from prev month" defaults on the budget
 * request form. Mock data only; no persistence yet.
 *
 * Once HR locks in where this should live (own table? master_list-style
 * upload?), we'll back it with Supabase. Until then it's local state.
 */

interface Orphanage {
  id: string;
  name: string;
  address: string;
  contactPerson: string;
  phone: string;
  email: string;
  children: number;
  notes?: string;
  leftoverBudget: number;
}

// Fourteen mock entries. Names + locations are plausibly Filipino-context but
// fictional — easy to swap when the real list lands.
const INITIAL_ORPHANAGES: Orphanage[] = [
  {
    id: 'o-01',
    name: 'Tahanang Walang Hagdanan',
    address: 'Cainta, Rizal',
    contactPerson: 'Sr. Maria Luz',
    phone: '+63 917 555 0101',
    email: 'contact@twh.example',
    children: 42,
    notes: 'Wheelchair-accessible facility',
    leftoverBudget: 1250.0,
  },
  {
    id: 'o-02',
    name: 'SOS Children’s Village — Lipa',
    address: 'Lipa City, Batangas',
    contactPerson: 'Mr. Renato Cruz',
    phone: '+63 917 555 0202',
    email: 'lipa@sosvillage.example',
    children: 65,
    leftoverBudget: 0,
  },
  {
    id: 'o-03',
    name: 'Kanlungan sa Erma',
    address: 'Manila',
    contactPerson: 'Ate Beth',
    phone: '+63 917 555 0303',
    email: 'kanlungan.erma@example.org',
    children: 28,
    notes: 'Street-children rescue',
    leftoverBudget: 2480.5,
  },
  {
    id: 'o-04',
    name: 'Bahay Tuluyan',
    address: 'Malate, Manila',
    contactPerson: 'Sr. Catherine Reyes',
    phone: '+63 917 555 0404',
    email: 'tuluyan@example.org',
    children: 35,
    leftoverBudget: 600,
  },
  {
    id: 'o-05',
    name: 'Boys Town Manila',
    address: 'Marikina City',
    contactPerson: 'Bro. Romeo Dela Cruz',
    phone: '+63 917 555 0505',
    email: 'btmanila@example.org',
    children: 80,
    notes: 'Boys 7–18',
    leftoverBudget: 0,
  },
  {
    id: 'o-06',
    name: 'Hospicio de San José',
    address: 'Isla de Convalecencia, Manila',
    contactPerson: 'Sr. Teresita Almonte',
    phone: '+63 917 555 0606',
    email: 'hospicio@example.org',
    children: 90,
    leftoverBudget: 175,
  },
  {
    id: 'o-07',
    name: 'Asilo de Molo',
    address: 'Iloilo City',
    contactPerson: 'Sr. Conchita Lago',
    phone: '+63 917 555 0707',
    email: 'asilo.molo@example.org',
    children: 55,
    notes: 'Girls only',
    leftoverBudget: 1900,
  },
  {
    id: 'o-08',
    name: 'Bahay Kalinga',
    address: 'Quezon City',
    contactPerson: 'Tita Gemma',
    phone: '+63 917 555 0808',
    email: 'kalinga@example.org',
    children: 22,
    leftoverBudget: 320,
  },
  {
    id: 'o-09',
    name: 'House of Refuge Foundation',
    address: 'Antipolo, Rizal',
    contactPerson: 'Mr. Edwin Lim',
    phone: '+63 917 555 0909',
    email: 'refuge@example.org',
    children: 40,
    notes: 'Crisis intake',
    leftoverBudget: 0,
  },
  {
    id: 'o-10',
    name: 'Kanlungan ni María',
    address: 'Cebu City',
    contactPerson: 'Sr. Jocelyn Tan',
    phone: '+63 917 555 1010',
    email: 'kanlungan.maria@example.org',
    children: 33,
    leftoverBudget: 540.25,
  },
  {
    id: 'o-11',
    name: 'Children’s Joy Foundation',
    address: 'Cavite',
    contactPerson: 'Pastor Leo Vargas',
    phone: '+63 917 555 1111',
    email: 'cjf@example.org',
    children: 60,
    notes: 'Faith-based',
    leftoverBudget: 1050,
  },
  {
    id: 'o-12',
    name: 'Norfil Foundation',
    address: 'Quezon City',
    contactPerson: 'Ms. Aida Bautista',
    phone: '+63 917 555 1212',
    email: 'norfil@example.org',
    children: 18,
    notes: 'Special-needs focus',
    leftoverBudget: 0,
  },
  {
    id: 'o-13',
    name: 'ChildHope Asia',
    address: 'Manila',
    contactPerson: 'Mr. Andrew Sy',
    phone: '+63 917 555 1313',
    email: 'asia@childhope.example',
    children: 45,
    leftoverBudget: 220,
  },
  {
    id: 'o-14',
    name: 'Bantay Bata Foundation',
    address: 'Makati City',
    contactPerson: 'Ms. Carla Yan',
    phone: '+63 917 555 1414',
    email: 'bantay.bata@example.org',
    children: 50,
    notes: 'Hotline + drop-in',
    leftoverBudget: 875.75,
  },
];

function formatPHP(n: number): string {
  return `₱${n.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function OrphanagesPanel() {
  const [orphanages, setOrphanages] = useState<Orphanage[]>(INITIAL_ORPHANAGES);

  const totalLeftover = orphanages.reduce((sum, o) => sum + o.leftoverBudget, 0);
  const fundedCount = orphanages.filter((o) => o.leftoverBudget > 0).length;

  return (
    <div className="flex flex-col gap-5">
      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Orphanages tracked" value={orphanages.length.toString()} />
        <SummaryTile label="With leftover funds" value={fundedCount.toString()} />
        <SummaryTile label="Total leftover" value={formatPHP(totalLeftover)} prominent />
      </div>

      {/* Cards grid */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {orphanages.map((o) => (
          <OrphanageCard
            key={o.id}
            orphanage={o}
            onChangeLeftover={(value) =>
              setOrphanages((prev) =>
                prev.map((row) => (row.id === o.id ? { ...row, leftoverBudget: value } : row)),
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── Subcomponents ─────────────────────────

function SummaryTile({
  label,
  value,
  prominent = false,
}: {
  label: string;
  value: string;
  prominent?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 transition-colors',
        prominent
          ? 'border-pink-300/80 bg-gradient-to-br from-pink-50 to-rose-100/60 dark:border-pink-800/50 dark:from-pink-950/40 dark:to-rose-950/30'
          : 'border-pink-100/80 bg-white dark:border-pink-950/45 dark:bg-zinc-950/60',
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-pink-700/80 dark:text-pink-300/80">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 font-mono text-xl font-bold tabular-nums tracking-tight',
          prominent
            ? 'text-pink-800 dark:text-pink-200'
            : 'text-zinc-900 dark:text-white',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function OrphanageCard({
  orphanage,
  onChangeLeftover,
}: {
  orphanage: Orphanage;
  onChangeLeftover: (next: number) => void;
}) {
  // Local string state so the user can clear / partially-type the field
  // without it snapping back to a number every keystroke. We sync up to the
  // numeric parent state on each change.
  const [draft, setDraft] = useState<string>(
    orphanage.leftoverBudget.toFixed(2),
  );

  const handleChange = (raw: string) => {
    setDraft(raw);
    const n = parseFloat(raw);
    onChangeLeftover(Number.isFinite(n) ? n : 0);
  };

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-pink-100/80 bg-white p-4 shadow-sm transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-950/45 dark:bg-zinc-950/60">
      <header className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
          <Building2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
            {orphanage.name}
          </h3>
          {orphanage.notes && (
            <p className="mt-0.5 truncate text-[11px] text-pink-700/80 dark:text-pink-300/80">
              {orphanage.notes}
            </p>
          )}
        </div>
      </header>

      <dl className="flex flex-col gap-1.5 text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
        <DetailRow Icon={MapPin} value={orphanage.address} />
        <DetailRow
          Icon={Users}
          value={`${orphanage.children} children · ${orphanage.contactPerson}`}
        />
        <DetailRow Icon={Phone} value={orphanage.phone} mono />
        <DetailRow Icon={Mail} value={orphanage.email} mono />
      </dl>

      <div className="border-t border-pink-100/70 pt-3 dark:border-pink-900/40">
        <Label
          htmlFor={`${orphanage.id}-leftover`}
          className="text-[11px] font-semibold uppercase tracking-[0.12em] text-pink-700/80 dark:text-pink-300/80"
        >
          Leftover budget
        </Label>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-zinc-400 dark:text-zinc-500">
              ₱
            </span>
            <Input
              id={`${orphanage.id}-leftover`}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={draft}
              onChange={(e) => handleChange(e.target.value)}
              className="pl-7"
              placeholder="0.00"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => handleChange('0')}
            className="h-9 shrink-0 border-pink-200/70 px-3 text-[11px] dark:border-pink-900/45"
          >
            Clear
          </Button>
        </div>
        <p className="mt-1 text-[10.5px] text-zinc-500 dark:text-zinc-500">
          Current: {formatPHP(orphanage.leftoverBudget)}
        </p>
      </div>
    </article>
  );
}

function DetailRow({
  Icon,
  value,
  mono,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-pink-500/70 dark:text-pink-400/70" />
      <span
        className={cn(
          'min-w-0 truncate',
          mono && 'font-mono text-[11.5px]',
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
