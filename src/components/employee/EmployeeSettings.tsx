'use client';

import React, { useEffect, useState } from 'react';
import { Save, Loader2, Mail, CheckCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { normEmail } from '@/lib/email/norm-email';

interface EmployeeSettingsProps {
  employeeEmail: string;
}

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
  const [lastSaved, setLastSaved] = useState<string | null>(null);

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
        }
      } catch {
        // degrade gracefully
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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
        }),
      });
      const json = (await res.json()) as { error?: string | null; success?: boolean };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Save failed');
      setLastSaved(new Date().toLocaleTimeString());
      toast.success('Settings saved');
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">Settings</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-500">
            Update your personal email. Payment method and payout details are on your Profile tab.
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
    </div>
  );
}
