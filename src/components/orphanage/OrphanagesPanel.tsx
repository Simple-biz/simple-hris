'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Building2,
  ImagePlus,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Manager-maintained directory of partner orphanages, backed by the
 * `public.orphanages` table (see references/create_orphanages.sql). Managers
 * add entries via the "Add orphanage" button (name, location, number of
 * children, phone, email, leftover budget, optional photo). The
 * `leftoverBudget` value drives the "Leftover from prev month" defaults on the
 * budget request form.
 */

const PESO = '₱';

interface Orphanage {
  id: string;
  name: string;
  location: string | null;
  children: number;
  phone: string | null;
  email: string | null;
  leftoverBudget: number;
  imageUrl: string | null;
}

type Row = {
  id: string;
  name: string;
  location: string | null;
  children: number;
  phone: string | null;
  email: string | null;
  leftover_budget: number | string;
  image_url: string | null;
};

function rowToOrphanage(r: Row): Orphanage {
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    children: Number(r.children) || 0,
    phone: r.phone,
    email: r.email,
    leftoverBudget: Number(r.leftover_budget) || 0,
    imageUrl: r.image_url,
  };
}

function formatPHP(n: number): string {
  return `${PESO}${n.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function OrphanagesPanel({
  viewerEmail,
}: {
  viewerEmail?: string | null;
}) {
  const [orphanages, setOrphanages] = useState<Orphanage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Orphanage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/orphanages', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to load orphanages');
      setOrphanages((json.rows as Row[]).map(rowToOrphanage));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalLeftover = orphanages.reduce((sum, o) => sum + o.leftoverBudget, 0);
  const fundedCount = orphanages.filter((o) => o.leftoverBudget > 0).length;

  const handleSaveLeftover = useCallback(async (id: string, value: number) => {
    setOrphanages((prev) =>
      prev.map((row) => (row.id === id ? { ...row, leftoverBudget: value } : row)),
    );
    try {
      const res = await fetch(`/api/orphanages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leftover_budget: value }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || 'Failed to save');
      }
    } catch (e) {
      toast.error(`Could not save leftover budget: ${(e as Error).message}`);
    }
  }, []);

  const handleDelete = useCallback(async (o: Orphanage) => {
    if (!window.confirm(`Remove "${o.name}" from the directory? This cannot be undone.`)) return;
    const prev = orphanages;
    setOrphanages((rows) => rows.filter((r) => r.id !== o.id));
    try {
      const res = await fetch(`/api/orphanages/${o.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || 'Failed to delete');
      }
      toast.success(`Removed ${o.name}`);
    } catch (e) {
      setOrphanages(prev);
      toast.error(`Could not remove: ${(e as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanages]);

  return (
    <div className="flex flex-col gap-5">
      {/* Summary strip + add button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="grid flex-1 gap-3 sm:grid-cols-3">
          <SummaryTile label="Orphanages tracked" value={orphanages.length.toString()} />
          <SummaryTile label="With leftover funds" value={fundedCount.toString()} />
          <SummaryTile label="Total leftover" value={formatPHP(totalLeftover)} prominent />
        </div>
        <Button
          type="button"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          className="shrink-0 gap-2 self-stretch bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800 sm:self-auto"
        >
          <Plus className="h-4 w-4" />
          Add orphanage
        </Button>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {loadError}{' '}
          <button type="button" onClick={() => void load()} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading orphanages...
        </div>
      ) : orphanages.length === 0 ? (
        <EmptyState
          onAdd={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {orphanages.map((o) => (
            <OrphanageCard
              key={o.id}
              orphanage={o}
              onChangeLeftover={(value) => void handleSaveLeftover(o.id, value)}
              onEdit={() => {
                setEditing(o);
                setDialogOpen(true);
              }}
              onDelete={() => void handleDelete(o)}
            />
          ))}
        </div>
      )}

      <OrphanageDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        viewerEmail={viewerEmail}
        onSaved={(saved) => {
          setOrphanages((prev) => {
            const exists = prev.some((r) => r.id === saved.id);
            const next = exists
              ? prev.map((r) => (r.id === saved.id ? saved : r))
              : [...prev, saved];
            return next.sort((a, b) => a.name.localeCompare(b.name));
          });
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

// ----------------------------- Add/Edit dialog -----------------------------

function OrphanageDialog({
  open,
  onOpenChange,
  editing,
  viewerEmail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  editing: Orphanage | null;
  viewerEmail?: string | null;
  onSaved: (row: Orphanage) => void;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [children, setChildren] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [leftover, setLeftover] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Reset/prefill whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setLocation(editing?.location ?? '');
    setChildren(editing ? String(editing.children) : '');
    setPhone(editing?.phone ?? '');
    setEmail(editing?.email ?? '');
    setLeftover(editing ? String(editing.leftoverBudget) : '');
    setImageUrl(editing?.imageUrl ?? null);
  }, [open, editing]);

  const handlePickImage = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/orphanages/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Upload failed');
      setImageUrl(json.url as string);
    } catch (e) {
      toast.error(`Image upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      location: location.trim() || null,
      children: Number.parseInt(children, 10) || 0,
      phone: phone.trim() || null,
      email: email.trim() || null,
      leftover_budget: Number.parseFloat(leftover) || 0,
      image_url: imageUrl,
      ...(editing ? {} : { created_by: viewerEmail ?? null }),
    };
    try {
      const res = await fetch(
        editing ? `/api/orphanages/${editing.id}` : '/api/orphanages',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Save failed');
      onSaved(rowToOrphanage(json.row as Row));
      toast.success(editing ? 'Orphanage updated' : 'Orphanage added');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const childCount = Number.parseInt(children, 10) || 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto border-pink-100/70 bg-white p-0 [scrollbar-width:none] sm:max-w-[64rem] [&::-webkit-scrollbar]:hidden dark:border-pink-950/50 dark:bg-zinc-950">
        <div className="grid md:grid-cols-[minmax(0,38%)_1fr]">
          {/* ── Photo hero (left) — also a live preview of the card ── */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handlePickImage(f);
              e.target.value = '';
            }}
          />
          <div
            role={imageUrl ? undefined : 'button'}
            tabIndex={imageUrl ? undefined : 0}
            onClick={imageUrl ? undefined : () => fileRef.current?.click()}
            onKeyDown={
              imageUrl
                ? undefined
                : (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileRef.current?.click();
                    }
                  }
            }
            className={cn(
              'group relative isolate min-h-[260px] overflow-hidden md:min-h-[480px]',
              'bg-gradient-to-br from-pink-500 via-rose-500 to-rose-700',
              !imageUrl && 'cursor-pointer',
            )}
          >
            {/* Decorative atmosphere on the placeholder */}
            {!imageUrl && (
              <>
                <div className="pointer-events-none absolute -left-12 -top-12 h-48 w-48 rounded-full bg-white/15 blur-2xl" />
                <div className="pointer-events-none absolute bottom-0 right-0 h-56 w-56 translate-x-1/4 translate-y-1/4 rounded-full bg-rose-900/30 blur-3xl" />
                <div
                  className="pointer-events-none absolute inset-0 opacity-[0.07]"
                  style={{
                    backgroundImage:
                      'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
                    backgroundSize: '16px 16px',
                  }}
                />
              </>
            )}

            {imageUrl ? (
              <>
                {/* Blurred fill so the whole photo can sit uncropped on top */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-contain"
                />
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 text-white shadow-lg shadow-rose-950/20 ring-1 ring-white/30 backdrop-blur-sm transition-transform duration-300 group-hover:scale-105">
                  {uploading ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <ImagePlus className="h-7 w-7" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">
                    {uploading ? 'Uploading...' : 'Add a photo'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-white/70">
                    Click to upload &middot; JPG or PNG, up to 5&nbsp;MB
                  </p>
                </div>
              </div>
            )}

            {/* Bottom scrim + live caption (name / location / children) */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent p-4 pt-12">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold leading-tight text-white drop-shadow">
                    {name.trim() || 'New orphanage'}
                  </p>
                  {location.trim() && (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-white/80">
                      <MapPin className="h-3 w-3 shrink-0" />
                      <span className="truncate">{location.trim()}</span>
                    </p>
                  )}
                </div>
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-white/30 backdrop-blur-sm">
                  <Users className="h-3 w-3" />
                  {childCount}
                </span>
              </div>
            </div>

            {/* Hover controls when an image is present */}
            {imageUrl && (
              <div className="absolute inset-x-0 top-0 flex justify-center gap-2 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-zinc-800 shadow-sm backdrop-blur transition-colors hover:bg-white disabled:opacity-60"
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ImagePlus className="h-3.5 w-3.5" />
                  )}
                  Replace
                </button>
                <button
                  type="button"
                  onClick={() => setImageUrl(null)}
                  className="flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-rose-600 shadow-sm backdrop-blur transition-colors hover:bg-white"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>
            )}
          </div>

          {/* ── Form (right) ── */}
          <div className="flex flex-col">
            <DialogHeader className="border-b border-pink-100/70 px-6 py-5 pr-12 text-left dark:border-pink-950/45">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
                  <Building2 className="h-4 w-4" />
                </div>
                <DialogTitle className="text-base font-semibold">
                  {editing ? 'Edit orphanage' : 'Add orphanage'}
                </DialogTitle>
              </div>
              <DialogDescription className="text-xs">
                {editing
                  ? 'Update the details for this partner orphanage.'
                  : 'Add a partner orphanage your team rotates through.'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 px-6 py-4">
              <div className="col-span-2">
                <Field id="orph-name" label="Name" required>
                  <Input
                    id="orph-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Orphanage name"
                  />
                </Field>
              </div>

              <div className="col-span-2">
                <Field id="orph-location" label="Location">
                  <div className="relative">
                    <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-400/70" />
                    <Input
                      id="orph-location"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="City / address"
                      className="pl-9"
                    />
                  </div>
                </Field>
              </div>

              <Field id="orph-children" label="Children">
                <div className="relative">
                  <Users className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-400/70" />
                  <Input
                    id="orph-children"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step="1"
                    value={children}
                    onChange={(e) => setChildren(e.target.value)}
                    placeholder="0"
                    className="pl-9"
                  />
                </div>
              </Field>

              <Field id="orph-leftover" label="Leftover budget">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-pink-400/80">
                    {PESO}
                  </span>
                  <Input
                    id="orph-leftover"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={leftover}
                    onChange={(e) => setLeftover(e.target.value)}
                    className="pl-8 font-mono tabular-nums"
                    placeholder="0.00"
                  />
                </div>
              </Field>

              <Field id="orph-phone" label="Phone number">
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-400/70" />
                  <Input
                    id="orph-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+63 ..."
                    className="pl-9 font-mono"
                  />
                </div>
              </Field>

              <Field id="orph-email" label="Email">
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-pink-400/70" />
                  <Input
                    id="orph-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="contact@example.org"
                    className="pl-9 font-mono"
                  />
                </div>
              </Field>
            </div>

            <DialogFooter className="mt-auto gap-2 border-t border-pink-100/70 px-6 py-4 dark:border-pink-950/45">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={saving || uploading}
                className="gap-2 bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? 'Save changes' : 'Add orphanage'}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor={id}
        className="text-xs font-semibold uppercase tracking-wide text-pink-700/80 dark:text-pink-300/80"
      >
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {children}
    </div>
  );
}

// ----------------------------- Empty state -----------------------------

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-pink-200/80 bg-pink-50/30 py-16 text-center dark:border-pink-900/40 dark:bg-pink-950/15">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-600/25">
        <Building2 className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-semibold text-zinc-900 dark:text-white">No orphanages yet</p>
        <p className="mt-1 text-xs text-zinc-500">
          Add the partner orphanages your team rotates through.
        </p>
      </div>
      <Button
        type="button"
        onClick={onAdd}
        className="gap-2 bg-gradient-to-br from-pink-600 to-rose-700 text-white hover:from-pink-600 hover:to-rose-800"
      >
        <Plus className="h-4 w-4" />
        Add orphanage
      </Button>
    </div>
  );
}

// ----------------------------- Subcomponents -----------------------------

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
          prominent ? 'text-pink-800 dark:text-pink-200' : 'text-zinc-900 dark:text-white',
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
  onEdit,
  onDelete,
}: {
  orphanage: Orphanage;
  onChangeLeftover: (next: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Local string state so the user can clear / partially-type the field
  // without it snapping back to a number every keystroke. Persists on blur.
  const [draft, setDraft] = useState<string>(orphanage.leftoverBudget.toFixed(2));

  useEffect(() => {
    setDraft(orphanage.leftoverBudget.toFixed(2));
  }, [orphanage.leftoverBudget]);

  const commit = (raw: string) => {
    const n = Number.parseFloat(raw);
    onChangeLeftover(Number.isFinite(n) ? n : 0);
  };

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-pink-100/80 bg-white shadow-sm transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-950/45 dark:bg-zinc-950/60">
      {/* Photo */}
      <div className="relative h-32 w-full overflow-hidden bg-gradient-to-br from-pink-100 to-rose-200/60 dark:from-pink-950/40 dark:to-rose-950/30">
        {orphanage.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={orphanage.imageUrl}
            alt={orphanage.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Building2 className="h-8 w-8 text-pink-400/70" />
          </div>
        )}
        <div className="absolute right-2 top-2 flex gap-1">
          <IconButton label="Edit" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Remove" danger onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
          {orphanage.name}
        </h3>

        <dl className="flex flex-col gap-1.5 text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
          {orphanage.location && <DetailRow Icon={MapPin} value={orphanage.location} />}
          <DetailRow Icon={Users} value={`${orphanage.children} children`} />
          {orphanage.phone && <DetailRow Icon={Phone} value={orphanage.phone} mono />}
          {orphanage.email && <DetailRow Icon={Mail} value={orphanage.email} mono />}
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
                {PESO}
              </span>
              <Input
                id={`${orphanage.id}-leftover`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={(e) => commit(e.target.value)}
                className="pl-7"
                placeholder="0.00"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft('0');
                commit('0');
              }}
              className="h-9 shrink-0 border-pink-200/70 px-3 text-[11px] dark:border-pink-900/45"
            >
              Clear
            </Button>
          </div>
          <p className="mt-1 text-[10.5px] text-zinc-500 dark:text-zinc-500">
            Current: {formatPHP(orphanage.leftoverBudget)}
          </p>
        </div>
      </div>
    </article>
  );
}

function IconButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-zinc-700 shadow-sm backdrop-blur transition-colors hover:bg-white dark:bg-zinc-900/90 dark:text-zinc-200',
        danger && 'hover:text-rose-600 dark:hover:text-rose-400',
      )}
    >
      {children}
    </button>
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
      <span className={cn('min-w-0 truncate', mono && 'font-mono text-[11.5px]')} title={value}>
        {value}
      </span>
    </div>
  );
}
