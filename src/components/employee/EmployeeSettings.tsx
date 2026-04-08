'use client';

import React, { useEffect, useState } from 'react';
import { Save, Loader2, Mail, Building2, CreditCard, CheckCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { normEmail } from '@/lib/email/norm-email';

interface BankDetails {
  accountName: string;
  accountNumber: string;
  bankName: string;
  routingNumber: string;
}

const emptyBank: BankDetails = { accountName: '', accountNumber: '', bankName: '', routingNumber: '' };

interface EmployeeSettingsProps {
  employeeEmail: string;
}

/** Read a string from a raw Supabase row, trying multiple column name variants. */
function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

export default function EmployeeSettings({ employeeEmail }: EmployeeSettingsProps) {
  const email = normEmail(employeeEmail) ?? employeeEmail.toLowerCase();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [personalEmail, setPersonalEmail] = useState('');
  const [bank, setBank] = useState<BankDetails>({ ...emptyBank });
  const [altBank, setAltBank] = useState<BankDetails>({ ...emptyBank });
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  // Load from employee_ids table via /api/employee-ids
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employee-ids', { cache: 'no-store' });
        const json = (await res.json()) as { rows: Array<Record<string, unknown>> };
        if (cancelled) return;

        const rows = json.rows ?? [];
        const me = rows.find((r) => {
          const we = normEmail(String(r.work_email ?? ''));
          const pe = normEmail(String(r.personal_email ?? ''));
          return we === email || pe === email;
        });

        if (me) {
          setPersonalEmail(pick(me, 'personal_email'));
          setBank({
            bankName: pick(me, 'bank_name'),
            accountName: pick(me, 'account_holder_name'),
            accountNumber: pick(me, 'account_number'),
            routingNumber: pick(me, 'routing_number'),
          });
          setAltBank({
            bankName: pick(me, 'alt_bank_name'),
            accountName: pick(me, 'alt_account_holder_name'),
            accountNumber: pick(me, 'alt_account_number'),
            routingNumber: pick(me, 'alt_routing_number'),
          });
        }
      } catch {
        // degrade gracefully
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [email]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/update-employee-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: email,
          personal_email: personalEmail || undefined,
          bank_name: bank.bankName,
          account_holder_name: bank.accountName,
          account_number: bank.accountNumber,
          routing_number: bank.routingNumber,
          alt_bank_name: altBank.bankName,
          alt_account_holder_name: altBank.accountName,
          alt_account_number: altBank.accountNumber,
          alt_routing_number: altBank.routingNumber,
        }),
      });
      const json = (await res.json()) as { error?: string | null; success?: boolean };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      setLastSaved(new Date().toLocaleTimeString());
      toast.success('Settings saved to database');
    } catch (err: unknown) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-full bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full space-y-8 overflow-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-8 dark:bg-none dark:bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">Settings</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">
            Update your personal information and bank details
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSaved && (
            <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-3 w-3" />
              Saved at {lastSaved}
            </span>
          )}
          <Button
            onClick={handleSave}
            disabled={saving}
            className="gap-2 bg-orange-500 text-white hover:bg-orange-600 dark:bg-orange-600 dark:hover:bg-orange-500"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Changes
          </Button>
        </div>
      </div>

      {/* Personal Email */}
      <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
            <Mail className="h-4 w-4 text-blue-500" />
          </div>
          <div>
            <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">Personal Email</CardTitle>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Used as an alternative contact and for email matching
            </p>
          </div>
          <Badge variant="outline" className="ml-auto border-blue-500/20 bg-blue-500/10 text-[10px] text-blue-700 dark:border-blue-500/30 dark:text-blue-400">
            Work: {email}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="max-w-md">
            <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Personal Email Address
            </label>
            <Input
              type="email"
              placeholder="your.personal@gmail.com"
              value={personalEmail}
              onChange={(e) => setPersonalEmail(e.target.value)}
              className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
            />
          </div>
        </CardContent>
      </Card>

      {/* Primary Bank Information */}
      <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
            <Building2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div>
            <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">Primary Bank Account</CardTitle>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Your main bank account for salary deposits
            </p>
          </div>
          {bank.bankName && (
            <Badge variant="outline" className="ml-auto border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
              Primary
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Account Holder Name
              </label>
              <Input
                placeholder="Juan Dela Cruz"
                value={bank.accountName}
                onChange={(e) => setBank((b) => ({ ...b, accountName: e.target.value }))}
                className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Bank Name
              </label>
              <Input
                placeholder="BDO, BPI, GCash, etc."
                value={bank.bankName}
                onChange={(e) => setBank((b) => ({ ...b, bankName: e.target.value }))}
                className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Account Number
              </label>
              <Input
                placeholder="1234-5678-9012"
                value={bank.accountNumber}
                onChange={(e) => setBank((b) => ({ ...b, accountNumber: e.target.value }))}
                className="border-zinc-200 bg-white font-mono dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Routing Number <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
              </label>
              <Input
                placeholder="Optional"
                value={bank.routingNumber}
                onChange={(e) => setBank((b) => ({ ...b, routingNumber: e.target.value }))}
                className="border-zinc-200 bg-white font-mono dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Alternative Bank Information */}
      <Card className="border-orange-100/80 bg-gradient-to-br from-white to-orange-50/30 shadow-sm dark:border-blue-950/60 dark:bg-none dark:from-blue-950/20 dark:to-blue-950/10">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10">
            <CreditCard className="h-4 w-4 text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-sm font-medium text-zinc-900 dark:text-white">Alternative Bank Account</CardTitle>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Backup account for split payments or alternate deposits
            </p>
          </div>
          {altBank.bankName && (
            <Badge variant="outline" className="ml-auto border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-700 dark:border-amber-500/30 dark:text-amber-400">
              Secondary
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Account Holder Name
              </label>
              <Input
                placeholder="Juan Dela Cruz"
                value={altBank.accountName}
                onChange={(e) => setAltBank((b) => ({ ...b, accountName: e.target.value }))}
                className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Bank Name
              </label>
              <Input
                placeholder="BDO, BPI, GCash, etc."
                value={altBank.bankName}
                onChange={(e) => setAltBank((b) => ({ ...b, bankName: e.target.value }))}
                className="border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Account Number
              </label>
              <Input
                placeholder="1234-5678-9012"
                value={altBank.accountNumber}
                onChange={(e) => setAltBank((b) => ({ ...b, accountNumber: e.target.value }))}
                className="border-zinc-200 bg-white font-mono dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Routing Number <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
              </label>
              <Input
                placeholder="Optional"
                value={altBank.routingNumber}
                onChange={(e) => setAltBank((b) => ({ ...b, routingNumber: e.target.value }))}
                className="border-zinc-200 bg-white font-mono dark:border-zinc-800 dark:bg-zinc-900/60"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bottom save bar */}
      <div className="flex items-center justify-end gap-3 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        {lastSaved && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-3 w-3" />
            Last saved at {lastSaved}
          </span>
        )}
        <Button
          onClick={handleSave}
          disabled={saving}
          className="gap-2 bg-orange-500 text-white hover:bg-orange-600 dark:bg-orange-600 dark:hover:bg-orange-500"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Changes
        </Button>
      </div>
    </div>
  );
}
