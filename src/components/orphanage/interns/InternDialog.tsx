'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Banknote, GraduationCap, Loader2, UserRound, Wallet } from 'lucide-react';
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
import { isInternEmail, INTERN_EMAIL_DOMAIN } from '@/lib/interns/intern-email';
import { INTERN_DEFAULTS, formatInternPHP, type OrphanageInternRow } from '@/lib/interns/intern-types';
import { composeFullName } from '@/lib/hr/work-email';

interface OrphanageOption { id: string; name: string }
type Pane = 'profile' | 'pay' | 'bank';

/**
 * Add / edit an intern profile. The ONLY form that writes intern personal data
 * and bank details (Kane 2026-09-02). The email must be @pathway.ph — validated
 * here, re-checked by the route, and enforced last by the DB CHECK.
 *
 * Three tabs (Kane: "separate them in tabs") so every pane fits in one view
 * without scrolling: Profile · Pay · Bank. Height follows the house dialog rule
 * (dialog-content-no-height-cap): flex column, gap-0, dvh cap, shrink-0 chrome,
 * one min-h-0 scrolling body as the safety net.
 *
 * On create the first RATE is captured too (rate + effective date) so the
 * intern can be priced from day one; later changes go through "Change rate…".
 */
export default function InternDialog({
  open,
  editingId,
  viewerEmail: _viewerEmail,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  editingId: string | null;
  viewerEmail?: string | null;
  onOpenChange: (next: boolean) => void;
  onSaved: (intern: OrphanageInternRow) => void;
}) {
  const editing = editingId != null;
  // The parent passes an inline arrow, so its identity changes on every parent
  // render (presence / permission polling re-renders the whole dashboard). If
  // the reset effect below depended on it, every such render would wipe the form
  // mid-typing — which is exactly what happened. Read it through a ref instead.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const [pane, setPane] = useState<Pane>('profile');
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [saving, setSaving] = useState(false);
  // Validation speaks only after the user has acted: a field they left, or a
  // Save they attempted. An empty form is not an error yet — nagging "Full name
  // is required" before a keystroke is noise on a money/identity form.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const touch = (k: string) => setTouched((prev) => (prev.has(k) ? prev : new Set(prev).add(k)));
  const [orphanages, setOrphanages] = useState<OrphanageOption[]>([]);

  // Name PARTS, like Simple's onboarding (onboarding-name-parts.md): first + last
  // (+ extension) compose the stored full name; the middle name is kept but NEVER
  // composed in — it would change the go-by everywhere the name is printed.
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [lastName, setLastName] = useState('');
  const [nameExtension, setNameExtension] = useState('');
  const [email, setEmail] = useState('');
  const [personalEmail, setPersonalEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [orphanageId, setOrphanageId] = useState('');
  const [startedOn, setStartedOn] = useState('');
  const [note, setNote] = useState('');
  const [ratePhp, setRatePhp] = useState(String(INTERN_DEFAULTS.ratePhp));
  const [rateFrom, setRateFrom] = useState('');
  const [weeklyCap, setWeeklyCap] = useState(String(INTERN_DEFAULTS.weeklyCapHours));
  const [dailyCap, setDailyCap] = useState(String(INTERN_DEFAULTS.dailyCapHours));
  const [pabBonus, setPabBonus] = useState(String(INTERN_DEFAULTS.pabBonusPhp));
  const [sharePct, setSharePct] = useState(String(INTERN_DEFAULTS.orphanageSharePct));
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [swiftCode, setSwiftCode] = useState('');

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const res = await fetch('/api/orphanages', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: OrphanageOption[] };
        setOrphanages((json.rows ?? []).map((o) => ({ id: o.id, name: o.name })));
      } catch {
        setOrphanages([]);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setPane('profile');
    setTouched(new Set());
    setAttempted(false);
    const today = new Date().toISOString().slice(0, 10);
    if (!editingId) {
      setFirstName(''); setMiddleName(''); setLastName(''); setNameExtension('');
      setEmail(''); setPersonalEmail(''); setPhone(''); setOrphanageId(''); setNote('');
      setStartedOn(today);
      setRatePhp(String(INTERN_DEFAULTS.ratePhp)); setRateFrom(today);
      setWeeklyCap(String(INTERN_DEFAULTS.weeklyCapHours)); setDailyCap(String(INTERN_DEFAULTS.dailyCapHours));
      setPabBonus(String(INTERN_DEFAULTS.pabBonusPhp)); setSharePct(String(INTERN_DEFAULTS.orphanageSharePct));
      setBankName(''); setBankAccountName(''); setBankAccountNumber(''); setSwiftCode('');
      return;
    }
    setLoadingRecord(true);
    void (async () => {
      try {
        const res = await fetch(`/api/orphanage-interns/${editingId}?_=${Date.now()}`, { cache: 'no-store' });
        const json = (await res.json()) as { intern?: OrphanageInternRow; error?: string | null };
        if (!res.ok || json.error || !json.intern) throw new Error(json.error ?? 'Could not load the profile');
        const i = json.intern;
        setFirstName(i.first_name); setMiddleName(i.middle_name ?? ''); setLastName(i.last_name); setNameExtension(i.name_extension ?? '');
        setEmail(i.email); setPersonalEmail(i.personal_email ?? ''); setPhone(i.phone ?? '');
        setOrphanageId(i.orphanage_id ?? ''); setStartedOn(i.started_on ?? ''); setNote(i.note ?? '');
        setWeeklyCap(String(i.weekly_cap_hours)); setDailyCap(String(i.daily_cap_hours));
        setPabBonus(String(i.pab_bonus_php)); setSharePct(String(i.orphanage_share_pct));
        setBankName(i.bank_name); setBankAccountName(i.bank_account_name); setBankAccountNumber(i.bank_account_number); setSwiftCode(i.swift_code);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not load the profile');
        onOpenChangeRef.current(false);
      } finally {
        setLoadingRecord(false);
      }
    })();
    // Reset ONLY when the dialog opens or the record being edited changes.
  }, [open, editingId]);

  const emailOk = isInternEmail(email);
  const firstOk = firstName.trim().length > 0;
  const lastOk = lastName.trim().length > 0;
  const nameOk = firstOk && lastOk;
  const composedName = composeFullName(firstName, lastName, nameExtension);
  const rateOk = editing || (Number(ratePhp) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(rateFrom));
  const capsOk = Number(weeklyCap) > 0 && Number(dailyCap) > 0 && Number(pabBonus) >= 0 && Number(sharePct) >= 0 && Number(sharePct) <= 100;
  const bankMissing = !bankName.trim() || !bankAccountNumber.trim();
  const profileIssue = !firstOk ? 'First name is required' : !lastOk ? 'Last name is required' : !emailOk ? `Email must be @${INTERN_EMAIL_DOMAIN}` : null;
  const payIssue = !rateOk ? 'A first rate and its effective date are required' : !capsOk ? 'Caps must be positive; share 0–100%' : null;
  const valid = !profileIssue && !payIssue;
  // What the user has earned hearing about: a tab's issue shows once its fields
  // were touched or a save was attempted. The tab dots follow the same rule.
  const showProfileIssue =
    !!profileIssue && (attempted || (!firstOk ? touched.has('first') : !lastOk ? touched.has('last') : touched.has('email')));
  const showPayIssue = !!payIssue && (attempted || touched.has('pay'));
  const footerIssue = showProfileIssue ? profileIssue : showPayIssue ? payIssue : null;

  const save = async () => {
    if (saving) return;
    if (!valid) {
      // Take them to the problem instead of silently refusing.
      setAttempted(true);
      setPane(profileIssue ? 'profile' : 'pay');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        first_name: firstName.trim(),
        middle_name: middleName.trim() || null,
        last_name: lastName.trim(),
        name_extension: nameExtension.trim() || null,
        email: email.trim().toLowerCase(),
        personal_email: personalEmail.trim() || null,
        phone: phone.trim() || null,
        orphanage_id: orphanageId || null,
        started_on: startedOn || null,
        weekly_cap_hours: Number(weeklyCap),
        daily_cap_hours: Number(dailyCap),
        pab_bonus_php: Number(pabBonus),
        orphanage_share_pct: Number(sharePct),
        bank_name: bankName,
        bank_account_name: bankAccountName,
        bank_account_number: bankAccountNumber,
        swift_code: swiftCode,
        note: note.trim() || null,
      };
      if (!editing) {
        body.rate_php = Number(ratePhp);
        body.rate_effective_from = rateFrom;
      }
      const res = await fetch(editing ? `/api/orphanage-interns/${editingId}` : '/api/orphanage-interns', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { intern?: OrphanageInternRow; error?: string | null };
      if (!res.ok || json.error || !json.intern) throw new Error(json.error ?? 'Save failed');
      toast.success(editing ? `Saved ${json.intern.full_name}` : `Added ${json.intern.full_name}`);
      onSaved(json.intern);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const tabs: Array<{ id: Pane; label: string; Icon: typeof UserRound; issue: string | null; hint?: string }> = [
    { id: 'profile', label: 'Profile', Icon: UserRound, issue: showProfileIssue ? profileIssue : null },
    { id: 'pay', label: 'Pay', Icon: Wallet, issue: showPayIssue ? payIssue : null },
    { id: 'bank', label: 'Bank', Icon: Banknote, issue: null, hint: bankMissing && (touched.has('bank') || attempted || editing) ? 'No bank on file' : undefined },
  ];

  const field = 'space-y-1';
  const labelCls = 'text-[11px] font-medium text-zinc-600 dark:text-zinc-400';

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden border-pink-100/70 bg-white p-0 sm:max-h-[92dvh] sm:max-w-[40rem] dark:border-pink-950/50 dark:bg-zinc-950">
        <DialogHeader className="shrink-0 border-b border-pink-100/70 px-5 pb-0 pt-4 pr-12 text-left dark:border-pink-950/45">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-md shadow-pink-500/30">
              <GraduationCap className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">{editing ? `Edit ${composedName || 'intern'}` : 'Add intern'}</DialogTitle>
              <DialogDescription className="text-xs">
                Personal data, bank and rates change only here. No onboarding paperwork.
              </DialogDescription>
            </div>
          </div>
          <div role="tablist" aria-label="Intern profile sections" className="-mb-px mt-3 flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={pane === t.id}
                onClick={() => setPane(t.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs font-semibold transition-colors',
                  pane === t.id
                    ? 'border-pink-200 bg-white text-pink-700 dark:border-pink-900/50 dark:bg-zinc-950 dark:text-pink-300'
                    : 'border-transparent text-zinc-500 hover:text-pink-700 dark:text-zinc-400 dark:hover:text-pink-300',
                )}
              >
                <t.Icon className="h-3.5 w-3.5" />
                {t.label}
                {t.issue ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" title={t.issue} aria-label={t.issue} />
                ) : t.hint ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title={t.hint} aria-label={t.hint} />
                ) : null}
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loadingRecord ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-pink-500" />
            </div>
          ) : pane === 'profile' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className={field}>
                <Label htmlFor="in-first" className={labelCls}>First name <span className="text-rose-500">*</span></Label>
                <Input
                  id="in-first"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  onBlur={() => touch('first')}
                  placeholder="Maria"
                  autoFocus={!editing}
                  aria-invalid={showProfileIssue && !firstOk ? true : undefined}
                  className={cn(showProfileIssue && !firstOk && 'border-rose-400 focus-visible:ring-rose-400')}
                />
              </div>
              <div className={field}>
                <Label htmlFor="in-middle" className={labelCls}>Middle name</Label>
                <Input id="in-middle" value={middleName} onChange={(e) => setMiddleName(e.target.value)} placeholder="optional" />
              </div>
              <div className={field}>
                <Label htmlFor="in-last" className={labelCls}>Last name <span className="text-rose-500">*</span></Label>
                <Input
                  id="in-last"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  onBlur={() => touch('last')}
                  placeholder="Santos"
                  aria-invalid={showProfileIssue && firstOk && !lastOk ? true : undefined}
                  className={cn(showProfileIssue && firstOk && !lastOk && 'border-rose-400 focus-visible:ring-rose-400')}
                />
              </div>
              <div className={field}>
                <Label htmlFor="in-ext" className={labelCls}>Extension</Label>
                <Input id="in-ext" value={nameExtension} onChange={(e) => setNameExtension(e.target.value)} placeholder="Jr, Sr, III…" />
              </div>
              <p className="sm:col-span-2 -mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                {composedName ? (
                  <>Saved as <span className="font-semibold text-zinc-800 dark:text-zinc-200">{composedName}</span>{middleName.trim() ? <> — the middle name is kept on the profile but not in the name, like Simple hires.</> : null}</>
                ) : (
                  <>First and last name compose the name payroll prints, like Simple hires.</>
                )}
              </p>
              <div className={cn(field, 'sm:col-span-2')}>
                <Label htmlFor="in-email" className={labelCls}>Intern email <span className="text-rose-500">*</span></Label>
                <Input
                  id="in-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => touch('email')}
                  placeholder={`name@${INTERN_EMAIL_DOMAIN}`}
                  aria-invalid={showProfileIssue && nameOk && !emailOk ? true : undefined}
                  className={cn('font-mono', (email || showProfileIssue) && !emailOk && touched.has('email') && 'border-rose-400 focus-visible:ring-rose-400')}
                />
                <p className={cn('text-[11px]', (email || attempted) && !emailOk && touched.has('email') ? 'text-rose-600' : 'text-zinc-400')}>
                  Must be @{INTERN_EMAIL_DOMAIN} — never @simple.biz. This is how payroll tells an intern apart.
                </p>
              </div>
              <div className={field}>
                <Label htmlFor="in-personal" className={labelCls}>Personal email</Label>
                <Input id="in-personal" type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} placeholder="optional" className="font-mono" />
              </div>
              <div className={field}>
                <Label htmlFor="in-phone" className={labelCls}>Phone</Label>
                <Input id="in-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+63 …" className="font-mono" />
              </div>
              <div className={field}>
                <Label htmlFor="in-orph" className={labelCls}>Orphanage</Label>
                <select
                  id="in-orph"
                  value={orphanageId}
                  onChange={(e) => setOrphanageId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                >
                  <option value="">— not assigned —</option>
                  {orphanages.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
              <div className={field}>
                <Label htmlFor="in-start" className={labelCls}>Started on</Label>
                <Input id="in-start" type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
              </div>
              <div className={cn(field, 'sm:col-span-2')}>
                <Label htmlFor="in-note" className={labelCls}>Note</Label>
                <Input id="in-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
              </div>
            </div>
          ) : pane === 'pay' ? (
            <div className="flex flex-col gap-4">
              <section className="rounded-xl border border-pink-100 bg-pink-50/40 p-3.5 dark:border-pink-900/40 dark:bg-pink-950/10">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-pink-700 dark:text-pink-300">
                  {editing ? 'Rate' : 'First rate'}
                </h3>
                {editing ? (
                  <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                    Rates are dated history and never edited here. Use <span className="font-semibold">Change rate…</span> on the profile card to add a new rate from a date.
                  </p>
                ) : (
                  <>
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Weeks price with the rate in force on each day. Later changes are added with their own effective date.
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className={field}>
                        <Label htmlFor="in-rate" className={labelCls}>Hourly rate (₱) <span className="text-rose-500">*</span></Label>
                        <Input id="in-rate" type="number" min={1} step="0.01" value={ratePhp} onChange={(e) => setRatePhp(e.target.value)} onBlur={() => touch('pay')} className="font-mono" />
                      </div>
                      <div className={field}>
                        <Label htmlFor="in-rate-from" className={labelCls}>Effective from <span className="text-rose-500">*</span></Label>
                        <Input id="in-rate-from" type="date" value={rateFrom} onChange={(e) => setRateFrom(e.target.value)} onBlur={() => touch('pay')} />
                      </div>
                    </div>
                  </>
                )}
              </section>

              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">Caps, PAB and orphanage share</h3>
                <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Defaults are the agreed numbers: {INTERN_DEFAULTS.dailyCapHours}h a day, {INTERN_DEFAULTS.weeklyCapHours}h a week, {formatInternPHP(INTERN_DEFAULTS.pabBonusPhp)} PAB, {INTERN_DEFAULTS.orphanageSharePct}% to the orphanage.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" onBlur={() => touch('pay')}>
                  <div className={field}>
                    <Label htmlFor="in-daily" className={labelCls}>Daily cap (h)</Label>
                    <Input id="in-daily" type="number" min={0.25} step="0.25" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className="font-mono" />
                  </div>
                  <div className={field}>
                    <Label htmlFor="in-weekly" className={labelCls}>Weekly cap (h)</Label>
                    <Input id="in-weekly" type="number" min={0.25} step="0.25" value={weeklyCap} onChange={(e) => setWeeklyCap(e.target.value)} className="font-mono" />
                  </div>
                  <div className={field}>
                    <Label htmlFor="in-pab" className={labelCls}>PAB (₱/month)</Label>
                    <Input id="in-pab" type="number" min={0} step="1" value={pabBonus} onChange={(e) => setPabBonus(e.target.value)} className="font-mono" />
                  </div>
                  <div className={field}>
                    <Label htmlFor="in-share" className={labelCls}>Orphanage share (%)</Label>
                    <Input id="in-share" type="number" min={0} max={100} step="1" value={sharePct} onChange={(e) => setSharePct(e.target.value)} className="font-mono" />
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Payment Dispatch pays to exactly these details and cannot edit them. A wrong bank is fixed here, never at pay time.
              </p>
              <div className="grid gap-3 sm:grid-cols-2" onBlur={() => touch('bank')}>
                <div className={field}>
                  <Label htmlFor="in-bank" className={labelCls}>Bank name</Label>
                  <Input id="in-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="BDO, BPI, GCash…" />
                </div>
                <div className={field}>
                  <Label htmlFor="in-holder" className={labelCls}>Account name</Label>
                  <Input id="in-holder" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} placeholder="Name on the account" />
                </div>
                <div className={field}>
                  <Label htmlFor="in-acct" className={labelCls}>Account number</Label>
                  <Input id="in-acct" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} className="font-mono" />
                </div>
                <div className={field}>
                  <Label htmlFor="in-swift" className={labelCls}>SWIFT / code</Label>
                  <Input id="in-swift" value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} className="font-mono uppercase" placeholder="optional" />
                </div>
              </div>
              {bankMissing && (touched.has('bank') || attempted || editing) && (
                <p className="flex items-center gap-1.5 rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  No bank on file — the profile saves, but Payment Dispatch has nowhere to send the money until this is filled in.
                </p>
              )}
            </div>
          )}
        </div>

        {/* The shared footer ships `-mx-4 -mb-4` to cancel DialogContent's default
            p-4; this dialog is p-0, so those margins would hang the buttons past
            the card edge. Zero them and drop the orange/blue gradient — pink card. */}
        <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center gap-3 rounded-b-xl border-t border-pink-100/70 bg-none bg-white px-5 py-4 dark:border-pink-950/45 dark:bg-zinc-950 sm:justify-between">
          {/* Left: only speaks when there is something to fix. Silence is the default. */}
          <p
            role="status"
            aria-live="polite"
            className={cn('min-w-0 flex-1 truncate text-xs', footerIssue ? 'flex items-center gap-1.5 text-rose-600 dark:text-rose-400' : 'text-transparent')}
          >
            {footerIssue && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
            {footerIssue ?? ' '}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="h-10 px-4">
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || loadingRecord}
              aria-disabled={!valid || undefined}
              className={cn('h-10 min-w-[8.5rem] gap-2 bg-pink-600 px-5 font-semibold text-white hover:bg-pink-700', !valid && 'opacity-80')}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? 'Save changes' : 'Add intern'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
