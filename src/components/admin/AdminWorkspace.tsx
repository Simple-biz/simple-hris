'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, AlertCircle, Edit2, Check, RefreshCw, Cloud, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface LicenseInfo {
  available_licenses: number | null;
  total_licenses: number | null;
  assigned_licenses: number | null;
  source: 'google' | 'manual';
  last_updated: string | null;
  google_error?: string;
  note?: string;
}

export default function AdminWorkspace() {
  const [info, setInfo] = useState<LicenseInfo | null>(null);
  const [total, setTotal] = useState('');
  const [available, setAvailable] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const r = await fetch('/api/hr/workspace-license-info', { cache: 'no-store' });
      const data = (await r.json()) as LicenseInfo;
      setInfo(data);
      if (data.total_licenses !== null) setTotal(String(data.total_licenses));
      if (data.available_licenses !== null) setAvailable(String(data.available_licenses));
      setEditing(false);
    } catch {
      toast.error('Could not load license info');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = info?.source === 'google';

  const handleSave = async () => {
    const totalNum = parseInt(total, 10);
    if (!total || isNaN(totalNum) || totalNum < 0) {
      toast.error('Enter a valid total license count');
      return;
    }

    // Manual available is only used as a fallback when the live API is off.
    const body: { total_licenses: number; available_licenses?: number } = {
      total_licenses: totalNum,
    };
    if (!isLive && available) {
      const availNum = parseInt(available, 10);
      if (isNaN(availNum) || availNum < 0) {
        toast.error('Enter a valid available license count');
        return;
      }
      body.available_licenses = availNum;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/admin/workspace-license-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok || result.error) {
        throw new Error(result.error || 'Failed to save');
      }
      toast.success('License info updated');
      await load({ quiet: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save license info');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  const total_n = info?.total_licenses ?? null;
  const assigned_n = info?.assigned_licenses ?? null;
  const available_n = info?.available_licenses ?? null;
  const configured = total_n !== null;

  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Google Workspace</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Configure Google Workspace settings and license availability
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              License Availability
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => load({ quiet: true })}
              disabled={refreshing}
              className="h-8 gap-1.5 text-xs"
            >
              <RefreshCw className={'h-3.5 w-3.5' + (refreshing ? ' animate-spin' : '')} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Source badge */}
          <div
            className={
              'flex items-center gap-2 rounded-lg border p-3 text-sm ' +
              (isLive
                ? 'border-emerald-200/60 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-100'
                : 'border-zinc-200 bg-zinc-50/60 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-300')
            }
          >
            {isLive ? <Cloud className="h-4 w-4 shrink-0" /> : <PenLine className="h-4 w-4 shrink-0" />}
            <span>
              {isLive ? (
                <>
                  <strong>Assigned count is live</strong> from Google Workspace. Just set your{' '}
                  <strong>total purchased seats</strong> below.
                </>
              ) : (
                <>
                  <strong>Manual mode.</strong> Auto-count isn&apos;t configured, so enter both
                  numbers. (Set up the Licensing API to count assigned seats automatically.)
                </>
              )}
            </span>
          </div>

          {info?.google_error && (
            <div className="rounded-lg border border-amber-200/60 bg-amber-50/60 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-100">
              <strong>Live count failed, showing manual numbers:</strong> {info.google_error}
            </div>
          )}

          {!editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 sm:gap-4 dark:border-zinc-800 dark:bg-zinc-900/30">
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Available</p>
                  <p className="mt-1 text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                    {available_n ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Assigned {isLive && <span className="text-emerald-600">(live)</span>}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                    {assigned_n ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Total</p>
                  <p className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                    {total_n ?? '—'}
                  </p>
                </div>
              </div>

              {configured && total_n! > 0 && assigned_n !== null && (
                <div className="rounded-lg border border-emerald-200/60 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                  <p className="text-sm text-emerald-900 dark:text-emerald-100">
                    <strong>{assigned_n} assigned</strong> of {total_n} total
                  </p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-emerald-200 dark:bg-emerald-900/40">
                    <div
                      className="h-full bg-emerald-600 dark:bg-emerald-500"
                      style={{ width: Math.min(100, (assigned_n / total_n!) * 100) + '%' }}
                    />
                  </div>
                </div>
              )}

              {info?.last_updated && (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  Total last set: {new Date(info.last_updated).toLocaleString()}
                </p>
              )}

              <Button onClick={() => setEditing(true)} className="w-full" variant="outline">
                <Edit2 className="mr-2 h-4 w-4" />
                {configured ? 'Edit License Info' : 'Set License Info'}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className={'grid gap-4 ' + (isLive ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2')}>
                <div className="space-y-2">
                  <Label htmlFor="total" className="text-sm font-medium">
                    Total Licenses (purchased)
                  </Label>
                  <Input
                    id="total"
                    type="number"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    placeholder="e.g., 992"
                    min="0"
                    className="text-lg"
                  />
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    From Admin Console &gt; Billing &gt; Subscriptions. Google doesn&apos;t expose
                    this via API.
                  </p>
                </div>
                {!isLive && (
                  <div className="space-y-2">
                    <Label htmlFor="available" className="text-sm font-medium">
                      Available (manual)
                    </Label>
                    <Input
                      id="available"
                      type="number"
                      value={available}
                      onChange={(e) => setAvailable(e.target.value)}
                      placeholder="e.g., 77"
                      min="0"
                      className="text-lg"
                    />
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Unassigned seats ready to give new hires.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button onClick={() => load({ quiet: true })} variant="outline" className="flex-1">
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 bg-gradient-to-r from-emerald-500 to-teal-700 text-white hover:opacity-90"
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      Save Changes
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enable live assigned-license count</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Enable the <strong>Enterprise License Manager API</strong> in your Google Cloud project.</li>
            <li>
              In <strong>Admin Console &gt; Security &gt; API Controls &gt; Domain-wide Delegation</strong>,
              authorize the service account client ID for scope{' '}
              <code className="break-all rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                https://www.googleapis.com/auth/apps.licensing
              </code>
              .
            </li>
            <li>
              Set <code className="break-all rounded bg-zinc-100 px-1 dark:bg-zinc-800">GOOGLE_WORKSPACE_ADMIN_EMAIL</code>{' '}
              (a super-admin to impersonate) in the server env, then redeploy.
            </li>
            <li>Hit <strong>Refresh</strong> above — Assigned should switch to a live count.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
