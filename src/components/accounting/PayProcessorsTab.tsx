'use client';

// Payment Catalog → Pay Processors.
//
// The registry of every processor Accounting sends salaries FROM — the source of
// truth Payment Dispatch will soon read to build one bucket per processor. Cards
// show the logo on the same white plate the dispatch cards use, the
// classification (One-to-one wallet vs Multi-peer bank rail), whether code is
// wired for the id yet, and DRIFT when the registry's classification disagrees
// with what dispatch routes on today. Add + edit only; no delete — a processor
// that stops being used is RETIRED so its history keeps a label.
//
// Governing doc: docs/features/payment-catalog-pay-processors.md.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  ImagePlus,
  Landmark,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import ProcessorLogo from '@/components/payroll-clerk/ProcessorLogo';
import {
  PAY_PROCESSOR_BLURB_MAX,
  PAY_PROCESSOR_LABEL_MAX,
  PAY_PROCESSOR_LOGO_MAX_BYTES,
  PAY_PROCESSOR_LOGO_MIMES,
  PAY_PROCESSOR_NOTES_MAX,
  PAY_PROCESSOR_ROUTINGS,
  PAY_PROCESSOR_ROUTING_HELP,
  PAY_PROCESSOR_ROUTING_LABEL,
  payProcessorLogoSrc,
  routingDrift,
  slugifyProcessorId,
  validatePayProcessorInput,
  type PayProcessor,
  type PayProcessorInput,
  type PayProcessorLogo,
  type PayProcessorRouting,
} from '@/lib/payment-catalog/pay-processors';

const EASE = [0.22, 1, 0.36, 1] as const;

/** Tile gradient + fallback icon per classification, used when a row has no logo. */
const ROUTING_VISUAL: Record<
  PayProcessorRouting,
  { gradient: string; Icon: React.ComponentType<{ className?: string }>; chip: string }
> = {
  one_to_one: {
    gradient: 'from-emerald-500 to-teal-500',
    Icon: Wallet,
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/60',
  },
  multi_peer: {
    gradient: 'from-sky-500 to-indigo-500',
    Icon: Landmark,
    chip: 'bg-sky-50 text-sky-700 ring-sky-200/70 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900/60',
  },
};

function monogramOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function PayProcessorsTab({
  processors,
  onChanged,
}: {
  processors: PayProcessor[];
  /** Refetch catalog data after a successful create/edit. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<PayProcessor | null | 'new'>(null);
  const [showRetired, setShowRetired] = useState(false);

  const active = useMemo(() => processors.filter((p) => p.status === 'active'), [processors]);
  const retired = useMemo(() => processors.filter((p) => p.status === 'retired'), [processors]);
  const drifting = useMemo(() => processors.filter((p) => routingDrift(p) !== null), [processors]);
  const unwired = useMemo(() => active.filter((p) => !p.wiredInCode), [active]);

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      {/* Header band: intro + the hero button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            <Landmark className="h-5 w-5 text-orange-500" />
            Pay Processors
          </h2>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            Every processor Accounting sends salaries from, with its logo and how it pays out.
            This list is the source of truth — Payment Dispatch will build one bucket per active
            processor here.
          </p>
        </div>
        <AddProcessorButton onClick={() => setEditing('new')} />
      </div>

      {/* Notices — amber is a warning, and only a warning. */}
      {(drifting.length > 0 || unwired.length > 0) && (
        <div className="mt-4 flex flex-col gap-2">
          {drifting.length > 0 && (
            <Notice>
              {drifting.length === 1 ? 'One processor is' : `${drifting.length} processors are`} classified
              differently here than Payment Dispatch routes them today. The registry is what
              you want; dispatch follows once the integration reads it.
            </Notice>
          )}
          {unwired.length > 0 && (
            <Notice>
              {unwired.length === 1 ? 'One active processor is' : `${unwired.length} active processors are`} not wired
              for dispatch yet — nobody can be routed on {unwired.length === 1 ? 'it' : 'them'} until
              engineering adds the id.
            </Notice>
          )}
        </div>
      )}

      {/* Active */}
      <section className="mt-6">
        <SectionHeading
          icon={Sparkles}
          title="Active"
          subtitle={`${active.length} processor${active.length === 1 ? '' : 's'} Accounting can pay from.`}
        />
        {active.length === 0 ? (
          <EmptyState onAdd={() => setEditing('new')} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {active.map((p) => (
              <ProcessorCard key={p.id} processor={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </section>

      {/* Retired — collapsed; history keeps the label */}
      {retired.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <SectionHeading
              icon={Building2}
              title="Retired"
              subtitle="No longer offered anywhere. Kept so old dispatch rows keep their name."
            />
            <button
              type="button"
              onClick={() => setShowRetired((v) => !v)}
              className="rounded-md px-2 py-1 text-[11px] font-semibold text-orange-600 transition-colors hover:bg-orange-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
            >
              {showRetired ? 'Hide' : `Show ${retired.length}`}
            </button>
          </div>
          {showRetired && (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {retired.map((p) => (
                <ProcessorCard key={p.id} processor={p} onEdit={() => setEditing(p)} />
              ))}
            </div>
          )}
        </section>
      )}

      <p className="mt-6 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
        <strong className="font-semibold text-zinc-500 dark:text-zinc-400">One-to-one</strong> —{' '}
        {PAY_PROCESSOR_ROUTING_HELP.one_to_one}{' '}
        <strong className="font-semibold text-zinc-500 dark:text-zinc-400">Multi-peer</strong> —{' '}
        {PAY_PROCESSOR_ROUTING_HELP.multi_peer}
      </p>

      <ProcessorDialog
        key={editing === 'new' ? 'new' : editing?.id ?? 'closed'}
        open={editing !== null}
        processor={editing === 'new' ? null : editing}
        existingIds={new Set(processors.map((p) => p.id))}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onChanged();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SectionHeading({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-3 flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** The hero CTA — same shape as "Create a Department" beside it. */
function AddProcessorButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-orange-500 to-orange-600 py-2.5 pl-3.5 pr-4 text-sm font-semibold text-white shadow-lg shadow-orange-500/30 transition-shadow hover:shadow-xl hover:shadow-orange-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/20 transition-transform group-hover:rotate-90">
        <Plus className="h-3.5 w-3.5" />
      </span>
      Add a Processor
    </motion.button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white/60 p-8 text-center dark:border-zinc-700 dark:bg-zinc-950/40">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100 text-orange-600 dark:bg-blue-950/60 dark:text-blue-300">
        <Landmark className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">No active processors</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Every processor is retired. Add one, or re-activate a retired processor below.
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onAdd}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Add a processor
      </Button>
    </div>
  );
}

function Chip({ className, children, title }: { className: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset',
        className,
      )}
    >
      {children}
    </span>
  );
}

function ProcessorCard({ processor: p, onEdit }: { processor: PayProcessor; onEdit: () => void }) {
  const visual = ROUTING_VISUAL[p.routing];
  const drift = routingDrift(p);
  const retired = p.status === 'retired';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: EASE }}
      className={cn(
        'group relative rounded-xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950',
        retired && 'opacity-75',
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn(retired && 'grayscale')}>
          <ProcessorLogo
            monogram={monogramOf(p.label)}
            gradient={visual.gradient}
            FallbackIcon={visual.Icon}
            logoSrc={payProcessorLogoSrc(p.logo) ?? undefined}
            className="h-11 w-[80px] shrink-0"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{p.label}</h3>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${p.label}`}
              className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-blue-950/40 dark:hover:text-blue-300"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={p.blurb || undefined}>
            {p.blurb || <span className="italic text-zinc-400">No blurb</span>}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-100 pt-2.5 dark:border-zinc-900">
        <Chip className={visual.chip} title={PAY_PROCESSOR_ROUTING_HELP[p.routing]}>
          {p.routing === 'one_to_one' ? <Wallet className="h-3 w-3" /> : <ArrowLeftRight className="h-3 w-3" />}
          {PAY_PROCESSOR_ROUTING_LABEL[p.routing]}
        </Chip>
        {retired ? (
          <Chip className="bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800">
            Retired
          </Chip>
        ) : p.wiredInCode ? (
          <Chip
            className="bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800"
            title="Payment Dispatch and the bank pickers know this processor id."
          >
            <ShieldCheck className="h-3 w-3" /> Wired for dispatch
          </Chip>
        ) : (
          <Chip
            className="bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60"
            title="Nobody can be routed on this processor until engineering adds the id to Payment Dispatch."
          >
            <AlertTriangle className="h-3 w-3" /> Not wired yet
          </Chip>
        )}
        {drift && (
          <Chip
            className="bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60"
            title={`Payment Dispatch still routes ${p.label} as ${PAY_PROCESSOR_ROUTING_LABEL[drift.code]}.`}
          >
            <AlertTriangle className="h-3 w-3" /> Dispatch: {PAY_PROCESSOR_ROUTING_LABEL[drift.code]}
          </Chip>
        )}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit dialog
// ---------------------------------------------------------------------------

type Draft = {
  label: string;
  blurb: string;
  routing: PayProcessorRouting;
  active: boolean;
  logo: PayProcessorLogo | null;
  notes: string;
};

function draftFrom(p: PayProcessor | null): Draft {
  return {
    label: p?.label ?? '',
    blurb: p?.blurb ?? '',
    routing: p?.routing ?? 'multi_peer',
    active: p ? p.status === 'active' : true,
    logo: p?.logo ?? null,
    notes: p?.notes ?? '',
  };
}

const ACCEPT = PAY_PROCESSOR_LOGO_MIMES.join(',');

function ProcessorDialog({
  open,
  processor,
  existingIds,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = creating. */
  processor: PayProcessor | null;
  existingIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = processor === null;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(processor));
  const [saving, setSaving] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(draftFrom(processor));
      setLogoError(null);
    }
  }, [open, processor]);

  const input: PayProcessorInput = {
    label: draft.label,
    blurb: draft.blurb,
    routing: draft.routing,
    status: draft.active ? 'active' : 'retired',
    logo: draft.logo,
    notes: draft.notes,
  };
  // Mirror of the server check, for button gating and inline copy.
  const idsForCheck = useMemo(() => {
    if (!processor) return existingIds;
    const s = new Set(existingIds);
    s.delete(processor.id);
    return s;
  }, [existingIds, processor]);
  const check = validatePayProcessorInput(input, isNew ? 'create' : 'edit', idsForCheck);
  const drift = processor ? routingDrift({ id: processor.id, routing: draft.routing }) : null;
  const visual = ROUTING_VISUAL[draft.routing];

  const pickFile = (file: File | null) => {
    setLogoError(null);
    if (!file) return;
    if (!(PAY_PROCESSOR_LOGO_MIMES as readonly string[]).includes(file.type)) {
      setLogoError('Use a PNG, SVG, WebP or JPEG.');
      return;
    }
    if (file.size > PAY_PROCESSOR_LOGO_MAX_BYTES) {
      setLogoError(`That file is ${Math.ceil(file.size / 1024)} KB — the limit is ${PAY_PROCESSOR_LOGO_MAX_BYTES / 1024} KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setLogoError('Could not read that file.');
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith(`data:${file.type};base64,`)) {
        setLogoError('Could not read that file as an image.');
        return;
      }
      setDraft((d) => ({ ...d, logo: { kind: 'data', dataUrl, mime: file.type, bytes: file.size } }));
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!check.ok || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/payment-catalog/pay-processors', {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isNew ? input : { id: processor.id, ...input }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      toast.success(isNew ? `${draft.label.trim()} added` : `${draft.label.trim()} updated`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the processor');
    } finally {
      setSaving(false);
    }
  };

  const previewSrc = payProcessorLogoSrc(draft.logo);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      {/* Height-capped + scrolling body: a tall dialog must never clip its footer.
          Keeps the primitive's default p-4 — DialogFooter bleeds to the popup edges
          with -mx-4 -mb-4 and assumes that padding; a p-0 content hangs the footer
          16px outside the rounded border on three sides. */}
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] flex-col overflow-hidden sm:max-h-[90dvh] sm:max-w-lg">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-orange-500" />
            {isNew ? 'Add a pay processor' : `Edit ${processor.label}`}
          </DialogTitle>
          <DialogDescription>
            {isNew
              ? 'A new place Accounting can send salaries from. It shows here right away; Payment Dispatch routes on it once engineering wires the id.'
              : processor.wiredInCode
                ? 'This processor is wired into Payment Dispatch. Its id never changes — rename freely.'
                : 'Not wired into Payment Dispatch yet — edits show here only.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          {/* Identity */}
          <div className="flex items-start gap-3">
            <div className="shrink-0">
              <ProcessorLogo
                monogram={monogramOf(draft.label || '?')}
                gradient={visual.gradient}
                FallbackIcon={visual.Icon}
                logoSrc={previewSrc ?? undefined}
                className="h-11 w-[80px]"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <Field label="Name" hint={isNew && draft.label.trim() ? `id: ${slugifyProcessorId(draft.label) || '—'}` : undefined}>
                <Input
                  value={draft.label}
                  maxLength={PAY_PROCESSOR_LABEL_MAX}
                  placeholder="e.g. PayPal"
                  autoFocus
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                />
              </Field>
              <Field label="Blurb">
                <Input
                  value={draft.blurb}
                  maxLength={PAY_PROCESSOR_BLURB_MAX}
                  placeholder="e.g. Email only"
                  onChange={(e) => setDraft((d) => ({ ...d, blurb: e.target.value }))}
                />
              </Field>
            </div>
          </div>

          {/* Logo */}
          <Field label="Logo" hint={`PNG, SVG, WebP or JPEG · up to ${PAY_PROCESSOR_LOGO_MAX_BYTES / 1024} KB · shown on a white plate`}>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                pickFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickFile(e.dataTransfer.files?.[0] ?? null);
              }}
              className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/40"
            >
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <ImagePlus className="mr-1 h-3.5 w-3.5" />
                {draft.logo ? 'Replace' : 'Upload'}
              </Button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {draft.logo
                  ? draft.logo.kind === 'public'
                    ? `Shipped asset ${draft.logo.src}`
                    : `${draft.logo.mime.replace('image/', '').toUpperCase()} · ${Math.ceil(draft.logo.bytes / 1024)} KB`
                  : 'or drop a file here'}
              </span>
              {draft.logo && (
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, logo: null }))}
                  aria-label="Remove logo"
                  className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {logoError && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{logoError}</p>}
          </Field>

          {/* Classification */}
          <Field label="How it pays out">
            <div className="grid gap-2 sm:grid-cols-2">
              {PAY_PROCESSOR_ROUTINGS.map((r) => {
                const v = ROUTING_VISUAL[r];
                const selected = draft.routing === r;
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setDraft((d) => ({ ...d, routing: r }))}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-colors',
                      selected
                        ? 'border-orange-400 bg-orange-50/70 dark:border-blue-500 dark:bg-blue-950/40'
                        : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700',
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      <v.Icon className="h-3.5 w-3.5 text-zinc-500" />
                      {PAY_PROCESSOR_ROUTING_LABEL[r]}
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {PAY_PROCESSOR_ROUTING_HELP[r]}
                    </span>
                  </button>
                );
              })}
            </div>
            {drift && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Payment Dispatch currently routes {processor?.label} as{' '}
                  <strong>{PAY_PROCESSOR_ROUTING_LABEL[drift.code]}</strong>. Saving records{' '}
                  {PAY_PROCESSOR_ROUTING_LABEL[drift.registry]} here as the source of truth; dispatch
                  follows once the integration reads this registry.
                </span>
              </div>
            )}
          </Field>

          {/* Status */}
          <Field label="Status">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span className="text-xs text-zinc-700 dark:text-zinc-300">
                {draft.active ? 'Active — Accounting can pay from it.' : 'Retired — kept for history, offered nowhere.'}
              </span>
              <Switch checked={draft.active} onCheckedChange={(v) => setDraft((d) => ({ ...d, active: v }))} />
            </label>
          </Field>

          {/* Notes */}
          <Field label="Notes" hint={`${draft.notes.length}/${PAY_PROCESSOR_NOTES_MAX}`}>
            <textarea
              value={draft.notes}
              maxLength={PAY_PROCESSOR_NOTES_MAX}
              rows={3}
              placeholder="Who owns the login, account holder name, cut-off times…"
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              className="w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </Field>
        </div>

        <DialogFooter className="shrink-0">
          <div className="mr-auto min-w-0 self-center text-[11px] text-red-600 dark:text-red-400">
            {!check.ok && draft.label.trim() ? check.error : null}
          </div>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!check.ok || saving}>
            {saving ? 'Saving…' : isNew ? 'Add processor' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
        {hint && <span className="truncate text-[10.5px] text-zinc-400 dark:text-zinc-500">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
