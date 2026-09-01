'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Banknote, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import {
  EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS,
  PROCESSOR_OPTIONS,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import { READINESS_SOURCE } from '@/lib/payroll/readiness-audit';

const EDITOR_LABEL_CLS = 'text-[11px] font-medium text-zinc-500 dark:text-zinc-400';

/** The five fields the dialog reads off a person — structurally satisfied by
 *  `ReadinessMissingBank` (the Payroll Notes FAB's row type) and by the People
 *  Offboarded tab's search hits alike. */
export interface SetBankPerson {
  name: string;
  /** Display-only email for the header line. */
  email?: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  /** LIVE-resolved effective processor. Non-empty LOCKS the picker — routing
   *  changes stay in their approval flows. Never feed a snapshot value here
   *  (see `prefill.processor`). */
  processor: string | null;
}

/**
 * "Set bank" editor — writes payout details straight to the person's
 * employee_ids row via POST /api/update-employee-ids (the same route the
 * employee portal saves through, so history/audit/notifications all fire).
 *
 * Extracted verbatim from PayrollWizardNotesFab.tsx (2026-09-01) so the People
 * → Offboarded tab and the Payroll Notes Bank Info / Offboarded tabs share ONE
 * implementation. Two additive props: `source` (audit attribution, defaults to
 * the wizard's READINESS_SOURCE) and `warning` (rendered above the form — the
 * Offboarded tab's recycled-work-email caution).
 *
 * When the row already resolves an effective processor (Bank Preferred /
 * Disbursement / legacy cell), the processor is FIXED and we only collect its
 * missing details — routing changes stay in their existing approval flows (and
 * the WIRES lock stays intact). Only with NO processor at all does the picker
 * open up, writing the Disbursement channel (`preferred_processor`), never
 * `bank_preferred`.
 */
export default function SetBankDialog({
  person,
  prefill,
  source = READINESS_SOURCE,
  warning,
  onClose,
  onSaved,
}: {
  person: SetBankPerson;
  /** Seeds the form from a known-but-not-yet-saved source (e.g. an offboard
   *  snapshot) instead of starting blank. The clerk can still edit every
   *  field before saving — this only changes the initial values. */
  prefill?: {
    /** Pre-SELECTS the picker without locking it. A prefilled processor comes
     *  from a source that isn't on the live employee_ids row yet (an offboard
     *  snapshot), so `locked` must stay false — otherwise `save` skips writing
     *  `preferred_processor` and the person stays unpayable after a "successful"
     *  save. Only `person.processor` (live-resolved) locks the picker.
     *  Nullable so an `OffboardedBankPrefill` (whose `processor` is
     *  `string | null`) can be handed straight through. */
    processor?: string | null;
    walletEmail?: string;
    walletName?: string;
    bankName?: string;
    accountHolder?: string;
    accountNumber?: string;
    swiftCode?: string;
  };
  /** Audit/People-tab attribution for the write (`update-employee-ids`'s
   *  `source`). Defaults to the Payroll Wizard's readiness source. */
  source?: string;
  /** Rendered between the header and the form — e.g. the Offboarded tab's
   *  "this work email now belongs to an active employee" caution. */
  warning?: ReactNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const lockedProcessor = (person.processor ?? '') as ProcessorId | '';
  const [processor, setProcessor] = useState<string>(lockedProcessor || (prefill?.processor ?? ''));
  const [walletEmail, setWalletEmail] = useState(prefill?.walletEmail ?? '');
  const [walletName, setWalletName] = useState(prefill?.walletName ?? '');
  const [bankName, setBankName] = useState(prefill?.bankName ?? '');
  const [accountHolder, setAccountHolder] = useState(prefill?.accountHolder ?? '');
  const [accountNumber, setAccountNumber] = useState(prefill?.accountNumber ?? '');
  const [swiftCode, setSwiftCode] = useState(prefill?.swiftCode ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = lockedProcessor !== '';
  // Wise is deliberately NOT a wallet here: like wires/jeeves it's payable on
  // full wire details (isPayoutComplete), and accounting wires these people
  // when no Wise handle is on file — so the editor collects bank details.
  // That's why the picker can offer Wise with the same fields as Wires.
  const isWallet =
    processor === 'hurupay' || processor === 'wepay' || processor === 'higlobe';
  const needsWalletName = processor === 'higlobe';
  const processorLabel =
    PROCESSOR_OPTIONS.find((p) => p.id === processor)?.label ?? processor;

  const save = async () => {
    if (!person.workEmail && !person.personalEmail) {
      setError("No email on file to key this person's payout record.");
      return;
    }
    if (!processor) {
      setError('Pick the processor this person is paid through.');
      return;
    }
    const update: Record<string, string> = {};
    if (isWallet) {
      if (!walletEmail.trim()) {
        setError(`Enter the ${processorLabel} account email.`);
        return;
      }
      if (needsWalletName && !walletName.trim()) {
        setError('Enter the HiGlobe account name.');
        return;
      }
      if (processor === 'hurupay') update.hurupay_email = walletEmail.trim();
      if (processor === 'wepay') update.wepay_email = walletEmail.trim();
      if (processor === 'higlobe') {
        update.higlobe_email = walletEmail.trim();
        update.higlobe_account_name = walletName.trim();
      }
    } else {
      // wires / jeeves / wise — manual wire details. Bank + account number are
      // what isPayoutComplete requires; holder + SWIFT ride along when provided.
      if (!bankName.trim() || !accountNumber.trim()) {
        setError('Bank name and account number are required.');
        return;
      }
      update.bank_name = bankName.trim();
      update.account_number = accountNumber.trim();
      if (accountHolder.trim()) update.account_holder_name = accountHolder.trim();
      if (swiftCode.trim()) update.swift_code = swiftCode.trim();
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        bootstrap_display_name: person.name,
        // Attribute the write to the surface the clerk fixed it from — the
        // audit + People-tab source read it back.
        source,
        ...update,
      };
      if (person.workEmail) body.work_email = person.workEmail;
      else if (person.personalEmail) body.personal_email = person.personalEmail;
      // Routing: only set the Disbursement channel when the person had no
      // effective processor at all. Never writes bank_preferred.
      if (!locked) body.preferred_processor = processor;
      const res = await fetch('/api/update-employee-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Save failed (${res.status})`);
      toast.success(`Bank details saved for ${person.name}`, {
        description: `Paid via ${processorLabel}.`,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save bank details');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-orange-500" />
            Set bank details
          </DialogTitle>
          <DialogDescription>
            {person.name}
            {person.email ? ` · ${person.email}` : ''} — saves to their payout profile;
            the employee is notified.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {warning}
          <div className="grid gap-1">
            <span className={EDITOR_LABEL_CLS}>Processor</span>
            <SmoothSelect
              value={processor}
              onChange={setProcessor}
              disabled={locked}
              aria-label="Processor"
              className="w-full"
              triggerClassName="h-8"
              options={
                locked
                  ? [{ value: lockedProcessor, label: processorLabel }]
                  : [
                      { value: '', label: 'Pick a processor…' },
                      ...EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS.map((p) => ({
                        value: p.id as string,
                        label: p.label,
                      })),
                    ]
              }
            />
            {locked && (
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                Already routed via {processorLabel} — just complete the missing details
                below. Routing changes go through the usual approval flow.
              </p>
            )}
          </div>
          {isWallet ? (
            <>
              <div className="grid gap-1">
                <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-wallet-email">
                  {processorLabel} account email
                </label>
                <Input
                  id="readiness-bank-wallet-email"
                  type="email"
                  value={walletEmail}
                  onChange={(e) => setWalletEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="h-8 text-xs"
                />
              </div>
              {needsWalletName && (
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-wallet-name">
                    HiGlobe account name
                  </label>
                  <Input
                    id="readiness-bank-wallet-name"
                    value={walletName}
                    onChange={(e) => setWalletName(e.target.value)}
                    placeholder="Account holder name"
                    className="h-8 text-xs"
                  />
                </div>
              )}
            </>
          ) : processor ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-name">
                    Bank name
                  </label>
                  <Input
                    id="readiness-bank-name"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="e.g. BPI"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-holder">
                    Account holder
                  </label>
                  <Input
                    id="readiness-bank-holder"
                    value={accountHolder}
                    onChange={(e) => setAccountHolder(e.target.value)}
                    placeholder="Full name"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-account">
                    Account number
                  </label>
                  <Input
                    id="readiness-bank-account"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="Account number"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid gap-1">
                  <label className={EDITOR_LABEL_CLS} htmlFor="readiness-bank-swift">
                    SWIFT / routing
                  </label>
                  <Input
                    id="readiness-bank-swift"
                    value={swiftCode}
                    onChange={(e) => setSwiftCode(e.target.value)}
                    placeholder="Optional"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </>
          ) : null}
          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save details
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
