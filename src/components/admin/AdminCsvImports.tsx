'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  Briefcase,
  CheckCircle2,
  Clock,
  Cloud,
  DollarSign,
  FileText,
  FileUp,
  Inbox,
  LayoutGrid,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseCsv } from '@/lib/csv/parse-csv';
import { cn } from '@/lib/utils';

// ───────────────────────── Types ─────────────────────────

type UploadKey = 'master' | 'rates' | 'hubstaff' | 'hsl';
type ImportsTab = 'upload' | 'files';
/** Which upload archive the Files tab is currently browsing. */
type FilesSubTab = 'hubstaff' | 'master' | 'rates' | 'hsl';

type UploadResult =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; pct: number; rowHint?: number }
  | { kind: 'success'; fileName: string; summary: string; sublines: string[] }
  | { kind: 'error'; fileName: string; message: string };

interface HubstaffUploadMeta {
  id: string;
  source_file: string | null;
  uploaded_at: string;
  uploaded_by?: string | null;
  row_count: number | null;
  is_current: boolean;
}

interface MasterListResponse {
  success?: boolean;
  rowCount?: number;
  inserted?: number;
  updated?: number;
  rowsMissingPersonalEmail?: number;
  duplicatesInCsv?: number;
  reonboarded?: number;
  reconciledViaWorkEmail?: number;
  uploadId?: string;
  ratesReconcile?: { hint?: string | null; ratesFewerThanMaster?: boolean } | null;
  error?: string;
}

interface RatesResponse {
  success?: boolean;
  rowCount?: number;
  inserted?: number;
  updated?: number;
  uniqueEmployees?: number;
  skippedNoWorkEmail?: number;
  skippedNoRate?: number;
  uploadId?: string;
  error?: string;
}

interface HubstaffResponse {
  success?: boolean;
  rowCount?: number;
  uploadId?: string;
  error?: string;
}

interface RatesSheetSyncResponse {
  success?: boolean;
  sheetId?: string;
  tabName?: string;
  totalRows?: number;
  dataRows?: number;
  rowCount?: number;
  inserted?: number;
  updated?: number;
  uniqueEmployees?: number;
  skippedNoWorkEmail?: number;
  skippedNoRate?: number;
  uploadId?: string;
  error?: string;
}

interface MasterSheetSyncResponse {
  success?: boolean;
  sheetId?: string;
  tabName?: string;
  totalRows?: number;
  dataRows?: number;
  rowCount?: number;
  activeCount?: number | null;
  inserted?: number;
  updated?: number;
  reonboarded?: number;
  reconciledViaWorkEmail?: number;
  rowsMissingPersonalEmail?: number;
  duplicatesInCsv?: number;
  uploadId?: string;
  error?: string;
}

interface OffboardedSheetSyncResponse {
  success?: boolean;
  tabName?: string;
  dataRows?: number;
  parsedRows?: number;
  rowsMissingPersonalEmail?: number;
  matched?: number;
  updated?: number;
  skippedAlreadyOffboarded?: number;
  notFound?: number;
  unmatchedEmails?: string[];
  error?: string;
}

interface HubstaffSourceFilesResponse {
  files?: string[];
  uploads?: HubstaffUploadMeta[];
  error?: string | null;
}

interface UploadsListResponse {
  uploads?: HubstaffUploadMeta[];
  error?: string | null;
}

interface HubstaffFileDetailResponse {
  columns?: string[] | null;
  rows?: Record<string, unknown>[] | null;
  error?: string | null;
}

const FILE_ROW_PAGE_SIZE = 50;
const HIDDEN_DETAIL_COLS = new Set(['id', 'source_file', 'upload_id', 'created_at']);

// ───────────────────────── Helpers ─────────────────────────

/** Short human-readable timestamp. Returns null on invalid input. */
function formatUploadStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Case-insensitive header lookup; returns -1 if no label matches. */
function findHeaderColumn(header: string[], ...labels: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const label of labels) {
    const i = norm.indexOf(label.trim().toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/** Drop fully-empty rows, keeping the header. */
function compactGrid(grid: string[][]): string[][] {
  if (grid.length === 0) return grid;
  return [grid[0], ...grid.slice(1).filter((row) => row.some((cell) => cell.trim() !== ''))];
}

// ───────────────────────── Main ─────────────────────────

export default function AdminCsvImports() {
  const [tab, setTab] = useState<ImportsTab>('upload');

  // ── Refs for hidden file inputs
  const masterInputRef = useRef<HTMLInputElement | null>(null);
  const ratesInputRef = useRef<HTMLInputElement | null>(null);
  const hubstaffInputRef = useRef<HTMLInputElement | null>(null);

  // ── Per-card status (post-action result; persists for the session)
  const [results, setResults] = useState<Record<UploadKey, UploadResult>>({
    master: { kind: 'idle' },
    rates: { kind: 'idle' },
    hubstaff: { kind: 'idle' },
    hsl: { kind: 'idle' },
  });
  const setResult = useCallback((key: UploadKey, next: UploadResult) => {
    setResults((prev) => ({ ...prev, [key]: next }));
  }, []);

  // ── Progress animation for sync/upload operations
  const animTimers = useRef<Partial<Record<UploadKey, ReturnType<typeof setInterval>>>>({});

  const startProgress = useCallback(
    (key: UploadKey, fileName: string, rowHint?: number): (() => void) => {
      const existing = animTimers.current[key];
      if (existing !== undefined) clearInterval(existing);
      let pct = 0;
      setResults((p) => ({ ...p, [key]: { kind: 'uploading', fileName, pct, rowHint } }));
      const timer = setInterval(() => {
        pct = Math.min(88, pct + (pct < 35 ? 3.5 : pct < 65 ? 1.5 : pct < 82 ? 0.6 : 0.15));
        setResults((p) => ({ ...p, [key]: { kind: 'uploading', fileName, pct, rowHint } }));
      }, 80);
      animTimers.current[key] = timer;
      return () => {
        clearInterval(timer);
        delete animTimers.current[key];
      };
    },
    [],
  );

  // ── Hubstaff confirm dialog
  const [pendingHubstaff, setPendingHubstaff] = useState<{ text: string; fileName: string } | null>(null);
  const [hubstaffConfirmOpen, setHubstaffConfirmOpen] = useState(false);

  // ── Delete-batch confirm dialog
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── Files sub-tab (which upload archive is being browsed)
  const [filesSubTab, setFilesSubTab] = useState<FilesSubTab>('hubstaff');

  // ── Which upload card is currently "selected" — drives the batches list
  // shown at the bottom of the Upload tab. Click any card to switch.
  const [selectedSource, setSelectedSource] = useState<UploadKey>('hubstaff');
  const [masterSyncClearOffboarded, setMasterSyncClearOffboarded] = useState(true);

  // ── Hubstaff uploads list (for "Uploaded batches" + Files tab)
  const [uploads, setUploads] = useState<HubstaffUploadMeta[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(true);

  const loadUploads = useCallback(async () => {
    setUploadsLoading(true);
    try {
      const res = await fetch(`/api/hubstaff-hours?source_files=1&_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as HubstaffSourceFilesResponse;
      setUploads(Array.isArray(json.uploads) ? json.uploads : []);
    } catch {
      setUploads([]);
    } finally {
      setUploadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUploads();
  }, [loadUploads]);

  // ── Master list uploads
  const [masterUploads, setMasterUploads] = useState<HubstaffUploadMeta[]>([]);
  const [masterUploadsLoading, setMasterUploadsLoading] = useState(true);

  const loadMasterUploads = useCallback(async () => {
    setMasterUploadsLoading(true);
    try {
      const res = await fetch(`/api/global-master-list?uploads=1&_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as UploadsListResponse;
      setMasterUploads(Array.isArray(json.uploads) ? json.uploads : []);
    } catch {
      setMasterUploads([]);
    } finally {
      setMasterUploadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMasterUploads();
  }, [loadMasterUploads]);

  // ── Rates uploads
  const [ratesUploads, setRatesUploads] = useState<HubstaffUploadMeta[]>([]);
  const [ratesUploadsLoading, setRatesUploadsLoading] = useState(true);

  const loadRatesUploads = useCallback(async () => {
    setRatesUploadsLoading(true);
    try {
      const res = await fetch(`/api/employee-hourly-rates-upload?uploads=1&_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as UploadsListResponse;
      setRatesUploads(Array.isArray(json.uploads) ? json.uploads : []);
    } catch {
      setRatesUploads([]);
    } finally {
      setRatesUploadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRatesUploads();
  }, [loadRatesUploads]);

  // ── HSL uploads
  const [hslUploads, setHslUploads] = useState<HubstaffUploadMeta[]>([]);
  const [hslUploadsLoading, setHslUploadsLoading] = useState(true);

  const loadHslUploads = useCallback(async () => {
    setHslUploadsLoading(true);
    try {
      const res = await fetch(`/api/cron/sync-hsl-from-sheet?uploads=1&_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as UploadsListResponse;
      setHslUploads(Array.isArray(json.uploads) ? json.uploads : []);
    } catch {
      setHslUploads([]);
    } finally {
      setHslUploadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHslUploads();
  }, [loadHslUploads]);

  // ── Files tab — selected file detail view
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileRows, setFileRows] = useState<Record<string, unknown>[] | null>(null);
  const [fileCols, setFileCols] = useState<string[] | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [filePage, setFilePage] = useState(1);

  const loadFileDetail = useCallback(async (file: string) => {
    setSelectedFile(file);
    setFileLoading(true);
    setFileSearch('');
    setFilePage(1);
    try {
      const res = await fetch(
        `/api/hubstaff-hours?source_file=${encodeURIComponent(file)}&_=${Date.now()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as HubstaffFileDetailResponse;
      setFileCols(Array.isArray(json.columns) ? json.columns : null);
      setFileRows(Array.isArray(json.rows) ? json.rows : null);
    } catch {
      setFileCols(null);
      setFileRows(null);
    } finally {
      setFileLoading(false);
    }
  }, []);

  // ──────────── Upload handlers ────────────

  const handleMasterUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;

      const csvText = await file.text();
      const rowHint = Math.max(0, csvText.split('\n').filter((l) => l.trim()).length - 3);
      const stopProgress = startProgress('master', file.name, rowHint || undefined);
      try {
        const form = new FormData();
        form.set('file', file);
        const res = await fetch('/api/global-master-list', { method: 'POST', body: form });
        const json = (await res.json()) as MasterListResponse;
        if (!res.ok || !json.success) {
          stopProgress();
          const message = json.error ?? res.statusText ?? 'Master list import failed';
          setResult('master', { kind: 'error', fileName: file.name, message });
          toast.error('Master list import failed', { description: message });
          return;
        }
        stopProgress();
        const total = json.rowCount ?? 0;
        const sublines = [
          `${(json.inserted ?? 0).toLocaleString()} new · ${(json.updated ?? 0).toLocaleString()} updated`,
        ];
        if ((json.rowsMissingPersonalEmail ?? 0) > 0) {
          sublines.push(`${json.rowsMissingPersonalEmail} rows missing personal email (orphan)`);
        }
        if ((json.duplicatesInCsv ?? 0) > 0) {
          sublines.push(
            `${json.duplicatesInCsv} duplicate (personal_email, department) rows in CSV — last occurrence kept`,
          );
        }
        if ((json.reconciledViaWorkEmail ?? 0) > 0) {
          sublines.push(
            `${json.reconciledViaWorkEmail} row(s) merged by Work Email + Department (personal email differed from DB)`,
          );
        }
        if (json.ratesReconcile?.hint) {
          sublines.push(json.ratesReconcile.hint);
        }
        setResult('master', {
          kind: 'success',
          fileName: file.name,
          summary: `${total.toLocaleString()} rows imported`,
          sublines,
        });
        toast.success('Master list imported', { description: `${total.toLocaleString()} rows` });
        await loadMasterUploads();
      } catch (err) {
        stopProgress();
        const message = err instanceof Error ? err.message : String(err);
        setResult('master', { kind: 'error', fileName: file.name, message });
        toast.error('Master list import failed', { description: message });
      }
    },
    [setResult, loadMasterUploads, startProgress],
  );

  const handleRatesUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;

      const csvText = await file.text();
      const rowHint = Math.max(0, csvText.split('\n').filter((l) => l.trim()).length - 1);
      const stopProgress = startProgress('rates', file.name, rowHint || undefined);
      try {
        const form = new FormData();
        form.set('file', file);
        const res = await fetch('/api/employee-hourly-rates-upload', {
          method: 'POST',
          body: form,
        });
        const json = (await res.json()) as RatesResponse;
        if (!res.ok || !json.success) {
          stopProgress();
          const message = json.error ?? res.statusText ?? 'Rates import failed';
          setResult('rates', { kind: 'error', fileName: file.name, message });
          toast.error('Rates import failed', { description: message });
          return;
        }
        stopProgress();
        const sublines = [
          `${(json.uniqueEmployees ?? 0).toLocaleString()} employees · ${(
            json.updated ?? 0
          ).toLocaleString()} updated · ${(json.inserted ?? 0).toLocaleString()} new`,
        ];
        if ((json.skippedNoWorkEmail ?? 0) > 0 || (json.skippedNoRate ?? 0) > 0) {
          sublines.push(
            `Skipped — no work email: ${json.skippedNoWorkEmail ?? 0} · no rate: ${json.skippedNoRate ?? 0}`,
          );
        }
        setResult('rates', {
          kind: 'success',
          fileName: file.name,
          summary: `${(json.rowCount ?? 0).toLocaleString()} rows imported`,
          sublines,
        });
        toast.success('Payroll rates imported', { description: sublines[0] });
        await loadRatesUploads();
      } catch (err) {
        stopProgress();
        const message = err instanceof Error ? err.message : String(err);
        setResult('rates', { kind: 'error', fileName: file.name, message });
        toast.error('Rates import failed', { description: message });
      }
    },
    [setResult, loadRatesUploads, startProgress],
  );

  /**
   * Pull the employee roster from the configured Google Sheet (env-driven service account).
   * Goes through the same `replaceGlobalMasterListFromCsvText` pipeline as a CSV upload,
   * so it lands in `global_master_list` + an archive row in `master_list_uploads`.
   */
  const handleMasterSheetSync = useCallback(async () => {
    const synthFileName = 'Google Sheet · master list';
    const stopProgress = startProgress('master', synthFileName);
    try {
      const res = await fetch('/api/cron/sync-master-from-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearOffboarded: masterSyncClearOffboarded }),
      });
      const json = (await res.json()) as MasterSheetSyncResponse;
      if (!res.ok || !json.success) {
        const message = json.error ?? res.statusText ?? 'Google Sheet sync failed';
        setResult('master', { kind: 'error', fileName: synthFileName, message });
        toast.error('Master list sync failed', { description: message });
        return;
      }
      const tab = json.tabName ?? 'sheet';
      const fileName = `Google Sheet · ${tab}`;
      const activeCount = json.activeCount ?? json.rowCount ?? 0;
      const sublines = [
        `${(json.inserted ?? 0).toLocaleString()} new · ${(json.updated ?? 0).toLocaleString()} updated`,
      ];
      if ((json.reonboarded ?? 0) > 0) {
        sublines.push(`${json.reonboarded} off-boarded employees restored to active roster`);
      }
      if ((json.rowsMissingPersonalEmail ?? 0) > 0) {
        sublines.push(`${json.rowsMissingPersonalEmail} rows missing personal email (orphan)`);
      }
      if ((json.duplicatesInCsv ?? 0) > 0) {
        sublines.push(
          `${json.duplicatesInCsv} duplicate (personal_email, department) rows in sheet — last occurrence kept`,
        );
      }
      if ((json.reconciledViaWorkEmail ?? 0) > 0) {
        sublines.push(
          `${json.reconciledViaWorkEmail} row(s) merged by Work Email + Department (personal email differed from DB)`,
        );
      }
      if (json.dataRows != null) {
        sublines.push(`${json.dataRows.toLocaleString()} data rows pulled from sheet`);
      }
      stopProgress();
      setResult('master', {
        kind: 'success',
        fileName,
        summary: `${activeCount.toLocaleString()} active employees`,
        sublines,
      });
      toast.success('Synced from Google Sheet', { description: `${activeCount.toLocaleString()} active employees` });
      await loadMasterUploads();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult('master', { kind: 'error', fileName: synthFileName, message });
      toast.error('Master list sync failed', { description: message });
    } finally {
      stopProgress();
    }
  }, [setResult, loadMasterUploads, masterSyncClearOffboarded, startProgress]);

  /**
   * Pull the "Offboarded" tab of the master Google Sheet and stamp matching
   * `global_master_list` rows as off-boarded (matched on Personal Email).
   * Already off-boarded rows are skipped to preserve manual HR edits.
   */
  const [offboardedSyncRunning, setOffboardedSyncRunning] = useState(false);
  const [offboardedSyncPct, setOffboardedSyncPct] = useState(0);
  const offboardedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const handleOffboardedSheetSync = useCallback(async () => {
    setOffboardedSyncRunning(true);
    setOffboardedSyncPct(0);
    let pct = 0;
    offboardedTimer.current = setInterval(() => {
      pct = Math.min(88, pct + (pct < 35 ? 3.5 : pct < 65 ? 1.5 : pct < 82 ? 0.6 : 0.15));
      setOffboardedSyncPct(pct);
    }, 80);
    try {
      const res = await fetch('/api/cron/sync-offboarded-from-sheet', { method: 'POST' });
      const json = (await res.json()) as OffboardedSheetSyncResponse;
      if (!res.ok || !json.success) {
        const message = json.error ?? res.statusText ?? 'Offboarded sync failed';
        toast.error('Offboarded sync failed', { description: message });
        return;
      }
      const updated = json.updated ?? 0;
      const skipped = json.skippedAlreadyOffboarded ?? 0;
      const notFound = json.notFound ?? 0;
      const sublines: string[] = [];
      if (skipped > 0) sublines.push(`${skipped} already off-boarded — skipped`);
      if (notFound > 0) sublines.push(`${notFound} not found in master list`);
      if ((json.rowsMissingPersonalEmail ?? 0) > 0) {
        sublines.push(`${json.rowsMissingPersonalEmail} sheet rows missing Personal Email`);
      }
      toast.success(`${updated} marked off-boarded`, {
        description: sublines.length > 0 ? sublines.join(' · ') : `from "${json.tabName ?? 'Offboarded'}" sheet`,
      });
      await loadMasterUploads();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Offboarded sync failed', { description: message });
    } finally {
      if (offboardedTimer.current) clearInterval(offboardedTimer.current);
      setOffboardedSyncPct(0);
      setOffboardedSyncRunning(false);
    }
  }, [loadMasterUploads]);

  /**
   * Pull payroll rates from the configured Google Sheet (env-driven service account).
   * Goes through the same `replaceEmployeeHourlyRatesFromCsv` pipeline as a CSV upload,
   * so it lands in `employee_hourly_rates` + an archive row in `rates_uploads`.
   */
  const handleRatesSheetSync = useCallback(async () => {
    const synthFileName = 'Google Sheet · payroll rates';
    const stopProgress = startProgress('rates', synthFileName);
    let succeeded = false;
    try {
      const res = await fetch('/api/cron/sync-rates-from-sheet', { method: 'POST' });
      const json = (await res.json()) as RatesSheetSyncResponse;
      if (!res.ok || !json.success) {
        const message = json.error ?? res.statusText ?? 'Google Sheet sync failed';
        setResult('rates', { kind: 'error', fileName: synthFileName, message });
        toast.error('Google Sheet sync failed', { description: message });
        return;
      }
      succeeded = true;
      const tab = json.tabName ?? 'sheet';
      const fileName = `Google Sheet · ${tab}`;
      const sublines = [
        `${(json.uniqueEmployees ?? 0).toLocaleString()} employees · ${(
          json.updated ?? 0
        ).toLocaleString()} updated · ${(json.inserted ?? 0).toLocaleString()} new`,
      ];
      if ((json.skippedNoWorkEmail ?? 0) > 0 || (json.skippedNoRate ?? 0) > 0) {
        sublines.push(
          `Skipped — no work email: ${json.skippedNoWorkEmail ?? 0} · no rate: ${
            json.skippedNoRate ?? 0
          }`,
        );
      }
      if (json.dataRows != null) {
        sublines.push(`${json.dataRows.toLocaleString()} data rows pulled from sheet`);
      }
      stopProgress();
      setResult('rates', {
        kind: 'success',
        fileName,
        summary: `${(json.rowCount ?? 0).toLocaleString()} rows imported`,
        sublines,
      });
      toast.success('Synced from Google Sheet', { description: sublines[0] });
      await loadRatesUploads();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult('rates', { kind: 'error', fileName: synthFileName, message });
      toast.error('Google Sheet sync failed', { description: message });
    } finally {
      stopProgress();
    }
  }, [setResult, loadRatesUploads, startProgress]);

  /**
   * Pull the HSL agent pay plan from the configured Google Sheet. Goes through
   * `replaceHslAgentsFromRows` → upserts `hsl_team_members` + new row in
   * `hsl_agent_uploads` (promoted to is_current). Sheet-only — no CSV upload
   * counterpart, so the card has just the sync button as its primary action.
   */
  const handleHslSheetSync = useCallback(async () => {
    const synthFileName = 'Google Sheet · HSL agents';
    const stopProgress = startProgress('hsl', synthFileName);
    try {
      const res = await fetch('/api/cron/sync-hsl-from-sheet', { method: 'POST' });
      const json = (await res.json()) as {
        success?: boolean;
        sheetId?: string;
        tabName?: string;
        totalRows?: number;
        dataRows?: number;
        skippedNoEmail?: number;
        rowCount?: number;
        inserted?: number;
        updated?: number;
        duplicatesInInput?: number;
        uploadId?: string;
        error?: string;
      };
      if (!res.ok || !json.success) {
        const message = json.error ?? res.statusText ?? 'HSL sync failed';
        setResult('hsl', { kind: 'error', fileName: synthFileName, message });
        toast.error('HSL sync failed', { description: message });
        return;
      }
      const tab = json.tabName ?? 'sheet';
      const fileName = `Google Sheet · ${tab}`;
      const total = json.rowCount ?? 0;
      const sublines = [
        `${(json.inserted ?? 0).toLocaleString()} new · ${(json.updated ?? 0).toLocaleString()} updated`,
      ];
      if ((json.duplicatesInInput ?? 0) > 0) {
        sublines.push(
          `${json.duplicatesInInput} duplicate email rows in sheet — last occurrence kept`,
        );
      }
      if ((json.skippedNoEmail ?? 0) > 0) {
        sublines.push(`${json.skippedNoEmail} sheet rows skipped (no email)`);
      }
      if (json.dataRows != null) {
        sublines.push(`${json.dataRows.toLocaleString()} rows pulled from sheet`);
      }
      stopProgress();
      setResult('hsl', {
        kind: 'success',
        fileName,
        summary: `${total.toLocaleString()} agents synced`,
        sublines,
      });
      toast.success('HSL agents synced', { description: `${total.toLocaleString()} rows` });
      await loadHslUploads();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult('hsl', { kind: 'error', fileName: synthFileName, message });
      toast.error('HSL sync failed', { description: message });
    } finally {
      stopProgress();
    }
  }, [setResult, loadHslUploads, startProgress]);

  /**
   * Hubstaff: parse client-side, validate header shape, then surface a confirm
   * dialog before POST. Mirrors the Payroll Wizard's `handleWeeklyFileChosen`
   * so admins get the same safety check (wrong-CSV → fail fast, no DB write).
   */
  const handleHubstaffPicked = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    let text: string;
    try {
      const buf = await file.arrayBuffer();
      text = new TextDecoder('utf-8').decode(buf);
    } catch (err) {
      toast.error('Could not read file', {
        description: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let rawGrid: string[][];
    try {
      rawGrid = parseCsv(text);
    } catch (err) {
      toast.error('Could not parse CSV', {
        description: err instanceof Error ? err.message : 'The file may be corrupted or not valid CSV.',
      });
      return;
    }
    const grid = compactGrid(rawGrid);
    if (grid.length < 2) {
      toast.error('Invalid CSV', {
        description: 'The file needs a header row and at least one data row.',
      });
      return;
    }

    const header = grid[0].map((h) => h.trim());
    const emailIdx = findHeaderColumn(header, 'Email', 'Work email', 'Work Email');
    const memberIdx = findHeaderColumn(header, 'Member');
    const totalHoursIdx = findHeaderColumn(header, 'Total hours', 'Total Hours');
    const totalForWeeklyIdx = findHeaderColumn(
      header,
      'Total worked',
      'Total Worked',
      'Worked time',
      'Time worked',
      'Total hours',
      'Total Hours',
    );
    const isWeeklyFormat = emailIdx >= 0 && totalForWeeklyIdx >= 0;
    const isDailyFormat = memberIdx >= 0 && totalHoursIdx >= 0;
    if (!isWeeklyFormat && !isDailyFormat) {
      toast.error('Not a Hubstaff report', {
        description:
          'Expected columns: Email plus Total worked / Total hours (weekly summary), or Member + Total hours (daily export).',
      });
      return;
    }

    setPendingHubstaff({ text, fileName: file.name });
    setHubstaffConfirmOpen(true);
  }, []);

  const confirmHubstaffUpload = useCallback(async () => {
    if (!pendingHubstaff) return;
    const { text, fileName } = pendingHubstaff;
    const stopHubstaffProgress = startProgress('hubstaff', fileName);
    try {
      const form = new FormData();
      form.append('file', new Blob([text], { type: 'text/csv' }), fileName);
      const res = await fetch('/api/hubstaff-hours', { method: 'POST', body: form });
      const json = (await res.json()) as HubstaffResponse;
      if (!res.ok || !json.success) {
        stopHubstaffProgress();
        const message = json.error ?? res.statusText ?? 'Upload failed';
        setResult('hubstaff', { kind: 'error', fileName, message });
        toast.error('Hubstaff upload failed', { description: message });
        return;
      }
      stopHubstaffProgress();
      const total = json.rowCount ?? 0;
      setResult('hubstaff', {
        kind: 'success',
        fileName,
        summary: `${total.toLocaleString()} rows imported`,
        sublines: [
          json.uploadId ? `upload_id: ${json.uploadId.slice(0, 8)}…` : 'Promoted to current upload',
        ],
      });
      toast.success('Hubstaff CSV uploaded', { description: `${total.toLocaleString()} rows` });
      setPendingHubstaff(null);
      setHubstaffConfirmOpen(false);
      await loadUploads();
    } catch (err) {
      stopHubstaffProgress();
      const message = err instanceof Error ? err.message : String(err);
      setResult('hubstaff', { kind: 'error', fileName, message });
      toast.error('Hubstaff upload failed', { description: message });
    }
  }, [pendingHubstaff, setResult, loadUploads, startProgress]);

  // ──────────── Delete-batch flow ────────────

  const confirmDelete = useCallback(async () => {
    if (!deletePending) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(
        `/api/hubstaff-hours?source_file=${encodeURIComponent(deletePending)}&_=${Date.now()}`,
        { method: 'DELETE', cache: 'no-store' },
      );
      const json = (await res.json()) as { success?: boolean; error?: string; deleted?: number };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Delete failed');
      }
      const removed = json.deleted ?? 0;
      const label = deletePending;
      if (removed === 0) {
        toast.warning('Nothing removed', {
          description: `No rows with source_file "${label}" were found.`,
        });
      } else {
        toast.success('Removed from Supabase', {
          description: `${removed} row(s) deleted for ${label}.`,
        });
      }
      // Clear file detail if we just deleted the active one
      if (selectedFile === deletePending) {
        setSelectedFile(null);
        setFileRows(null);
        setFileCols(null);
      }
      setDeletePending(null);
      await loadUploads();
    } catch (err) {
      toast.error('Could not delete batch', {
        description: err instanceof Error ? err.message : 'Delete failed',
      });
    } finally {
      setDeleteLoading(false);
    }
  }, [deletePending, selectedFile, loadUploads]);

  // ──────────── Render ────────────

  const hubstaffUploading = results.hubstaff.kind === 'uploading';
  const detailColsToShow = useMemo(() => {
    if (!fileCols) return [];
    return fileCols.filter((c) => !HIDDEN_DETAIL_COLS.has(c));
  }, [fileCols]);
  const filteredFileRows = useMemo(() => {
    if (!fileRows) return [];
    const needle = fileSearch.trim().toLowerCase();
    if (!needle) return fileRows;
    return fileRows.filter((row) =>
      detailColsToShow.some((c) => String(row[c] ?? '').toLowerCase().includes(needle)),
    );
  }, [fileRows, detailColsToShow, fileSearch]);
  const totalFilePages = Math.max(1, Math.ceil(filteredFileRows.length / FILE_ROW_PAGE_SIZE));
  const safeFilePage = Math.min(filePage, totalFilePages);
  const fileRowsPage = filteredFileRows.slice(
    (safeFilePage - 1) * FILE_ROW_PAGE_SIZE,
    safeFilePage * FILE_ROW_PAGE_SIZE,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#fafaf8] dark:bg-[#0d1117]">
      {/* ── Header */}
      <header className="shrink-0 border-b border-[#ececec] bg-white/95 px-4 py-4 backdrop-blur-md sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto flex w-full max-w-[1600px] items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400">
            <FileUp className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              CSV imports
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 sm:text-sm dark:text-zinc-500">
              Standalone roster, payroll-rates, and Hubstaff timesheet ingest. Mirrors the Payroll
              Wizard&apos;s upload step — admin-only, runs without wizard state.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void loadUploads();
              void loadMasterUploads();
              void loadRatesUploads();
              void loadHslUploads();
            }}
            className="hidden shrink-0 gap-1.5 border-[#ececec] bg-stone-50 text-xs sm:inline-flex dark:border-zinc-800 dark:bg-zinc-900"
            disabled={
              uploadsLoading || masterUploadsLoading || ratesUploadsLoading || hslUploadsLoading
            }
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                (uploadsLoading || masterUploadsLoading || ratesUploadsLoading || hslUploadsLoading) &&
                  'animate-spin',
              )}
            />
            Refresh
          </Button>
        </div>

        {/* Tabs */}
        <div className="mx-auto mt-4 flex w-full max-w-[1600px] gap-1 rounded-lg border border-[#ececec] bg-stone-50 p-1 sm:w-fit dark:border-zinc-800 dark:bg-zinc-900">
          <TabButton active={tab === 'upload'} onClick={() => setTab('upload')} icon={Upload}>
            Upload
          </TabButton>
          <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={LayoutGrid}>
            Files
            {(uploads.length + masterUploads.length + ratesUploads.length + hslUploads.length) > 0 && (
              <span className="ml-1.5 text-zinc-400 dark:text-zinc-500">
                {uploads.length + masterUploads.length + ratesUploads.length + hslUploads.length}
              </span>
            )}
          </TabButton>
        </div>
      </header>

      {/* ── Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto w-full max-w-[1600px]">
          {tab === 'upload' ? (
            <UploadTab
              masterInputRef={masterInputRef}
              ratesInputRef={ratesInputRef}
              hubstaffInputRef={hubstaffInputRef}
              onMasterPick={() => masterInputRef.current?.click()}
              onRatesPick={() => ratesInputRef.current?.click()}
              onHubstaffPick={() => hubstaffInputRef.current?.click()}
              onMasterSheetSync={handleMasterSheetSync}
              masterSyncClearOffboarded={masterSyncClearOffboarded}
              onMasterSyncClearOffboardedChange={setMasterSyncClearOffboarded}
              onOffboardedSheetSync={handleOffboardedSheetSync}
              offboardedSyncRunning={offboardedSyncRunning}
              offboardedSyncPct={offboardedSyncPct}
              onRatesSheetSync={handleRatesSheetSync}
              onHslSheetSync={handleHslSheetSync}
              selectedSource={selectedSource}
              onSelectSource={setSelectedSource}
              masterUploads={masterUploads}
              masterUploadsLoading={masterUploadsLoading}
              ratesUploads={ratesUploads}
              ratesUploadsLoading={ratesUploadsLoading}
              hslUploads={hslUploads}
              hslUploadsLoading={hslUploadsLoading}
              handleMasterUpload={handleMasterUpload}
              handleRatesUpload={handleRatesUpload}
              handleHubstaffPicked={handleHubstaffPicked}
              results={results}
              hubstaffUploading={hubstaffUploading}
              uploads={uploads}
              uploadsLoading={uploadsLoading}
              onDeleteRequest={(f) => setDeletePending(f)}
              onInspect={(f) => {
                setTab('files');
                void loadFileDetail(f);
              }}
            />
          ) : (
            <FilesTab
              subTab={filesSubTab}
              onSubTabChange={setFilesSubTab}
              hubstaffUploads={uploads}
              hubstaffLoading={uploadsLoading}
              masterUploads={masterUploads}
              masterLoading={masterUploadsLoading}
              ratesUploads={ratesUploads}
              ratesLoading={ratesUploadsLoading}
              hslUploads={hslUploads}
              hslLoading={hslUploadsLoading}
              selectedFile={selectedFile}
              onSelect={(f) => void loadFileDetail(f)}
              onDeleteRequest={(f) => setDeletePending(f)}
              fileLoading={fileLoading}
              fileCols={detailColsToShow}
              fileRows={fileRowsPage}
              totalRows={filteredFileRows.length}
              fullRowCount={fileRows?.length ?? 0}
              search={fileSearch}
              onSearchChange={(v) => {
                setFileSearch(v);
                setFilePage(1);
              }}
              page={safeFilePage}
              totalPages={totalFilePages}
              onPageChange={setFilePage}
            />
          )}
        </div>
      </div>

      {/* ── Hubstaff confirm-upload dialog */}
      <Dialog
        open={hubstaffConfirmOpen}
        onOpenChange={(open) => {
          setHubstaffConfirmOpen(open);
          if (!open) setPendingHubstaff(null);
        }}
      >
        <DialogContent className="border-zinc-200 bg-white sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-900 dark:text-white">
              <Lock className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" />
              Confirm upload to database
            </DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              This will append rows to{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">public.hubstaff_hours</span>{' '}
              from the CSV you selected
              {pendingHubstaff ? (
                <>
                  {' '}
                  (<span className="font-mono">{pendingHubstaff.fileName}</span>).
                </>
              ) : (
                '.'
              )}{' '}
              The new upload is archived and promoted to current. Approve only if this is the correct
              week&apos;s export.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-zinc-200 dark:border-zinc-800"
              disabled={hubstaffUploading}
              onClick={() => {
                setPendingHubstaff(null);
                setHubstaffConfirmOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
              disabled={hubstaffUploading || !pendingHubstaff}
              onClick={() => void confirmHubstaffUpload()}
            >
              {hubstaffUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              Approve & upload
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete-batch dialog */}
      <Dialog
        open={deletePending !== null}
        onOpenChange={(open) => {
          if (!open) setDeletePending(null);
        }}
      >
        <DialogContent className="border-zinc-200 bg-white sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-900 dark:text-white">
              <Trash2 className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
              Delete this batch?
            </DialogTitle>
            <DialogDescription className="text-zinc-600 dark:text-zinc-400">
              This permanently removes every row in{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">public.hubstaff_hours</span>{' '}
              tagged with <span className="font-mono">{deletePending ?? ''}</span>. Other CSV batches
              are not affected.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-zinc-200 dark:border-zinc-800"
              disabled={deleteLoading}
              onClick={() => setDeletePending(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-2"
              disabled={deleteLoading || !deletePending}
              onClick={() => void confirmDelete()}
            >
              {deleteLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete from database
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Hidden inputs (rendered once, controlled via refs) */}
      <input
        ref={masterInputRef}
        type="file"
        accept=".csv,.CSV,text/csv,application/csv,text/plain"
        onChange={handleMasterUpload}
        className="hidden"
      />
      <input
        ref={ratesInputRef}
        type="file"
        accept=".csv,.CSV,text/csv,application/csv,text/plain"
        onChange={handleRatesUpload}
        className="hidden"
      />
      <input
        ref={hubstaffInputRef}
        type="file"
        accept=".csv,.CSV,text/csv,application/csv,text/plain"
        onChange={handleHubstaffPicked}
        className="hidden"
      />
    </div>
  );
}

// ───────────────────────── Tab button ─────────────────────────

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
        active
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

// ───────────────────────── Upload tab ─────────────────────────

interface UploadTabProps {
  masterInputRef: React.RefObject<HTMLInputElement | null>;
  ratesInputRef: React.RefObject<HTMLInputElement | null>;
  hubstaffInputRef: React.RefObject<HTMLInputElement | null>;
  onMasterPick: () => void;
  onRatesPick: () => void;
  onHubstaffPick: () => void;
  onMasterSheetSync: () => void | Promise<void>;
  masterSyncClearOffboarded: boolean;
  onMasterSyncClearOffboardedChange: (v: boolean) => void;
  onOffboardedSheetSync: () => void | Promise<void>;
  offboardedSyncRunning: boolean;
  offboardedSyncPct: number;
  onRatesSheetSync: () => void | Promise<void>;
  onHslSheetSync: () => void | Promise<void>;
  /** Which card is "selected" — drives the batches list rendered below. */
  selectedSource: UploadKey;
  onSelectSource: (k: UploadKey) => void;
  /** Archive listings for the non-Hubstaff sources (Hubstaff list is the existing `uploads` prop). */
  masterUploads: HubstaffUploadMeta[];
  masterUploadsLoading: boolean;
  ratesUploads: HubstaffUploadMeta[];
  ratesUploadsLoading: boolean;
  hslUploads: HubstaffUploadMeta[];
  hslUploadsLoading: boolean;
  handleMasterUpload: (e: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  handleRatesUpload: (e: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  handleHubstaffPicked: (e: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  results: Record<UploadKey, UploadResult>;
  hubstaffUploading: boolean;
  uploads: HubstaffUploadMeta[];
  uploadsLoading: boolean;
  onDeleteRequest: (file: string) => void;
  onInspect: (file: string) => void;
}

function UploadTab(props: UploadTabProps) {
  const {
    results,
    uploads,
    uploadsLoading,
    onDeleteRequest,
    onInspect,
    onMasterSheetSync,
    masterSyncClearOffboarded,
    onMasterSyncClearOffboardedChange,
    onOffboardedSheetSync,
    offboardedSyncRunning,
    offboardedSyncPct,
    onRatesSheetSync,
    onHslSheetSync,
    selectedSource,
    onSelectSource,
    masterUploads,
    masterUploadsLoading,
    ratesUploads,
    ratesUploadsLoading,
    hslUploads,
    hslUploadsLoading,
  } = props;

  return (
    <div className="space-y-5">
      {/* ── 4 upload cards: master · rates · hubstaff · hsl. Each takes one column
          on xl+ so the row stays one wide; folds back to 2-col mid-screen and
          single-col on mobile. */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex flex-col gap-2">
          <UploadCard
            tone="emerald"
            captionLabel="Global master list"
            title="Employee roster CSV"
            Icon={Users}
            description={
              <>
                The <span className="font-medium">MASTERLIST</span> sheet only — rows{' '}
                <span className="font-medium">1–2</span> must contain{' '}
                <span className="font-mono">MASTERLIST</span>; row{' '}
                <span className="font-medium">3</span> is headers; row{' '}
                <span className="font-medium">4+</span> is data.
              </>
            }
            footnote={
              <>
                Upserts <span className="font-mono">global_master_list</span> on{' '}
                <span className="font-mono">(personal_email, department)</span>. History preserved via{' '}
                <span className="font-mono">master_list_uploads</span>.
              </>
            }
            buttonLabel="Choose master list CSV"
            onPick={props.onMasterPick}
            uploading={results.master.kind === 'uploading'}
            result={results.master}
            secondaryAction={{
              label: 'Sync from Google Sheet',
              Icon: Cloud,
              onClick: () => void onMasterSheetSync(),
            }}
            selected={selectedSource === 'master'}
            onSelect={() => onSelectSource('master')}
          />
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 px-3 py-2 text-xs text-zinc-700 transition-colors hover:bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-zinc-300 dark:hover:bg-emerald-950/30">
            <input
              type="checkbox"
              checked={masterSyncClearOffboarded}
              onChange={(e) => onMasterSyncClearOffboardedChange(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-600"
            />
            <span>
              <span className="font-medium">Restore off-boarded</span>
              {' '}— re-activate anyone in the sheet who was previously off-boarded
            </span>
          </label>

          {/* Offboarded sheet sync — separate button: pulls the "Offboarded" tab and
              stamps matching rows in global_master_list with off_boarded_* fields. */}
          <button
            type="button"
            onClick={() => void onOffboardedSheetSync()}
            disabled={offboardedSyncRunning}
            className="flex items-center justify-center gap-2 rounded-lg border border-rose-200/80 bg-rose-50/60 px-3 py-2 text-xs font-medium text-rose-800 transition-colors hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/50 dark:bg-rose-950/25 dark:text-rose-200 dark:hover:bg-rose-950/40"
          >
            <Cloud className="h-3.5 w-3.5" />
            <span>Sync Offboarded sheet → mark as off-boarded</span>
          </button>
          {offboardedSyncRunning && (
            <div className="rounded-lg border border-zinc-200 bg-stone-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="mb-1 flex items-center justify-between text-[10.5px]">
                <span className="text-zinc-500 dark:text-zinc-500">Syncing offboarded sheet…</span>
                <span className="tabular-nums text-zinc-400 dark:text-zinc-600">{Math.round(offboardedSyncPct)}%</span>
              </div>
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700/60">
                <div
                  className="h-full rounded-full bg-rose-500 transition-[width] duration-100 ease-linear"
                  style={{ width: `${offboardedSyncPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <UploadCard
          tone="sky"
          captionLabel="Payroll rates"
          title="All Dept payroll CSV"
          Icon={DollarSign}
          description={
            <>
              The <span className="font-medium">All Dept</span> sheet from the Payroll Dashboard. Reads{' '}
              <span className="font-mono">Work Email</span>,{' '}
              <span className="font-mono">Personal Email</span>,{' '}
              <span className="font-mono">Week</span>,{' '}
              <span className="font-mono">Regular Rate</span>, and{' '}
              <span className="font-mono">OT Rate</span>.
            </>
          }
          footnote={
            <>
              Upserts <span className="font-mono">employee_hourly_rates</span> by work email. Multiple
              weekly rows per employee are expected — latest week wins.
            </>
          }
          buttonLabel="Choose rates CSV"
          onPick={props.onRatesPick}
          uploading={results.rates.kind === 'uploading'}
          result={results.rates}
          secondaryAction={{
            label: 'Sync from Google Sheet',
            Icon: Cloud,
            onClick: () => void onRatesSheetSync(),
          }}
          selected={selectedSource === 'rates'}
          onSelect={() => onSelectSource('rates')}
        />

        <UploadCard
          tone="indigo"
          captionLabel="Hubstaff timesheets"
          title="Hubstaff weekly report"
          Icon={Clock}
          description={
            <>
              Your weekly Hubstaff export. The CSV is parsed locally and validated before a confirm
              dialog appears — wrong file shape never hits the database.
            </>
          }
          footnote={
            <>
              Writes to <span className="font-mono">public.hubstaff_hours</span> + records the batch in{' '}
              <span className="font-mono">hubstaff_uploads</span>. New upload promoted to{' '}
              <span className="font-medium">current</span>.
            </>
          }
          buttonLabel="Choose Hubstaff CSV"
          onPick={props.onHubstaffPick}
          uploading={results.hubstaff.kind === 'uploading'}
          result={results.hubstaff}
          selected={selectedSource === 'hubstaff'}
          onSelect={() => onSelectSource('hubstaff')}
        />

        <UploadCard
          tone="purple"
          captionLabel="HSL agents"
          title="Hogan Smith pay plan"
          Icon={Briefcase}
          description={
            <>
              The <span className="font-medium">HOGAN SMITH AGENT PAY PLAN</span> Google Sheet — agent
              roster, role-within-HSL, hourly + OT rates, KPI/Bonus notes. Sheet-only ingest, no CSV
              counterpart.
            </>
          }
          footnote={
            <>
              Upserts <span className="font-mono">hsl_team_members</span> by{' '}
              <span className="font-mono">LOWER(email)</span>. New batch promoted to{' '}
              <span className="font-medium">current</span> in{' '}
              <span className="font-mono">hsl_agent_uploads</span>; the{' '}
              <span className="font-mono">active_hsl_agents</span> view + Manager → My Team and
              Admin → Rates & Profiles refresh on next read.
            </>
          }
          buttonLabel="Sync from Google Sheet"
          PrimaryButtonIcon={Cloud}
          onPick={() => void onHslSheetSync()}
          uploading={results.hsl.kind === 'uploading'}
          result={results.hsl}
          selected={selectedSource === 'hsl'}
          onSelect={() => onSelectSource('hsl')}
        />
      </div>

      {/*
        ── Selected-source uploaded batches list ──
        Switches content based on which card the user clicked. Hubstaff keeps
        its inline delete + "View rows" jump-to-Files-tab affordance because the
        Hubstaff archive is the only one with row-level inspection wired up.
        Master / Rates / HSL render a metadata-only listing — no DELETE button
        because those endpoints don't have a delete path yet.
      */}
      <SelectedBatchesSection
        selectedSource={selectedSource}
        hubstaffUploads={uploads}
        hubstaffLoading={uploadsLoading}
        masterUploads={masterUploads}
        masterUploadsLoading={masterUploadsLoading}
        ratesUploads={ratesUploads}
        ratesUploadsLoading={ratesUploadsLoading}
        hslUploads={hslUploads}
        hslUploadsLoading={hslUploadsLoading}
        onInspectHubstaff={onInspect}
        onDeleteHubstaff={onDeleteRequest}
      />

      {/* ── Footer note */}
      <p className="rounded-lg border border-dashed border-zinc-300/80 bg-stone-50/60 px-4 py-3 text-[11.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-500">
        All sync + upload endpoints require <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>.
        Each ingest writes an audit-log row:{' '}
        <span className="font-mono">csv.master.upload</span> /{' '}
        <span className="font-mono">csv.master.sync</span>,{' '}
        <span className="font-mono">csv.rates.upload</span> /{' '}
        <span className="font-mono">csv.rates.sync</span>,{' '}
        <span className="font-mono">csv.upload</span> (Hubstaff), and{' '}
        <span className="font-mono">csv.hsl.sync</span>.
      </p>
    </div>
  );
}

// ───────────────────────── Selected batches list ─────────────────────────

interface SelectedBatchesSectionProps {
  selectedSource: UploadKey;
  hubstaffUploads: HubstaffUploadMeta[];
  hubstaffLoading: boolean;
  masterUploads: HubstaffUploadMeta[];
  masterUploadsLoading: boolean;
  ratesUploads: HubstaffUploadMeta[];
  ratesUploadsLoading: boolean;
  hslUploads: HubstaffUploadMeta[];
  hslUploadsLoading: boolean;
  onInspectHubstaff: (file: string) => void;
  onDeleteHubstaff: (file: string) => void;
}

function SelectedBatchesSection({
  selectedSource,
  hubstaffUploads,
  hubstaffLoading,
  masterUploads,
  masterUploadsLoading,
  ratesUploads,
  ratesUploadsLoading,
  hslUploads,
  hslUploadsLoading,
  onInspectHubstaff,
  onDeleteHubstaff,
}: SelectedBatchesSectionProps) {
  // One entry per source — keeps the rendered shape uniform regardless of which
  // card the user clicked.
  const meta: {
    title: string;
    helpLine: React.ReactNode;
    uploads: HubstaffUploadMeta[];
    loading: boolean;
    emptyTitle: string;
    emptyHint: string;
    /** Hubstaff is the only source with a DELETE endpoint + per-batch row inspection. */
    canActOnHubstaff: boolean;
  } = (() => {
    switch (selectedSource) {
      case 'master':
        return {
          title: 'Uploaded master list batches',
          helpLine: (
            <>
              destination <span className="font-mono">global_master_list</span> · archive{' '}
              <span className="font-mono">master_list_uploads</span>
            </>
          ),
          uploads: masterUploads,
          loading: masterUploadsLoading,
          emptyTitle: 'No master list batches yet',
          emptyHint: 'Upload a master list CSV or sync from the Google Sheet.',
          canActOnHubstaff: false,
        };
      case 'rates':
        return {
          title: 'Uploaded payroll rates batches',
          helpLine: (
            <>
              destination <span className="font-mono">employee_hourly_rates</span> · archive{' '}
              <span className="font-mono">rates_uploads</span>
            </>
          ),
          uploads: ratesUploads,
          loading: ratesUploadsLoading,
          emptyTitle: 'No rates batches yet',
          emptyHint: 'Upload an All-Dept payroll CSV or sync from the Google Sheet.',
          canActOnHubstaff: false,
        };
      case 'hsl':
        return {
          title: 'Uploaded HSL agent sync batches',
          helpLine: (
            <>
              destination <span className="font-mono">hsl_team_members</span> · archive{' '}
              <span className="font-mono">hsl_agent_uploads</span>
            </>
          ),
          uploads: hslUploads,
          loading: hslUploadsLoading,
          emptyTitle: 'No HSL syncs yet',
          emptyHint: 'Click "Sync from Google Sheet" on the HSL card to pull the latest pay plan.',
          canActOnHubstaff: false,
        };
      case 'hubstaff':
      default:
        return {
          title: 'Uploaded Hubstaff batches',
          helpLine: (
            <>
              destination <span className="font-mono">public.hubstaff_hours</span> · delete removes
              rows from that table
            </>
          ),
          uploads: hubstaffUploads,
          loading: hubstaffLoading,
          emptyTitle: 'No Hubstaff batches yet',
          emptyHint: "Upload a Hubstaff weekly report and it'll appear here.",
          canActOnHubstaff: true,
        };
    }
  })();

  return (
    <section className="rounded-xl border border-[#ececec] bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-center gap-2">
        <FileText className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">{meta.title}</h2>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-500">({meta.helpLine})</span>
      </header>

      {meta.loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs">Loading batches…</span>
        </div>
      ) : meta.uploads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Inbox className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
          <p className="text-[13px] font-medium text-zinc-600 dark:text-zinc-400">{meta.emptyTitle}</p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{meta.emptyHint}</p>
        </div>
      ) : (
        <ul className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
          {meta.uploads.map((u) => {
            const fname = u.source_file ?? '(unnamed batch)';
            const stamp = formatUploadStamp(u.uploaded_at);
            return (
              <li
                key={u.id}
                className="flex items-start gap-2 rounded-md border border-[#ececec] bg-stone-50/60 px-2 py-1.5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
              >
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {meta.canActOnHubstaff ? (
                      <button
                        type="button"
                        onClick={() => u.source_file && onInspectHubstaff(u.source_file)}
                        className="truncate text-left font-mono text-xs text-zinc-700 hover:text-indigo-600 hover:underline dark:text-zinc-300 dark:hover:text-indigo-400"
                        title="View rows in Files tab"
                      >
                        {fname}
                      </button>
                    ) : (
                      <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                        {fname}
                      </span>
                    )}
                    {u.is_current && (
                      <span className="shrink-0 rounded border border-emerald-300 bg-emerald-50 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                        Current
                      </span>
                    )}
                  </div>
                  {(stamp || u.row_count != null) && (
                    <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-500">
                      {stamp ?? ''}
                      {stamp && u.row_count != null ? ' · ' : ''}
                      {u.row_count != null ? `${u.row_count.toLocaleString()} rows` : ''}
                    </div>
                  )}
                </div>
                {meta.canActOnHubstaff && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                    title="Delete this batch from Supabase"
                    onClick={() => u.source_file && onDeleteHubstaff(u.source_file)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────── Files tab ─────────────────────────

interface FilesTabProps {
  subTab: FilesSubTab;
  onSubTabChange: (t: FilesSubTab) => void;
  hubstaffUploads: HubstaffUploadMeta[];
  hubstaffLoading: boolean;
  masterUploads: HubstaffUploadMeta[];
  masterLoading: boolean;
  ratesUploads: HubstaffUploadMeta[];
  ratesLoading: boolean;
  hslUploads: HubstaffUploadMeta[];
  hslLoading: boolean;
  selectedFile: string | null;
  onSelect: (file: string) => void;
  onDeleteRequest: (file: string) => void;
  fileLoading: boolean;
  fileCols: string[];
  fileRows: Record<string, unknown>[];
  totalRows: number;
  fullRowCount: number;
  search: string;
  onSearchChange: (v: string) => void;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}

const FILES_SUBTABS: { id: FilesSubTab; label: string; tone: Tone; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'hubstaff', label: 'Hubstaff', tone: 'indigo', Icon: Clock },
  { id: 'master', label: 'Master list', tone: 'emerald', Icon: Users },
  { id: 'rates', label: 'Payroll rates', tone: 'sky', Icon: DollarSign },
  { id: 'hsl', label: 'HSL agents', tone: 'purple', Icon: Briefcase },
];

/** Tone → active text color class. Centralized so the sub-tab nav stays compact. */
const SUBTAB_ACTIVE_TEXT: Record<Tone, string> = {
  indigo: 'text-indigo-700 dark:text-indigo-300',
  emerald: 'text-emerald-700 dark:text-emerald-300',
  sky: 'text-sky-700 dark:text-sky-300',
  purple: 'text-purple-700 dark:text-purple-300',
};

/** Tone → active count-badge color class. */
const SUBTAB_ACTIVE_BADGE: Record<Tone, string> = {
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
};

function FilesTab(props: FilesTabProps) {
  const {
    subTab,
    onSubTabChange,
    hubstaffUploads,
    hubstaffLoading,
    masterUploads,
    masterLoading,
    ratesUploads,
    ratesLoading,
    hslUploads,
    hslLoading,
    selectedFile,
    onSelect,
    onDeleteRequest,
    fileLoading,
    fileCols,
    fileRows,
    totalRows,
    fullRowCount,
    search,
    onSearchChange,
    page,
    totalPages,
    onPageChange,
  } = props;

  return (
    <div className="space-y-4">
      {/* ── Files sub-tab nav: Hubstaff | Master list | Payroll rates | HSL agents */}
      <nav className="inline-flex w-full flex-wrap items-center gap-1 rounded-lg border border-[#ececec] bg-stone-50 p-1 sm:w-fit dark:border-zinc-800 dark:bg-zinc-900">
        {FILES_SUBTABS.map(({ id, label, tone, Icon }) => {
          const counts: Record<FilesSubTab, number> = {
            hubstaff: hubstaffUploads.length,
            master: masterUploads.length,
            rates: ratesUploads.length,
            hsl: hslUploads.length,
          };
          const count = counts[id];
          const active = subTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSubTabChange(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? cn('bg-white shadow-sm dark:bg-zinc-800', SUBTAB_ACTIVE_TEXT[tone])
                  : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              {count > 0 && (
                <span
                  className={cn(
                    'ml-0.5 rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums',
                    active
                      ? SUBTAB_ACTIVE_BADGE[tone]
                      : 'bg-stone-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {subTab === 'hubstaff' ? (
        <HubstaffFilesPane
          uploads={hubstaffUploads}
          uploadsLoading={hubstaffLoading}
          selectedFile={selectedFile}
          onSelect={onSelect}
          onDeleteRequest={onDeleteRequest}
          fileLoading={fileLoading}
          fileCols={fileCols}
          fileRows={fileRows}
          totalRows={totalRows}
          fullRowCount={fullRowCount}
          search={search}
          onSearchChange={onSearchChange}
          page={page}
          totalPages={totalPages}
          onPageChange={onPageChange}
        />
      ) : subTab === 'master' ? (
        <ArchiveOnlyPane
          tone="emerald"
          title="Master list batches"
          tableName="global_master_list"
          archiveTable="master_list_uploads"
          uploads={masterUploads}
          loading={masterLoading}
          inspectionNotice="Per-batch row inspection isn't wired for the master list yet — view a batch's data via Admin → Employees (filters to the active upload)."
        />
      ) : subTab === 'rates' ? (
        <ArchiveOnlyPane
          tone="sky"
          title="Payroll rates batches"
          tableName="employee_hourly_rates"
          archiveTable="rates_uploads"
          uploads={ratesUploads}
          loading={ratesLoading}
          inspectionNotice="Per-batch row inspection isn't wired for rates yet — current rates flow through the Payroll Wizard's calculation step."
        />
      ) : (
        <ArchiveOnlyPane
          tone="purple"
          title="HSL agent sync batches"
          tableName="hsl_team_members"
          archiveTable="hsl_agent_uploads"
          uploads={hslUploads}
          loading={hslLoading}
          inspectionNotice="Per-batch row inspection isn't wired for HSL — current roster flows through Admin → Rates & Profiles and Manager → My Team via the active_hsl_agents view."
        />
      )}
    </div>
  );
}

interface HubstaffFilesPaneProps {
  uploads: HubstaffUploadMeta[];
  uploadsLoading: boolean;
  selectedFile: string | null;
  onSelect: (file: string) => void;
  onDeleteRequest: (file: string) => void;
  fileLoading: boolean;
  fileCols: string[];
  fileRows: Record<string, unknown>[];
  totalRows: number;
  fullRowCount: number;
  search: string;
  onSearchChange: (v: string) => void;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}

function HubstaffFilesPane(props: HubstaffFilesPaneProps) {
  const {
    uploads,
    uploadsLoading,
    selectedFile,
    onSelect,
    onDeleteRequest,
    fileLoading,
    fileCols,
    fileRows,
    totalRows,
    fullRowCount,
    search,
    onSearchChange,
    page,
    totalPages,
    onPageChange,
  } = props;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* Sidebar */}
      <aside className="rounded-xl border border-[#ececec] bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <header className="mb-2 flex items-center gap-2 px-1">
          <FileText className="h-3.5 w-3.5 text-zinc-400" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Hubstaff batches
          </h2>
        </header>
        {uploadsLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-xs">Loading…</span>
          </div>
        ) : uploads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Inbox className="h-5 w-5 text-zinc-300 dark:text-zinc-700" />
            <p className="text-[11px] text-zinc-500">No batches yet</p>
          </div>
        ) : (
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {uploads.map((u) => {
              const fname = u.source_file ?? '(unnamed batch)';
              const stamp = formatUploadStamp(u.uploaded_at);
              const active = selectedFile === u.source_file;
              return (
                <li key={u.id}>
                  <div
                    className={cn(
                      'flex items-start gap-1.5 rounded-md border px-2 py-1.5 transition-colors',
                      active
                        ? 'border-indigo-300 bg-indigo-50/70 dark:border-indigo-800 dark:bg-indigo-950/30'
                        : 'border-transparent hover:border-[#ececec] hover:bg-stone-50/80 dark:hover:border-zinc-800 dark:hover:bg-zinc-900/50',
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => u.source_file && onSelect(u.source_file)}
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className={cn(
                            'truncate font-mono text-[11px]',
                            active
                              ? 'text-indigo-900 dark:text-indigo-200'
                              : 'text-zinc-700 dark:text-zinc-300',
                          )}
                        >
                          {fname}
                        </span>
                        {u.is_current && (
                          <span className="shrink-0 rounded bg-emerald-50 px-1 text-[8.5px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-500">
                        {stamp ?? '—'}
                        {u.row_count != null ? ` · ${u.row_count.toLocaleString()} rows` : ''}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                      title="Delete batch"
                      onClick={() => u.source_file && onDeleteRequest(u.source_file)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* Detail */}
      <section className="rounded-xl border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
        {!selectedFile ? (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-3 p-10 text-center">
            <LayoutGrid className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Pick a batch to inspect its rows
            </p>
            <p className="max-w-md text-[11.5px] text-zinc-500 dark:text-zinc-500">
              Click any file from the left rail to load its columns and a paginated row preview from{' '}
              <span className="font-mono">public.hubstaff_hours</span>.
            </p>
          </div>
        ) : fileLoading ? (
          <div className="flex h-full min-h-[40vh] items-center justify-center gap-2 text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading rows for {selectedFile}…</span>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#ececec] px-4 py-3 dark:border-zinc-800">
              <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
              <span className="min-w-0 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {selectedFile}
              </span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                · {fullRowCount.toLocaleString()} total rows · {fileCols.length} columns
              </span>
              <div className="ml-auto flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                  <Input
                    value={search}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder="Search rows…"
                    className="h-8 w-56 border-[#ececec] bg-stone-50 pl-7 text-[12px] dark:border-zinc-800 dark:bg-zinc-900"
                  />
                </div>
              </div>
            </div>

            {totalRows === 0 ? (
              <div className="flex flex-1 items-center justify-center py-12 text-[12px] text-zinc-500">
                No rows match.
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="min-w-full text-left text-[11.5px]">
                    <thead className="sticky top-0 z-10 bg-stone-50/95 backdrop-blur dark:bg-zinc-900/95">
                      <tr>
                        {fileCols.map((c) => (
                          <th
                            key={c}
                            className="border-b border-[#ececec] px-3 py-2 font-semibold uppercase tracking-wide text-[10px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
                          >
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fileRows.map((row, i) => (
                        <tr
                          key={i}
                          className="border-b border-[#f3f3f3] last:border-b-0 odd:bg-white even:bg-stone-50/40 hover:bg-indigo-50/40 dark:border-zinc-800 dark:odd:bg-zinc-950 dark:even:bg-zinc-900/40 dark:hover:bg-indigo-950/20"
                        >
                          {fileCols.map((c) => {
                            const v = row[c];
                            return (
                              <td
                                key={c}
                                className="px-3 py-2 align-top font-mono text-[11px] text-zinc-700 dark:text-zinc-300"
                              >
                                {v == null || v === '' ? (
                                  <span className="text-zinc-300 dark:text-zinc-700">—</span>
                                ) : (
                                  String(v)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="flex shrink-0 items-center justify-between border-t border-[#ececec] px-4 py-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                  <span>
                    Showing {(page - 1) * FILE_ROW_PAGE_SIZE + 1}–
                    {Math.min(page * FILE_ROW_PAGE_SIZE, totalRows)} of{' '}
                    {totalRows.toLocaleString()}
                    {search && (
                      <span className="ml-1 text-zinc-400">
                        (filtered from {fullRowCount.toLocaleString()})
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={page <= 1}
                      onClick={() => onPageChange(Math.max(1, page - 1))}
                    >
                      Prev
                    </Button>
                    <span className="px-2 tabular-nums">
                      {page} / {totalPages}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={page >= totalPages}
                      onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ───────────────────────── Archive-only pane (master / rates) ─────────────────────────

interface ArchiveOnlyPaneProps {
  tone: Tone;
  title: string;
  tableName: string;
  archiveTable: string;
  uploads: HubstaffUploadMeta[];
  loading: boolean;
  inspectionNotice: string;
}

function ArchiveOnlyPane({
  tone,
  title,
  tableName,
  archiveTable,
  uploads,
  loading,
  inspectionNotice,
}: ArchiveOnlyPaneProps) {
  const t = TONE[tone];
  return (
    <section className="rounded-xl border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center gap-2 border-b border-[#ececec] px-4 py-3 dark:border-zinc-800">
        <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">{title}</h3>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          · destination <span className="font-mono">{tableName}</span> · archive{' '}
          <span className="font-mono">{archiveTable}</span>
        </span>
      </header>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs">Loading batches…</span>
        </div>
      ) : uploads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <Inbox className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
          <p className="text-[13px] font-medium text-zinc-600 dark:text-zinc-400">No batches yet</p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            Upload a CSV from the Upload tab and it will appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[#ececec] dark:divide-zinc-800">
          {uploads.map((u) => {
            const fname = u.source_file ?? '(unnamed batch)';
            const stamp = formatUploadStamp(u.uploaded_at);
            return (
              <li
                key={u.id}
                className={cn(
                  'flex items-start gap-3 px-4 py-3 transition-colors',
                  u.is_current
                    ? cn('bg-stone-50/60 dark:bg-zinc-900/40', t.captionText)
                    : 'hover:bg-stone-50/60 dark:hover:bg-zinc-900/40',
                )}
              >
                <FileText
                  className={cn('mt-0.5 h-4 w-4 shrink-0', u.is_current ? t.iconText : 'text-zinc-400')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                      {fname}
                    </span>
                    {u.is_current && (
                      <span className="shrink-0 rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-500">
                    {stamp && <span>{stamp}</span>}
                    {stamp && u.row_count != null && <span className="text-zinc-300 dark:text-zinc-700">·</span>}
                    {u.row_count != null && (
                      <span>
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {u.row_count.toLocaleString()}
                        </span>{' '}
                        rows
                      </span>
                    )}
                    {u.uploaded_by && (
                      <>
                        <span className="text-zinc-300 dark:text-zinc-700">·</span>
                        <span className="font-mono text-[10.5px]">{u.uploaded_by}</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="shrink-0 self-center font-mono text-[10px] text-zinc-400">
                  {u.id.slice(0, 8)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="border-t border-[#ececec] px-4 py-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
        {inspectionNotice}
      </footer>
    </section>
  );
}

// ───────────────────────── Upload card ─────────────────────────

type Tone = 'emerald' | 'sky' | 'indigo' | 'purple';

const TONE: Record<
  Tone,
  {
    cardBorder: string;
    cardSurface: string;
    iconTile: string;
    iconText: string;
    captionText: string;
    button: string;
    accent: string;
    progressBar: string;
    /** Ring + thicker border applied when the card is "selected" (i.e. its
     *  archive is shown in the bottom listing). */
    selectedRing: string;
  }
> = {
  emerald: {
    cardBorder: 'border-emerald-200/80 dark:border-emerald-900/40',
    cardSurface: 'bg-emerald-50/40 dark:bg-emerald-950/20',
    iconTile: 'border-emerald-200/90 bg-stone-50 dark:border-emerald-800/60 dark:bg-emerald-950/50',
    iconText: 'text-emerald-700 dark:text-emerald-400',
    captionText: 'text-emerald-800/90 dark:text-emerald-400/90',
    button:
      'border-emerald-300/80 bg-stone-50 text-emerald-900 hover:bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/70',
    accent: 'text-emerald-700 dark:text-emerald-400',
    progressBar: 'bg-emerald-500',
    selectedRing: 'ring-2 ring-emerald-400/60 border-emerald-400/80 dark:ring-emerald-500/40 dark:border-emerald-700',
  },
  sky: {
    cardBorder: 'border-sky-200/80 dark:border-sky-900/40',
    cardSurface: 'bg-sky-50/40 dark:bg-sky-950/20',
    iconTile: 'border-sky-200/90 bg-stone-50 dark:border-sky-800/60 dark:bg-sky-950/50',
    iconText: 'text-sky-700 dark:text-sky-400',
    captionText: 'text-sky-800/90 dark:text-sky-400/90',
    button:
      'border-sky-300/80 bg-stone-50 text-sky-900 hover:bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100 dark:hover:bg-sky-950/70',
    accent: 'text-sky-700 dark:text-sky-400',
    progressBar: 'bg-sky-500',
    selectedRing: 'ring-2 ring-sky-400/60 border-sky-400/80 dark:ring-sky-500/40 dark:border-sky-700',
  },
  indigo: {
    cardBorder: 'border-indigo-200/80 dark:border-indigo-900/40',
    cardSurface: 'bg-indigo-50/40 dark:bg-indigo-950/20',
    iconTile: 'border-indigo-200/90 bg-stone-50 dark:border-indigo-800/60 dark:bg-indigo-950/50',
    iconText: 'text-indigo-700 dark:text-indigo-400',
    captionText: 'text-indigo-800/90 dark:text-indigo-400/90',
    button:
      'border-indigo-300/80 bg-indigo-600 text-white hover:bg-indigo-700 dark:border-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-700',
    accent: 'text-indigo-700 dark:text-indigo-400',
    progressBar: 'bg-indigo-500',
    selectedRing: 'ring-2 ring-indigo-400/60 border-indigo-400/80 dark:ring-indigo-500/40 dark:border-indigo-700',
  },
  purple: {
    cardBorder: 'border-purple-200/80 dark:border-purple-900/40',
    cardSurface: 'bg-purple-50/40 dark:bg-purple-950/20',
    iconTile: 'border-purple-200/90 bg-stone-50 dark:border-purple-800/60 dark:bg-purple-950/50',
    iconText: 'text-purple-700 dark:text-purple-300',
    captionText: 'text-purple-800/90 dark:text-purple-300/90',
    button:
      'border-purple-300/80 bg-purple-600 text-white hover:bg-purple-700 dark:border-purple-700 dark:bg-purple-600 dark:hover:bg-purple-700',
    accent: 'text-purple-700 dark:text-purple-300',
    progressBar: 'bg-purple-500',
    selectedRing: 'ring-2 ring-purple-400/60 border-purple-400/80 dark:ring-purple-500/40 dark:border-purple-700',
  },
};

interface UploadCardProps {
  tone: Tone;
  captionLabel: string;
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: React.ReactNode;
  footnote: React.ReactNode;
  buttonLabel: string;
  onPick: () => void;
  uploading: boolean;
  result: UploadResult;
  /** Optional override for the primary button's icon (defaults to Upload). */
  PrimaryButtonIcon?: React.ComponentType<{ className?: string }>;
  /** Optional secondary action rendered as a smaller link-style button below the primary one. */
  secondaryAction?: {
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    onClick: () => void;
  };
  /** When true, the card surface gets a tone-coloured ring + slight elevation
   *  to signal it's the source whose archive is shown in the bottom listing. */
  selected?: boolean;
  /** Called when the user clicks anywhere on the card surface that isn't an
   *  inner button. Lets the parent switch the bottom batches listing to this
   *  source. The primary "Choose CSV" / "Sync from Google Sheet" button still
   *  fires `onPick` independently (its click is stop-propagated). */
  onSelect?: () => void;
}

function UploadCard({
  tone,
  captionLabel,
  title,
  Icon,
  description,
  footnote,
  buttonLabel,
  onPick,
  uploading,
  result,
  PrimaryButtonIcon,
  secondaryAction,
  selected = false,
  onSelect,
}: UploadCardProps) {
  const t = TONE[tone];
  const ButtonIcon = PrimaryButtonIcon ?? Upload;
  // Stop click propagation on inner buttons so they only trigger their own
  // action — without this, every primary/secondary click would also fire the
  // card's onSelect, which is correct behavior but redundant noise.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <section
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 shadow-sm transition-all',
        t.cardBorder,
        t.cardSurface,
        onSelect && 'cursor-pointer hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        selected && t.selectedRing,
      )}
    >
      <header className="flex items-start gap-3">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
            t.iconTile,
          )}
        >
          <Icon className={cn('h-5 w-5', t.iconText)} />
        </div>
        <div className="min-w-0">
          <p className={cn('text-[10px] font-semibold uppercase tracking-wider', t.captionText)}>
            {captionLabel}
          </p>
          <h3 className="text-base font-semibold leading-tight text-zinc-900 dark:text-white">
            {title}
          </h3>
        </div>
      </header>

      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{description}</p>
      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-500">{footnote}</p>

      <ResultPanel result={result} accentClass={t.accent} progressBarClass={t.progressBar} />

      <div className="mt-auto flex flex-col gap-2 pt-1">
        <Button
          type="button"
          variant={tone === 'indigo' ? 'default' : 'outline'}
          disabled={uploading}
          onClick={(e) => {
            stop(e);
            onPick();
          }}
          className={cn('w-full gap-2', t.button)}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ButtonIcon className="h-4 w-4" />}
          {uploading ? 'Uploading…' : buttonLabel}
        </Button>
        {secondaryAction && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              secondaryAction.onClick();
            }}
            disabled={uploading}
            className={cn(
              'flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium transition-colors',
              'text-zinc-600 hover:bg-stone-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50',
              'dark:text-zinc-400 dark:hover:bg-zinc-900/60 dark:hover:text-zinc-100',
            )}
          >
            <secondaryAction.Icon className="h-3.5 w-3.5" />
            {secondaryAction.label}
          </button>
        )}
      </div>
    </section>
  );
}

function ResultPanel({
  result,
  accentClass,
  progressBarClass = 'bg-orange-500',
}: {
  result: UploadResult;
  accentClass: string;
  progressBarClass?: string;
}) {
  if (result.kind === 'idle') {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 bg-stone-50/60 px-3 py-2 text-[11px] text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-600">
        No upload yet this session.
      </div>
    );
  }
  if (result.kind === 'uploading') {
    const pct = result.pct ?? 0;
    return (
      <div className="rounded-lg border border-zinc-200 bg-stone-50/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10.5px]">
          <span className="min-w-0 truncate font-mono text-zinc-500 dark:text-zinc-500">
            {result.fileName}
          </span>
          <span className="shrink-0 tabular-nums text-zinc-400 dark:text-zinc-600">
            {Math.round(pct)}%
          </span>
        </div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700/60">
          <div
            className={cn('h-full rounded-full transition-[width] duration-100 ease-linear', progressBarClass)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-[10.5px] text-zinc-500 dark:text-zinc-500">
          {result.rowHint
            ? `Processing ${result.rowHint.toLocaleString()} rows…`
            : 'Syncing and processing…'}
        </p>
      </div>
    );
  }
  if (result.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[11px] dark:border-rose-900/40 dark:bg-rose-950/30">
        <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />
        <div className="min-w-0">
          <p className="truncate font-mono text-[10.5px] text-rose-700/80 dark:text-rose-300/80">
            {result.fileName}
          </p>
          <p className="break-words text-rose-700 dark:text-rose-300">{result.message}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-[11px] dark:border-emerald-900/40 dark:bg-emerald-950/25">
      <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', accentClass)} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[10.5px] text-zinc-500 dark:text-zinc-500">
          {result.fileName}
        </p>
        <p className="font-medium text-emerald-800 dark:text-emerald-200">{result.summary}</p>
        {result.sublines.map((line, i) => (
          <p key={i} className="text-[10.5px] text-emerald-700/80 dark:text-emerald-300/80">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
