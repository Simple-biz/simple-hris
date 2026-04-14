"use client";

import { useEffect, useState, useCallback } from 'react';
import {
  Settings,
  Clock,
  Laptop,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Lock,
  Users,
  ToggleRight,
  ShieldAlert,
  Activity,
  ClipboardList,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import AuditLogPanel from '@/components/audit/AuditLogPanel';

// ─── Current user (hardcoded until RBAC is implemented) ───────────────────────

const CURRENT_USER = { name: 'Fran M', role: 'Senior Admin' };

// ─── Types ────────────────────────────────────────────────────────────────────

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type RightTab  = 'ot' | 'audit';

// ─── Custom Toggle ────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled = false,
  colorOn = 'emerald',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  colorOn?: 'emerald' | 'red' | 'orange';
}) {
  const trackOn =
    colorOn === 'red'    ? 'bg-red-500'
    : colorOn === 'orange' ? 'bg-orange-500'
    : 'bg-emerald-500';

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
        checked ? trackOn : 'bg-zinc-300 dark:bg-zinc-600',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-[18px] w-[18px] transform rounded-full shadow-md transition duration-200 ease-in-out',
          'bg-white',
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

// ─── Departments ──────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  { key: 'accounting',       name: 'Accounting' },
  { key: 'edit',             name: 'Edit' },
  { key: 'devs',             name: 'Devs' },
  { key: 'lead_gen',         name: 'Lead Gen' },
  { key: 'callback',         name: 'Callback' },
  { key: 'qc',               name: 'QC' },
  { key: 'discovery',        name: 'Discovery' },
  { key: 'hr',               name: 'HR' },
  { key: 'sales_assistant',  name: 'Sales Assistant' },
  { key: 'smart_staff',      name: 'Smart Staff' },
  { key: 'us_manager_bonus', name: 'US Manager Bonus' },
  { key: 'hogan_smith_law',  name: 'Hogan Smith Law' },
] as const;

// ─── Payroll Rules ────────────────────────────────────────────────────────────

const RULES = [
  { key: 'tech_bonus_enabled', label: 'Technology Bonus',  description: '₱1,850 per employee per cycle',  icon: Laptop,       color: 'violet',  defaultEnabled: true },
  { key: 'pab_auto_compute',   label: 'PAB Auto-Compute',  description: 'Auto-evaluate attendance bonus', icon: CheckCircle2, color: 'emerald', defaultEnabled: true },
] as const;

const RULE_COLORS: Record<string, { activeBorder: string; activeBg: string }> = {
  violet:  { activeBorder: 'border-violet-200 dark:border-violet-800/50',   activeBg: 'bg-violet-50/60 dark:bg-violet-950/10' },
  emerald: { activeBorder: 'border-emerald-200 dark:border-emerald-800/50', activeBg: 'bg-emerald-50/60 dark:bg-emerald-950/10' },
};

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchSetting(key: string): Promise<string | null> {
  const res = await fetch(`/api/app-settings?key=${encodeURIComponent(key)}`);
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

async function postAuditLog(entry: {
  action: string;
  resource: string;
  resource_id?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await fetch('/api/audit-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_name: CURRENT_USER.name,
      user_role: CURRENT_USER.role,
      ...entry,
    }),
  });
}

// ─── Rule Row ─────────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  enabled,
  saveState,
  onToggle,
}: {
  rule: (typeof RULES)[number];
  enabled: boolean;
  saveState: SaveState;
  onToggle: (key: string, val: boolean) => void;
}) {
  const c = RULE_COLORS[rule.color];

  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all duration-200',
      enabled
        ? `${c.activeBorder} ${c.activeBg} shadow-sm`
        : 'border-zinc-200 bg-white dark:border-zinc-700/60 dark:bg-zinc-800/40',
    )}>
      <rule.icon className={cn('h-3.5 w-3.5 flex-shrink-0', enabled ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400 dark:text-zinc-500')} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-xs font-semibold', enabled ? 'text-zinc-900 dark:text-white' : 'text-zinc-500 dark:text-zinc-400')}>{rule.label}</p>
        <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{rule.description}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {saveState === 'saving' && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />}
        {saveState === 'saved'  && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
        {saveState === 'error'  && <AlertTriangle className="h-3 w-3 text-red-400" />}
        <Toggle checked={enabled} onChange={(v) => onToggle(rule.key, v)} disabled={saveState === 'saving'} />
      </div>
    </div>
  );
}

// ─── Dept OT Row ──────────────────────────────────────────────────────────────

function DeptOtRow({
  dept,
  enabled,
  globalSuspended,
  saveState,
  onToggle,
}: {
  dept: (typeof DEPARTMENTS)[number];
  enabled: boolean;
  globalSuspended: boolean;
  saveState: SaveState;
  onToggle: (key: string, val: boolean) => void;
}) {
  const overridden = globalSuspended;
  const on = !overridden && enabled;

  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-all duration-200',
      overridden
        ? 'border-zinc-200/60 bg-zinc-50/40 opacity-50 dark:border-zinc-700/30 dark:bg-zinc-800/20'
        : on
          ? 'border-emerald-200 bg-emerald-50/50 shadow-sm dark:border-emerald-800/50 dark:bg-emerald-950/15'
          : 'border-red-200 bg-red-50/40 dark:border-red-800/40 dark:bg-red-950/10',
    )}>
      <span className={cn(
        'h-2 w-2 flex-shrink-0 rounded-full',
        overridden ? 'bg-zinc-300 dark:bg-zinc-600' : on ? 'bg-emerald-500' : 'bg-red-400',
      )} />
      <span className={cn(
        'flex-1 text-sm font-medium',
        overridden ? 'text-zinc-400 dark:text-zinc-500'
          : on ? 'text-zinc-800 dark:text-zinc-100'
          : 'text-zinc-600 dark:text-zinc-400',
      )}>
        {dept.name}
      </span>
      <span className={cn(
        'text-[10px] font-semibold',
        overridden ? 'text-zinc-400 dark:text-zinc-500'
          : on ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-red-500 dark:text-red-400',
      )}>
        {overridden ? 'Global off' : on ? 'OT on' : 'OT off'}
      </span>
      <div className="w-4 flex-shrink-0 flex items-center justify-center">
        {saveState === 'saving' && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />}
        {saveState === 'saved'  && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
        {saveState === 'error'  && <AlertTriangle className="h-3 w-3 text-red-400" />}
      </div>
      <Toggle
        checked={on}
        onChange={(v) => onToggle(`ot_dept_${dept.key}`, v)}
        disabled={saveState === 'saving' || overridden}
        colorOn="emerald"
      />
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SystemSettings() {
  const [rules, setRules] = useState<Record<string, boolean>>(
    Object.fromEntries(RULES.map((r) => [r.key, r.defaultEnabled])),
  );
  const [deptOt, setDeptOt] = useState<Record<string, boolean>>(
    Object.fromEntries(DEPARTMENTS.map((d) => [`ot_dept_${d.key}`, true])),
  );
  const [globalOtSuspended, setGlobalOtSuspended] = useState(false);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  // ── Right panel tab ──
  const [rightTab, setRightTab] = useState<RightTab>('ot');

  // ── Load settings ──
  useEffect(() => {
    const load = async () => {
      const ruleResults = await Promise.all(
        RULES.map(async (r) => {
          const val = await fetchSetting(r.key).catch(() => null);
          return [r.key, val === null ? r.defaultEnabled : val === 'true'] as const;
        }),
      );
      setRules(Object.fromEntries(ruleResults));

      const gval = await fetchSetting('ot_global_suspended').catch(() => null);
      setGlobalOtSuspended(gval === 'true');

      const deptResults = await Promise.all(
        DEPARTMENTS.map(async (d) => {
          const key = `ot_dept_${d.key}`;
          const val = await fetchSetting(key).catch(() => null);
          return [key, val === null ? true : val === 'true'] as const;
        }),
      );
      setDeptOt(Object.fromEntries(deptResults));
    };
    load();
  }, []);

  // ── Persist helper (saves setting + writes audit log) ──
  const persist = useCallback(async (
    key: string,
    value: boolean,
    label: string,
    setter: (fn: (p: Record<string, boolean>) => Record<string, boolean>) => void,
    auditEntry: { action: string; resource_id?: string; details: Record<string, unknown> },
  ) => {
    setter((p) => ({ ...p, [key]: value }));
    setSaveStates((p) => ({ ...p, [key]: 'saving' }));
    try {
      await saveSetting(key, String(value));
      // Fire-and-forget audit log (non-blocking)
      void postAuditLog({
        action:      auditEntry.action,
        resource:    'app_settings',
        resource_id: auditEntry.resource_id ?? key,
        details:     auditEntry.details,
      });
      setSaveStates((p) => ({ ...p, [key]: 'saved' }));
      toast.success(`${label} ${value ? 'enabled' : 'disabled'}`, { description: 'Saved.' });
      setTimeout(() => setSaveStates((p) => ({ ...p, [key]: 'idle' })), 2000);
    } catch (e) {
      setter((p) => ({ ...p, [key]: !value }));
      setSaveStates((p) => ({ ...p, [key]: 'error' }));
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setSaveStates((p) => ({ ...p, [key]: 'idle' })), 3000);
    }
  }, []);

  const handleRuleToggle = useCallback((key: string, val: boolean) => {
    const rule = RULES.find((r) => r.key === key);
    persist(key, val, rule?.label ?? key, setRules, {
      action:      'settings.rule.toggle',
      resource_id: key,
      details:     { setting: rule?.label ?? key, value: val },
    });
  }, [persist]);

  const handleGlobalOt = useCallback(async (val: boolean) => {
    setGlobalOtSuspended(val);
    setSaveStates((p) => ({ ...p, ot_global_suspended: 'saving' }));
    try {
      await saveSetting('ot_global_suspended', String(val));
      void postAuditLog({
        action:      'settings.ot.global',
        resource:    'app_settings',
        resource_id: 'ot_global_suspended',
        details:     { suspended: val },
      });
      setSaveStates((p) => ({ ...p, ot_global_suspended: 'saved' }));
      toast.success(val ? 'All overtime suspended' : 'Global OT suspension lifted', { description: 'Saved.' });
      setTimeout(() => setSaveStates((p) => ({ ...p, ot_global_suspended: 'idle' })), 2000);
    } catch (e) {
      setGlobalOtSuspended(!val);
      setSaveStates((p) => ({ ...p, ot_global_suspended: 'error' }));
      toast.error('Save failed', { description: e instanceof Error ? e.message : 'Unknown error' });
      setTimeout(() => setSaveStates((p) => ({ ...p, ot_global_suspended: 'idle' })), 3000);
    }
  }, []);

  const handleDeptOt = useCallback((key: string, val: boolean) => {
    const dKey = key.replace('ot_dept_', '');
    const dept = DEPARTMENTS.find((d) => d.key === dKey);
    persist(key, val, `${dept?.name ?? dKey} OT`, setDeptOt, {
      action:      'settings.ot.department',
      resource_id: key,
      details:     { department: dept?.name ?? dKey, enabled: val },
    });
  }, [persist]);

  const activeRules = Object.values(rules).filter(Boolean).length;
  const otOffCount  = DEPARTMENTS.filter((d) => deptOt[`ot_dept_${d.key}`] === false).length;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white dark:bg-[#0d1117]">

      {/* ── Header ── */}
      <div className="relative flex-shrink-0 overflow-hidden border-b border-zinc-200 bg-gradient-to-r from-white via-zinc-50/80 to-orange-50/20 px-6 py-4 dark:border-zinc-800 dark:from-[#0d1117] dark:via-[#0f1729]/80 dark:to-[#0d1117]">
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-orange-500/5 blur-2xl dark:bg-blue-500/5" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 shadow-md shadow-orange-500/25 dark:from-blue-600 dark:to-blue-700 dark:shadow-blue-500/20">
              <Settings className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-zinc-900 dark:text-white">System Settings</h1>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">Payroll rules, overtime controls & access</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 dark:border-violet-800/50 dark:bg-violet-950/20">
              <ToggleRight className="h-3 w-3 text-violet-500" />
              <span className="text-[10px] font-semibold text-violet-700 dark:text-violet-400">{activeRules} rules active</span>
            </div>
            {globalOtSuspended && (
              <div className="flex items-center gap-1.5 rounded-full border border-red-300 bg-red-100 px-2.5 py-1 dark:border-red-800 dark:bg-red-950/40">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                <span className="text-[10px] font-bold text-red-700 dark:text-red-400">OT GLOBALLY SUSPENDED</span>
              </div>
            )}
            {!globalOtSuspended && otOffCount > 0 && (
              <div className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 dark:border-red-800/50 dark:bg-red-950/20">
                <Clock className="h-3 w-3 text-red-400" />
                <span className="text-[10px] font-semibold text-red-600 dark:text-red-400">{otOffCount} dept{otOffCount > 1 ? 's' : ''} OT off</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* LEFT — Payroll Rules + Access Control + System Info */}
        <div className="flex w-72 flex-shrink-0 flex-col overflow-y-auto border-r border-zinc-200 dark:border-zinc-800">

          {/* Payroll Rules */}
          <div className="border-b border-zinc-100 p-4 dark:border-zinc-800">
            <div className="mb-2.5 flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-orange-500" />
              <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">Payroll Rules</span>
            </div>
            <div className="space-y-1.5">
              {RULES.map((rule) => (
                <RuleRow
                  key={rule.key}
                  rule={rule}
                  enabled={rules[rule.key] ?? rule.defaultEnabled}
                  saveState={saveStates[rule.key] ?? 'idle'}
                  onToggle={handleRuleToggle}
                />
              ))}
            </div>
          </div>

          {/* Access Control */}
          <div className="border-b border-zinc-100 p-4 dark:border-zinc-800">
            <div className="mb-2.5 flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-blue-500" />
              <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">Access Control</span>
              <Badge variant="outline" className="ml-auto h-4 border-zinc-200 px-1.5 text-[9px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">Soon</Badge>
            </div>
            <div className="space-y-1.5">
              {/* Audit Log — clickable, switches to audit tab */}
              <button
                type="button"
                onClick={() => setRightTab('audit')}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                  rightTab === 'audit'
                    ? 'border-indigo-200 bg-indigo-50/60 dark:border-indigo-800/50 dark:bg-indigo-950/20'
                    : 'border-zinc-200 bg-zinc-50/60 hover:border-indigo-200 hover:bg-indigo-50/30 dark:border-zinc-700 dark:bg-zinc-800/20 dark:hover:border-indigo-800/40',
                )}
              >
                <ClipboardList className={cn('mt-0.5 h-3 w-3 flex-shrink-0', rightTab === 'audit' ? 'text-indigo-500' : 'text-zinc-400')} />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-[11px] font-medium', rightTab === 'audit' ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-600 dark:text-zinc-400')}>Audit Log</p>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-600">Activity history with actor & timestamp</p>
                </div>
                <ChevronRight className={cn('mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-300 dark:text-zinc-600', rightTab === 'audit' && 'text-indigo-400')} />
              </button>

              {/* Placeholder items */}
              {[
                { label: 'Role Management',  desc: 'Admin, Payroll Mgr, HR, Finance, Viewer' },
                { label: 'Session Policies', desc: 'Timeout, 2FA and password policies' },
              ].map((item) => (
                <div key={item.label} className="flex items-start gap-2 rounded-md border border-dashed border-zinc-200 bg-zinc-50/60 px-2.5 py-2 opacity-50 dark:border-zinc-700 dark:bg-zinc-800/20">
                  <Lock className="mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-400" />
                  <div>
                    <p className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{item.label}</p>
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-600">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* System Info */}
          <div className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-zinc-400" />
              <span className="text-xs font-bold text-zinc-500">System Info</span>
            </div>
            <div className="space-y-1">
              {[
                { label: 'Store', value: 'Supabase · app_settings', mono: true  },
                { label: 'Auth',  value: 'Not implemented',          warn: true  },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400">{row.label}</span>
                  <span className={cn('text-[10px]', row.mono ? 'font-mono text-zinc-500 dark:text-zinc-400' : 'font-medium', row.warn && 'text-amber-500')}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT — Tab panel */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

          {/* ── OT tab ── */}
          {rightTab === 'ot' && (
            <>
              {/* Section header + global switch */}
              <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-50 dark:bg-red-950/30">
                    <Clock className="h-3.5 w-3.5 text-red-500" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-zinc-900 dark:text-white">Overtime Pay per Department</p>
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500">Toggle whether OT hours count in each department's payroll</p>
                  </div>
                </div>

                {/* Global suspend */}
                <div className={cn(
                  'flex items-center gap-3 rounded-xl border px-3 py-2 transition-all duration-200',
                  globalOtSuspended
                    ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/30'
                    : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/40',
                )}>
                  <div>
                    <p className={cn('text-[11px] font-bold', globalOtSuspended ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-300')}>
                      Suspend All OT
                    </p>
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-500">Overrides all dept switches</p>
                  </div>
                  {saveStates['ot_global_suspended'] === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
                  {saveStates['ot_global_suspended'] === 'saved'  && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                  <Toggle
                    checked={globalOtSuspended}
                    onChange={handleGlobalOt}
                    disabled={saveStates['ot_global_suspended'] === 'saving'}
                    colorOn="red"
                  />
                </div>
              </div>

              {/* Department rows */}
              <div className="flex-1 overflow-y-auto px-5 py-3">
                <div className="space-y-1.5">
                  {DEPARTMENTS.map((dept) => (
                    <DeptOtRow
                      key={dept.key}
                      dept={dept}
                      enabled={deptOt[`ot_dept_${dept.key}`] ?? true}
                      globalSuspended={globalOtSuspended}
                      saveState={saveStates[`ot_dept_${dept.key}`] ?? 'idle'}
                      onToggle={handleDeptOt}
                    />
                  ))}
                </div>

                <div className="mt-3 flex items-center gap-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-[10px] text-zinc-400">OT counted in payroll</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-red-400" />
                    <span className="text-[10px] text-zinc-400">OT excluded (suspended)</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── Audit Log tab ── */}
          {rightTab === 'audit' && (
            <AuditLogPanel className="min-h-0 flex-1" onNavigateToOtSettings={() => setRightTab('ot')} />
          )}
        </div>
      </div>
    </div>
  );
}
