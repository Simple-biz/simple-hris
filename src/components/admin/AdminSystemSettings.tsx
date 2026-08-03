'use client';

import { useCallback, useEffect, useState } from 'react';
import { Users, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  COLLAB_ACCOUNTING_ENABLED_KEY,
  COLLAB_HR_ENABLED_KEY,
  parseCollabEnabled,
} from '@/lib/collab/collab-settings';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

async function fetchSetting(key: string): Promise<string | null> {
  const res = await fetch(`/api/app-settings?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
  const json = (await res.json()) as { value: string | null };
  return json.value;
}

async function saveSetting(key: string, value: string): Promise<void> {
  const res = await fetch('/api/app-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  const json = (await res.json()) as { error: string | null };
  if (json.error) throw new Error(json.error);
}

async function postAuditLog(
  entry: { action: string; resource_id: string; details: Record<string, unknown> },
  actorEmail?: string | null,
): Promise<void> {
  await fetch('/api/audit-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_name: actorEmail ?? 'anonymous',
      user_role: 'admin',
      resource: 'app_settings',
      ...entry,
    }),
  }).catch(() => { /* non-fatal */ });
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-md transition duration-200 ease-in-out',
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

interface CollabRowProps {
  label: string;
  description: string;
  settingKey: string;
  enabled: boolean;
  saveState: SaveState;
  onToggle: (v: boolean) => void;
}

function CollabRow({ label, description, enabled, saveState, onToggle }: CollabRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-zinc-100 bg-zinc-50/70 px-4 py-3.5 dark:border-zinc-800/70 dark:bg-zinc-900/40">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{label}</span>
          <span className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-bold',
            enabled
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
              : 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400',
          )}>
            {enabled ? 'ON' : 'OFF'}
          </span>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2.5 pt-0.5">
        {saveState === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
        {saveState === 'saved' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
        {saveState === 'error' && <AlertTriangle className="h-3.5 w-3.5 text-red-400" />}
        <Toggle checked={enabled} onChange={onToggle} disabled={saveState === 'saving'} />
      </div>
    </div>
  );
}

export default function AdminSystemSettings({ viewerEmail }: { viewerEmail?: string | null }) {
  const [accountingEnabled, setAccountingEnabled] = useState(true);
  const [hrEnabled, setHrEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [acctVal, hrVal] = await Promise.all([
        fetchSetting(COLLAB_ACCOUNTING_ENABLED_KEY).catch(() => null),
        fetchSetting(COLLAB_HR_ENABLED_KEY).catch(() => null),
      ]);
      if (cancelled) return;
      setAccountingEnabled(parseCollabEnabled(acctVal));
      setHrEnabled(parseCollabEnabled(hrVal));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleCollab = useCallback(async (
    key: string,
    value: boolean,
    label: string,
    setter: (v: boolean) => void,
  ) => {
    setter(value);
    setSaveStates((p) => ({ ...p, [key]: 'saving' }));
    try {
      await saveSetting(key, String(value));
      void postAuditLog({
        action: 'settings.collab.toggle',
        resource_id: key,
        details: { dashboard: label, enabled: value },
      }, viewerEmail);
      setSaveStates((p) => ({ ...p, [key]: 'saved' }));
      toast.success(`${label} live collaboration ${value ? 'enabled' : 'disabled'}`, { description: 'Saved.' });
      setTimeout(() => setSaveStates((p) => ({ ...p, [key]: 'idle' })), 2000);
    } catch (e) {
      setter(!value);
      setSaveStates((p) => ({ ...p, [key]: 'error' }));
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setSaveStates((p) => ({ ...p, [key]: 'idle' })), 3000);
    }
  }, [viewerEmail]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">System settings</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Payroll rules (overtime, holidays) live in the main HRIS Settings tab. Governance switches that
          affect infrastructure usage across the whole platform live here.
        </p>
      </header>

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <div className="flex items-start gap-3 border-b border-zinc-100 p-5 dark:border-zinc-800/80">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400">
            <Users className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Live Collaboration</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Presence avatar rail, live cursors, ping, and screen-observe on the Accounting and HR dashboards
              — all run over Supabase Realtime. Turning a switch off stops that dashboard&apos;s collaboration
              layer entirely (no channel opens at all), cutting Realtime message volume for everyone on it.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 p-5">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading collaboration settings…
            </div>
          ) : (
            <>
              <CollabRow
                label="Accounting dashboard"
                description="Avatar rail, live cursors, ping, and Observe for everyone on Accounting."
                settingKey={COLLAB_ACCOUNTING_ENABLED_KEY}
                enabled={accountingEnabled}
                saveState={saveStates[COLLAB_ACCOUNTING_ENABLED_KEY] ?? 'idle'}
                onToggle={(v) => void toggleCollab(COLLAB_ACCOUNTING_ENABLED_KEY, v, 'Accounting', setAccountingEnabled)}
              />
              <CollabRow
                label="HR dashboard"
                description="Avatar rail, live cursors, ping, and Observe for everyone on HR."
                settingKey={COLLAB_HR_ENABLED_KEY}
                enabled={hrEnabled}
                saveState={saveStates[COLLAB_HR_ENABLED_KEY] ?? 'idle'}
                onToggle={(v) => void toggleCollab(COLLAB_HR_ENABLED_KEY, v, 'HR', setHrEnabled)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
