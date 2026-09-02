'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, GraduationCap, Loader2 } from 'lucide-react';
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
import { INTERN_DEFAULTS, type OrphanageInternRow } from '@/lib/interns/intern-types';

interface OrphanageOption { id: string; name: string }

/**
 * Add / edit an intern profile. The ONLY form that writes intern personal data
 * and bank details (Kane 2026-09-02). The email must be @pathway.ph — validated
 * here, re-checked by the route, and enforced last by the DB CHECK.
 *
 * On create the first RATE is captured too (rate + effective date) so the
 * intern can be priced from day one; later changes go through "Change rate…",
 * which appends to history and never edits it.
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
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orphanages, setOrphanages] = useState<OrphanageOption[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [personalEmail, setPersonalEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [orphanageId, setOrphanageId] = useState('');
  const [startedOn, setStartedOn] = useState('');
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
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const res = await fetch('/api/orphanages', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: OrphanageOption[]; orphanages?: OrphanageOption[] } | OrphanageOption[];
        const list = Array.isArray(json) ? json : json.rows ?? json.orphanages ?? [];
        setOrphanages(list.map((o) => ({ id: o.id, name: o.name })));
      } catch {
        setOrphanages([]);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setAdvancedOpen(false);
    if (!editingId) {
      setFullName(''); setEmail(''); setPersonalEmail(''); setPhone(''); setOrphanageId('');
      setStartedOn(new Date().toISOString().slice(0, 10));
      setRatePhp(String(INTERN_DEFAULTS.ratePhp)); setRateFrom(new Date().toISOString().slice(0, 10));
      setWeeklyCap(String(INTERN_DEFAULTS.weeklyCapHours)); setDailyCap(String(INTERN_DEFAULTS.dailyCapHours));
      setPabBonus(String(INTERN_DEFAULTS.pabBonusPhp)); setSharePct(String(INTERN_DEFAULTS.orphanageSharePct));
      setBankName(''); setBankAccountName(''); setBankAccountNumber(''); setSwiftCode(''); setNote('');
      return;
    }
    setLoadingRecord(true);
    void (async () => {
      try {
        const res = await fetch(`/api/orphanage-interns/${editingId}?_=${Date.now()}`, { cache: 'no-store' });
        const json = (await res.json()) as { intern?: OrphanageInternRow; error?: string | null };
        if (!res.ok || json.error || !json.intern) throw new Error(json.error ?? 'Could not load the profile');
        const i = json.intern;
        setFullName(i.full_name); setEmail(i.email); setPersonalEmail(i.personal_email ?? ''); setPhone(i.phone ?? '');
        setOrphanageId(i.orphanage_id ?? ''); setStartedOn(i.started_on ?? '');
        setWeeklyCap(String(i.weekly_cap_hours)); setDailyCap(String(i.daily_cap_hours));
        setPabBonus(String(i.pab_bonus_php)); setSharePct(String(i.orphanage_share_pct));
        setBankName(i.bank_name); setBankAccountName(i.bank_account_name); setBankAccountNumber(i.bank_account_number); setSwiftCode(i.swift_code);
        setNote(i.note ?? '');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not load the profile');
        onOpenChange(false);
      } finally {
        setLoadingRecord(false);
      }
    })();
  }, [open, editingId, onOpenChange]);

  const emailOk = isInternEmail(email);
  const rateOk = !editing ? Number(ratePhp) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(rateFrom) : true;
  const valid = fullName.trim().length > 0 && emailOk && rateOk;

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        full_name: fullName.trim(),
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

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto border-pink-100/70 bg-white p-0 [scrollbar-width:none] sm:max-w-[48rem] [&::-webkit-scrollbar]:hidden dark:border-pink-950/50 dark:bg-zinc-950">
        <DialogHeader className="border-b border-pink-100/70 px-6 py-5 pr-12 text-left dark:border-pink-950/45">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-md shadow-pink-500/30">
              <GraduationCap className="h-4.5 w-4.5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold">{editing ? 'Edit intern' : 'Add intern'}</DialogTitle>
              <DialogDescription className="text-xs">
                Personal data, bank details and rates change only here. No onboarding paperwork.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {loadingRecord ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-pink-500" />
          </div>
        ) : (
          <div className="flex flex-col gap-6 px-6 py-5">
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="in-name" className="text-xs">Full name <span className="text-rose-500">*</span></Label>
                <Input id="in-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Maria Santos" />
              </div>
              <div>
                <Label htmlFor="in-email" className="text-xs">Intern email <span className="text-rose-500">*</span></Label>
                <Input
                  id="in-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={`name@${INTERN_EMAIL_DOMAIN}`}
                  className={cn('font-mono', email && !emailOk && 'border-rose-400 focus-visible:ring-rose-400')}
                />
                <p className={cn('mt-1 text-[11px]', email && !emailOk ? 'text-rose-600' : 'text-zinc-400')}>
                  Must be an @{INTERN_EMAIL_DOMAIN} address — never @simple.biz. This is how payroll tells an intern apart.
                </p>
              </div>
              <div>
                <Label htmlFor="in-personal" className="text-xs">Personal email</Label>
                <Input id="in-personal" type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} placeholder="optional" className="font-mono" />
              </div>
              <div>
                <Label htmlFor="in-phone" className="text-xs">Phone</Label>
                <Input id="in-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+63 …" className="font-mono" />
              </div>
              <div>
                <Label htmlFor="in-orph" className="text-xs">Orphanage</Label>
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
              <div>
                <Label htmlFor="in-start" className="text-xs">Started on</Label>
                <Input id="in-start" type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
              </div>
            </section>

            {!editing && (
              <section className="rounded-xl border border-pink-100 bg-pink-50/40 p-4 dark:border-pink-900/40 dark:bg-pink-950/10">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-pink-700 dark:text-pink-300">First rate</h3>
                <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Weeks price with the rate in force on each day. Later changes are added with their own effective date; history is never edited.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="in-rate" className="text-xs">Hourly rate (₱) <span className="text-rose-500">*</span></Label>
                    <Input id="in-rate" type="number" min={1} step="0.01" value={ratePhp} onChange={(e) => setRatePhp(e.target.value)} className="font-mono" />
                  </div>
                  <div>
                    <Label htmlFor="in-rate-from" className="text-xs">Effective from <span className="text-rose-500">*</span></Label>
                    <Input id="in-rate-from" type="date" value={rateFrom} onChange={(e) => setRateFrom(e.target.value)} />
                  </div>
                </div>
              </section>
            )}

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Bank</h3>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                Payment Dispatch pays to exactly these details. A wrong bank is fixed here, never at pay time.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="in-bank" className="text-xs">Bank name</Label>
                  <Input id="in-bank" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="BDO, BPI, GCash…" />
                </div>
                <div>
                  <Label htmlFor="in-holder" className="text-xs">Account name</Label>
                  <Input id="in-holder" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} placeholder="Name on the account" />
                </div>
                <div>
                  <Label htmlFor="in-acct" className="text-xs">Account number</Label>
                  <Input id="in-acct" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} className="font-mono" />
                </div>
                <div>
                  <Label htmlFor="in-swift" className="text-xs">SWIFT / code</Label>
                  <Input id="in-swift" value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} className="font-mono uppercase" placeholder="optional" />
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold text-zinc-700 dark:text-zinc-300"
              >
                <span>Caps, PAB and orphanage share <span className="ml-1 font-normal text-zinc-400">— defaults: {INTERN_DEFAULTS.dailyCapHours}h/day · {INTERN_DEFAULTS.weeklyCapHours}h/week · ₱{INTERN_DEFAULTS.pabBonusPhp} PAB · {INTERN_DEFAULTS.orphanageSharePct}%</span></span>
                <ChevronDown className={cn('h-4 w-4 transition-transform', advancedOpen && 'rotate-180')} />
              </button>
              {advancedOpen && (
                <div className="grid gap-3 border-t border-zinc-200 px-4 py-4 sm:grid-cols-4 dark:border-zinc-800">
                  <div>
                    <Label htmlFor="in-daily" className="text-xs">Daily cap (h)</Label>
                    <Input id="in-daily" type="number" min={0.25} step="0.25" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className="font-mono" />
                  </div>
                  <div>
                    <Label htmlFor="in-weekly" className="text-xs">Weekly cap (h)</Label>
                    <Input id="in-weekly" type="number" min={0.25} step="0.25" value={weeklyCap} onChange={(e) => setWeeklyCap(e.target.value)} className="font-mono" />
                  </div>
                  <div>
                    <Label htmlFor="in-pab" className="text-xs">PAB (₱/month)</Label>
                    <Input id="in-pab" type="number" min={0} step="1" value={pabBonus} onChange={(e) => setPabBonus(e.target.value)} className="font-mono" />
                  </div>
                  <div>
                    <Label htmlFor="in-share" className="text-xs">Orphanage share (%)</Label>
                    <Input id="in-share" type="number" min={0} max={100} step="1" value={sharePct} onChange={(e) => setSharePct(e.target.value)} className="font-mono" />
                  </div>
                </div>
              )}
            </section>

            <div>
              <Label htmlFor="in-note" className="text-xs">Note</Label>
              <Input id="in-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
            </div>
          </div>
        )}

        <DialogFooter className="border-t border-pink-100/70 px-6 py-4 dark:border-pink-950/45">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!valid || saving || loadingRecord} className="gap-2 bg-pink-600 text-white hover:bg-pink-700">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? 'Save changes' : 'Add intern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
