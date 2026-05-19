'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Archive,
  CheckCircle2,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCopy,
  Eye,
  FileText,
  Link2,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  User,
} from 'lucide-react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type HubstaffProject = { id: string | number; name: string };

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

type HrOnboardingStatus = 'pending' | 'submitted' | 'archived';
type PaymentMethod = 'hurupay' | 'wires';

type SubmissionRow = {
  id: string;
  token: string;
  status: HrOnboardingStatus;
  created_at: string;
  created_by: string | null;
  submitted_at: string | null;
  invite_name: string | null;
  invite_personal_email: string | null;
  invite_department: string | null;
  invite_note: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  non_solicitation_signature: string | null;
  privacy_signature: string | null;
  w8ben_applicable: boolean | null;
  w8ben_file_path: string | null;
  w8ben_file_name: string | null;
  payment_method: PaymentMethod | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_street: string | null;
  bank_city: string | null;
  bank_province: string | null;
  bank_postal_code: string | null;
  bank_full_address: string | null;
  contract_signature: string | null;
  contract_date: string | null;
};

type StatusFilter = 'all' | HrOnboardingStatus;

const STATUS_BADGE: Record<HrOnboardingStatus, string> = {
  pending:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100',
  submitted:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  archived:
    'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
};

const STATUS_LABEL: Record<HrOnboardingStatus, string> = {
  pending: 'Awaiting submission',
  submitted: 'Submitted',
  archived: 'Archived',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function publicLinkFor(token: string): string {
  if (typeof window === 'undefined') return `/onboarding/${token}`;
  return `${window.location.origin}/onboarding/${token}`;
}

export default function HrOnboardingForm() {
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('pending');
  const [search, setSearch] = useState('');

  const [generateOpen, setGenerateOpen] = useState(false);
  const [linkCreated, setLinkCreated] = useState<SubmissionRow | null>(null);
  const [viewRow, setViewRow] = useState<SubmissionRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SubmissionRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/hr/onboarding-submissions', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: SubmissionRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setRows(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load submissions');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c = { pending: 0, submitted: 0, archived: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false;
      if (!q) return true;
      return [r.invite_name, r.invite_personal_email, r.invite_department, r.full_name, r.email]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [rows, filter, search]);

  async function archive(row: SubmissionRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/onboarding-submissions/${row.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to archive');
      toast.success('Submission archived');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to archive');
    } finally {
      setBusyId(null);
      setArchiveTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Hero strip */}
      <div className="rounded-2xl border border-emerald-100/80 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/60 p-5 dark:border-emerald-950/40 dark:from-emerald-950/20 dark:via-zinc-950 dark:to-teal-950/15">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-700/80">
              <Sparkles className="h-3 w-3" />
              Self-serve onboarding
            </div>
            <h2 className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Send new hires a shareable form — no SSO required.
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Generate a unique link and email it to the new hire. They complete the 6-step
              form (personal info, agreements, W-8BEN upload, payment method, contract) and
              the submission lands here for you to review.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:opacity-95"
              onClick={() => setGenerateOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Generate link
            </Button>
            <Button
              variant="outline"
              className="border-emerald-200 text-emerald-800"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Filter + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1">
          <FilterPill label="Awaiting" count={counts.pending} active={filter === 'pending'} onClick={() => setFilter('pending')} />
          <FilterPill label="Submitted" count={counts.submitted} active={filter === 'submitted'} onClick={() => setFilter('submitted')} />
          <FilterPill label="Archived" count={counts.archived} active={filter === 'archived'} onClick={() => setFilter('archived')} />
          <FilterPill label="All" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, dept…"
            className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
          />
        </div>
      </div>

      {/* Submissions table */}
      <div className="overflow-hidden rounded-xl border border-emerald-100/80 bg-white shadow-sm ring-1 ring-emerald-500/5 dark:border-emerald-950/40 dark:bg-zinc-950">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-zinc-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <FileText className="h-8 w-8 text-emerald-300" />
            <p className="text-sm text-zinc-500">
              {rows.length === 0
                ? 'No onboarding links yet — click "Generate link" to send your first one.'
                : 'No submissions match this filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm sm:min-w-[860px]">
              <thead className="border-b border-emerald-100/60 bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:border-emerald-900/40 dark:from-emerald-950/40 dark:via-zinc-950 dark:to-emerald-950/30 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Invitee</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                  <th className="px-4 py-3 font-semibold">Submitted</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100/60 dark:divide-emerald-900/30">
                {filtered.map((r) => {
                  const isBusy = busyId === r.id;
                  return (
                    <tr key={r.id} className="align-top hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20">
                      <td data-label="Invitee" className="px-4 py-3">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          {r.invite_name ?? r.full_name ?? '—'}
                        </div>
                        <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-500">
                          {r.invite_personal_email ?? r.email ?? '—'}
                        </div>
                      </td>
                      <td data-label="Department" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                        {r.invite_department ?? '—'}
                      </td>
                      <td data-label="Status" className="px-4 py-3">
                        <Badge variant="outline" className={cn('text-[10px] font-medium', STATUS_BADGE[r.status])}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                      </td>
                      <td data-label="Created" className="px-4 py-3 text-xs text-zinc-500">
                        {fmtDateTime(r.created_at)}
                      </td>
                      <td data-label="Submitted" className="px-4 py-3 text-xs text-zinc-500">
                        {fmtDateTime(r.submitted_at)}
                      </td>
                      <td data-label="Actions" className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1.5">
                          {r.status === 'pending' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                void navigator.clipboard.writeText(publicLinkFor(r.token));
                                toast.success('Link copied');
                              }}
                              title="Copy public link"
                            >
                              <ClipboardCopy className="mr-1 h-3 w-3" />
                              Copy link
                            </Button>
                          )}
                          {r.status === 'submitted' && (
                            <Button
                              size="sm"
                              className="h-7 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90"
                              onClick={() => setViewRow(r)}
                            >
                              <Eye className="mr-1 h-3 w-3" />
                              View
                            </Button>
                          )}
                          {r.status !== 'archived' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs text-zinc-600 hover:bg-zinc-50"
                              onClick={() => setArchiveTarget(r)}
                              disabled={isBusy}
                              title="Archive"
                            >
                              <Archive className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <GenerateLinkDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreated={(row) => {
          setGenerateOpen(false);
          setLinkCreated(row);
          void load();
        }}
      />

      <LinkCreatedDialog
        row={linkCreated}
        onClose={() => setLinkCreated(null)}
      />

      <SubmissionDetailDialog
        row={viewRow}
        onClose={() => setViewRow(null)}
      />

      <Dialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Archive this submission?</DialogTitle>
            <DialogDescription className="text-xs">
              The link will stop working. You can still see archived submissions under the
              Archived filter, but the new hire won't be able to open or submit the form.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => setArchiveTarget(null)}>
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-zinc-700 hover:bg-zinc-800"
              onClick={() => archiveTarget && void archive(archiveTarget)}
              disabled={busyId === archiveTarget?.id}
            >
              {busyId === archiveTarget?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Archive className="mr-1 h-3 w-3" />
              )}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Generate link dialog ─────────────────────────────────────────────────

function GenerateLinkDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (row: SubmissionRow) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [dept, setDept] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [departments, setDepartments] = useState<HubstaffProject[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(false);

  // Pull the department list the moment the modal opens so the dropdown
  // doesn't sit on "Loading…" while the user is already typing.
  useEffect(() => {
    if (!open) return;
    if (departments.length > 0 || deptsLoading) return;
    setDeptsLoading(true);
    fetch('/api/secondary/hubstaff-projects', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { projects?: HubstaffProject[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setDepartments(j.projects ?? []);
      })
      .catch((e) =>
        toast.error(e instanceof Error ? e.message : 'Could not load departments'),
      )
      .finally(() => setDeptsLoading(false));
  }, [open, departments.length, deptsLoading]);

  useEffect(() => {
    if (!open) {
      setName(''); setEmail(''); setDept(''); setNote('');
    }
  }, [open]);

  const emailInvalid = email.trim().length > 0 && !isPlausibleEmail(email);

  async function submit() {
    if (emailInvalid) {
      toast.error("Personal email doesn't look right.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/hr/onboarding-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invite_name: name.trim() || null,
          invite_personal_email: email.trim() || null,
          invite_department: dept.trim() || null,
          invite_note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as { row?: SubmissionRow; error?: string };
      if (!res.ok || json.error || !json.row) throw new Error(json.error ?? 'Failed to create link');
      onCreated(json.row);
      toast.success('Onboarding link created');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        {/* Decorative header strip — same emerald gradient as the dashboard hero */}
        <div className="-mx-6 -mt-6 mb-1 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <Link2 className="h-4 w-4" />
              </span>
              Generate onboarding link
            </DialogTitle>
            <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              We'll mint a one-time, no-SSO link for the new hire. Pre-fill what you know — they
              see it on the form and the cover email writes itself.
            </p>
          </DialogHeader>
        </div>

        <DialogSection label="Who is this for?">
          <div className="grid gap-3 sm:grid-cols-2">
            <DialogField label="New hire's full name" icon={<User className="h-3 w-3" />}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Dela Cruz"
                autoFocus
              />
            </DialogField>
            <DialogField
              label="Personal email"
              icon={<Mail className="h-3 w-3" />}
              error={emailInvalid ? "Doesn't look like an email" : undefined}
              hint={!emailInvalid && email.trim() === '' ? 'We use this to pre-fill the mailto link.' : undefined}
            >
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@gmail.com"
                aria-invalid={emailInvalid || undefined}
              />
            </DialogField>
          </div>
        </DialogSection>

        <DialogSection label="Where will they work?">
          <DialogField label="Department" hint={deptsLoading ? 'Loading from Hubstaff…' : 'Optional — helps HR sort submissions.'}>
            <DepartmentSelect
              value={dept}
              onChange={setDept}
              departments={departments}
              loading={deptsLoading}
            />
          </DialogField>
        </DialogSection>

        <DialogSection label="Cover note" last>
          <DialogField
            label="Note for the new hire (optional)"
            hint="Shown at the top of the form and copied into the welcome email body."
          >
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Welcome! Please complete this before your first day so payroll can set you up."
              rows={3}
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20 dark:border-input dark:bg-input/30"
            />
          </DialogField>
        </DialogSection>

        <DialogFooter className="gap-2 pt-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25 hover:from-emerald-500 hover:to-teal-600"
            onClick={() => void submit()}
            disabled={busy || emailInvalid}
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
            {busy ? 'Generating…' : 'Generate link'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Department dropdown (Base UI Select, matches AddPersonDialog style) ──

function DepartmentSelect({
  value,
  onChange,
  departments,
  loading,
}: {
  value: string;
  onChange: (v: string) => void;
  departments: HubstaffProject[];
  loading: boolean;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return departments;
    return departments.filter((d) => d.name.toLowerCase().includes(q));
  }, [departments, query]);

  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={loading}
      onOpenChange={(open) => { if (!open) setQuery(''); }}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none dark:border-input',
          'data-placeholder:text-muted-foreground',
          'hover:border-zinc-400 dark:hover:border-zinc-500',
          'focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-input/30',
        )}
      >
        <SelectPrimitive.Value
          placeholder={loading ? 'Loading departments…' : 'Select department'}
          className="flex-1 text-left"
        />
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" sideOffset={4} alignItemWithTrigger className="isolate z-50">
          <SelectPrimitive.Popup className="w-(--anchor-width) min-w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-black/8 dark:border-zinc-700 dark:bg-zinc-900 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            {/* Sticky search input — stopPropagation keeps Base UI's typeahead off
                so the user types into the input, not against item keys. */}
            <div className="sticky top-0 z-[1] border-b border-zinc-100 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && filtered.length === 1) {
                      e.preventDefault();
                      onChange(filtered[0].name);
                    }
                  }}
                  placeholder="Search departments…"
                  autoFocus
                  className="h-8 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </div>
            </div>
            <SelectPrimitive.List className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
                  {loading
                    ? 'Loading…'
                    : query.trim()
                      ? `No departments match "${query.trim()}".`
                      : 'No departments on file yet.'}
                </div>
              ) : (
                filtered.map((d) => (
                  <SelectPrimitive.Item
                    key={String(d.id)}
                    value={d.name}
                    className={cn(
                      'relative flex w-full cursor-default items-center justify-between rounded-lg px-3 py-2 text-sm outline-none select-none',
                      'focus:bg-emerald-50 focus:text-emerald-900 dark:focus:bg-emerald-950/50 dark:focus:text-emerald-100',
                      'data-highlighted:bg-emerald-50 data-highlighted:text-emerald-900 dark:data-highlighted:bg-emerald-950/50 dark:data-highlighted:text-emerald-100',
                    )}
                  >
                    <SelectPrimitive.ItemText className="flex-1 truncate pr-2">
                      {d.name}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="flex h-4 w-4 items-center justify-center">
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))
              )}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ─── Section / Field wrappers (reuse the AddPersonDialog visual rhythm) ───

function DialogSection({
  label,
  last,
  children,
}: {
  label: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('space-y-3 pt-4', !last && 'border-b border-zinc-200 pb-4 dark:border-zinc-800')}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function DialogField({
  label,
  icon,
  hint,
  error,
  children,
}: {
  label: string;
  icon?: ReactNode;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-400">
        {icon && <span className="text-zinc-400">{icon}</span>}
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] text-rose-500">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-500">{hint}</p>
      ) : null}
    </div>
  );
}

// ─── Link-created dialog (shows the URL with a Copy button) ───────────────

function LinkCreatedDialog({
  row,
  onClose,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
}) {
  const [justCopied, setJustCopied] = useState(false);
  useEffect(() => {
    if (!row) setJustCopied(false);
  }, [row]);

  const url = row ? publicLinkFor(row.token) : '';
  const firstName = row?.invite_name ? row.invite_name.split(/\s+/)[0] : null;
  const mailtoSubject = encodeURIComponent('Your Simple.biz onboarding form');
  const mailtoBodyRaw = `Hi${firstName ? ` ${firstName}` : ''},\n\nWelcome to Simple.biz! Please complete your onboarding form here — it should take about 10 minutes:\n\n${url}\n\nNo account needed; the link is private to you.\n\nLet me know if you hit any issues.\n`;
  const mailto = row?.invite_personal_email
    ? `mailto:${row.invite_personal_email}?subject=${mailtoSubject}&body=${encodeURIComponent(mailtoBodyRaw)}`
    : `mailto:?subject=${mailtoSubject}&body=${encodeURIComponent(mailtoBodyRaw)}`;

  const copy = () => {
    void navigator.clipboard.writeText(url);
    setJustCopied(true);
    toast.success('Link copied to clipboard');
    setTimeout(() => setJustCopied(false), 1500);
  };

  if (!row) return null;

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        {/* Header strip — mirrors the GenerateLinkDialog so the two feel like one flow. */}
        <div className="-mx-6 -mt-6 mb-1 overflow-hidden rounded-t-lg border-b border-emerald-100/80 bg-gradient-to-br from-emerald-50 via-white to-teal-50/60 px-6 py-5 dark:border-emerald-950/40 dark:from-emerald-950/30 dark:via-zinc-950 dark:to-teal-950/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-md shadow-emerald-600/25">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              Link ready to share
            </DialogTitle>
            <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              Send it to {row.invite_name ?? 'the new hire'}. No SSO needed — anyone with this
              link can complete the form one time.
            </p>
          </DialogHeader>
        </div>

        {/* Invitee context (only renders if HR filled any of the fields) */}
        {(row.invite_name || row.invite_personal_email || row.invite_department) && (
          <DialogSection label="For">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              {row.invite_name && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50/60 px-2 py-0.5 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <User className="h-3 w-3" />
                  {row.invite_name}
                </span>
              )}
              {row.invite_personal_email && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  <Mail className="h-3 w-3" />
                  {row.invite_personal_email}
                </span>
              )}
              {row.invite_department && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {row.invite_department}
                </span>
              )}
            </div>
          </DialogSection>
        )}

        <DialogSection label="Shareable link">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/30">
            <div className="flex items-start gap-2">
              <Link2 className="mt-[3px] h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <code
                className="flex-1 break-all font-mono text-[12px] leading-[1.55] text-emerald-900 dark:text-emerald-100"
                aria-label="Onboarding link"
              >
                {url}
              </code>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-200/60 pt-2.5 dark:border-emerald-900/40">
              <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300/80">
                Single-use — flips to "Submitted" the moment they finish.
              </p>
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  'h-7 border-emerald-300 text-xs transition-colors',
                  justCopied
                    ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                    : 'text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40',
                )}
                onClick={copy}
              >
                {justCopied ? (
                  <>
                    <CheckIcon className="mr-1 h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <ClipboardCopy className="mr-1 h-3 w-3" />
                    Copy link
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogSection>

        <DialogSection label="Send via email" last>
          <div className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-700">
                To
              </span>
              <span className="truncate text-zinc-800 dark:text-zinc-200">
                {row.invite_personal_email ?? <span className="italic text-zinc-400">no recipient — you'll fill it in</span>}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-700">
                Subject
              </span>
              <span className="truncate text-zinc-800 dark:text-zinc-200">
                Your Simple.biz onboarding form
              </span>
            </div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-white p-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              {mailtoBodyRaw.trim()}
            </pre>
          </div>
        </DialogSection>

        <DialogFooter className="gap-2 pt-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
          <a
            href={mailto}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-gradient-to-br from-emerald-500 to-teal-700 px-3 text-sm font-medium text-white shadow-md shadow-emerald-600/25 transition-opacity hover:opacity-90"
          >
            <Send className="h-3.5 w-3.5" />
            Email it now
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Submission detail dialog ─────────────────────────────────────────────

function SubmissionDetailDialog({
  row,
  onClose,
}: {
  row: SubmissionRow | null;
  onClose: () => void;
}) {
  const [w8benUrl, setW8benUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!row) {
      setW8benUrl(null);
      return;
    }
    if (!row.w8ben_file_path) {
      setW8benUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/hr/onboarding-submissions/${row.id}`, { cache: 'no-store' });
        const json = (await res.json()) as { w8benUrl?: string };
        if (!cancelled) setW8benUrl(json.w8benUrl ?? null);
      } catch {
        if (!cancelled) setW8benUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [row]);

  if (!row) return null;

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {row.full_name ?? row.invite_name ?? 'Onboarding submission'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Submitted {fmtDateTime(row.submitted_at)} · {row.invite_department ?? '—'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          <DetailSection title="Personal info">
            <DetailRow label="Full name" value={row.full_name} />
            <DetailRow label="Phone" value={row.phone} />
            <DetailRow label="Email" value={row.email} mono />
          </DetailSection>

          <DetailSection title="Agreement signatures">
            <SignaturePreview label="Non-solicitation" src={row.non_solicitation_signature} />
            <SignaturePreview label="Privacy" src={row.privacy_signature} />
            <SignaturePreview label="Contract worker agreement" src={row.contract_signature} />
            <DetailRow label="Contract date" value={fmtDate(row.contract_date)} />
          </DetailSection>

          <DetailSection title="W-8BEN">
            <DetailRow
              label="Applicable?"
              value={row.w8ben_applicable === null ? '—' : row.w8ben_applicable ? 'Yes — non-US' : 'No — US-based'}
            />
            {row.w8ben_file_name && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 truncate">
                  <FileText className="h-4 w-4 shrink-0 text-emerald-700" />
                  <span className="truncate">{row.w8ben_file_name}</span>
                </div>
                {w8benUrl ? (
                  <a
                    href={w8benUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-50"
                  >
                    Download
                  </a>
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin text-emerald-700" />
                )}
              </div>
            )}
          </DetailSection>

          <DetailSection title="Payment method">
            <DetailRow
              label="Method"
              value={row.payment_method === 'hurupay' ? 'Hurupay' : row.payment_method === 'wires' ? 'Wire transfer' : '—'}
            />
            {row.payment_method === 'wires' && (
              <div className="grid gap-1.5 sm:grid-cols-2">
                <DetailRow label="Bank" value={row.bank_full_name} />
                <DetailRow label="Account name" value={row.bank_account_name} />
                <DetailRow label="Account number" value={row.bank_account_number} mono />
                <DetailRow label="SWIFT" value={row.bank_swift_code} mono />
                <DetailRow label="Street" value={row.bank_street} />
                <DetailRow label="City" value={row.bank_city} />
                <DetailRow label="Province" value={row.bank_province} />
                <DetailRow label="Postal code" value={row.bank_postal_code} />
                <DetailRow label="Full address" value={row.bank_full_address} className="sm:col-span-2" />
              </div>
            )}
          </DetailSection>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700/80">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-xs', className)}>
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-right text-zinc-800 dark:text-zinc-200', mono && 'font-mono')}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function SignaturePreview({ label, src }: { label: string; src: string | null }) {
  if (!src) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-400">No signature</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-2">
      <div className="mb-1 text-[11px] font-medium text-zinc-600">{label}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={`${label} signature`} className="max-h-24 w-full object-contain" />
    </div>
  );
}

// ─── Filter pill ──────────────────────────────────────────────────────────

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 text-[10px] tabular-nums',
          active ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}
