/**
 * Supabase database health: tells a Supabase OUTAGE apart from OUR database
 * being overloaded. Pure: the probe in `diagnostics-probes.ts` measures and this
 * decides.
 *
 * Why this exists (2026-10-08, Open items 415/416): five clerks paying through
 * Payment Dispatch drove the database to load average 43. Trivial reads took
 * 1–20 s and Mark Paid failed with "AbortError". Supabase's gateway answered its
 * health check in 0.5 s and status.supabase.com was green. The old map had one
 * signal, a REST round-trip, so the most it could say was "Probe timed out",
 * with the advice to check the status page. That advice was the wrong lead:
 * Supabase was fine; our database was saturated.
 *
 * Three readings, taken side by side:
 *   gateway: `/auth/v1/health`. Answers without touching our database, so a
 *            failure here is Supabase itself.
 *   rest:    one tiny PostgREST read. What every HRIS screen actually waits on.
 *   host:    the database server's own load and memory, from Supabase's
 *            Prometheus endpoint. Null when it did not answer.
 */

export type DbHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface TimedCheck {
  /** Answered with a 2xx inside the budget. */
  ok: boolean;
  /** Wall-clock until it answered, or until the budget ran out. */
  ms: number;
  /** The budget ran out before any answer. */
  timedOut: boolean;
  /** HTTP status when one came back. */
  httpStatus?: number;
}

export interface DbHostMetrics {
  load1: number;
  load5: number | null;
  load15: number | null;
  /** vCPUs the database server has; null when the metrics did not say. */
  cpus: number | null;
  memAvailableBytes: number | null;
  memTotalBytes: number | null;
}

export interface DbHealthVerdict {
  status: DbHealthStatus;
  summary: string;
  details: string[];
  suggestedChecks: string[];
}

/** REST reads slower than this are what users feel as "data is not loading". */
export const REST_SLOW_MS = 2000;
/** Runnable work per vCPU. At 1 every core is busy and new work starts to queue. */
export const LOAD_BUSY_PER_CPU = 1;
/** At 4× the cores the server is saturated whatever the reads say this second. */
export const LOAD_SATURATED_PER_CPU = 4;
/** Free memory under this share of the total is a warning on its own. */
export const MEM_LOW_FRACTION = 0.1;

const SAMPLE_RE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(\S+)/;

/**
 * Pulls the few numbers the verdict needs out of Prometheus text exposition.
 * Never returns labels or raw lines: the probe contract allows numbers only.
 * Null when there is no `node_load1`, because without it there is no reading.
 */
export function parseDbHostMetrics(text: string): DbHostMetrics | null {
  let load1: number | null = null;
  let load5: number | null = null;
  let load15: number | null = null;
  let memAvailableBytes: number | null = null;
  let memTotalBytes: number | null = null;
  const cpuIds = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = SAMPLE_RE.exec(line);
    if (!m) continue;
    const [, name, labels = '', valueRaw] = m;
    const value = Number(valueRaw);
    switch (name) {
      case 'node_load1':
        if (Number.isFinite(value)) load1 = value;
        break;
      case 'node_load5':
        if (Number.isFinite(value)) load5 = value;
        break;
      case 'node_load15':
        if (Number.isFinite(value)) load15 = value;
        break;
      case 'node_memory_MemAvailable_bytes':
        if (Number.isFinite(value)) memAvailableBytes = value;
        break;
      case 'node_memory_MemTotal_bytes':
        if (Number.isFinite(value)) memTotalBytes = value;
        break;
      case 'node_cpu_seconds_total': {
        const cpu = /(?:^|[{,])cpu="([^"]*)"/.exec(labels);
        if (cpu) cpuIds.add(cpu[1]);
        break;
      }
    }
  }
  if (load1 === null) return null;
  return {
    load1,
    load5,
    load15,
    cpus: cpuIds.size > 0 ? cpuIds.size : null,
    memAvailableBytes,
    memTotalBytes,
  };
}

function fmtMs(c: TimedCheck): string {
  if (c.timedOut) return `no answer within ${c.ms}ms`;
  if (!c.ok) return `failed after ${c.ms}ms${c.httpStatus ? ` (HTTP ${c.httpStatus})` : ''}`;
  return `${c.ms}ms`;
}

function fmtGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const CHECK_STATUS_PAGE = 'Check status.supabase.com, the Supabase platform itself.';
const CHECK_WHO_IS_LOADING = [
  'Who is paying right now? Every open Payment Dispatch screen reloads the queue on each payment (Open item 416).',
  'Supabase dashboard → Reports / Query Performance for the queries burning CPU.',
  'Supabase dashboard → Settings → Compute: is the size enough for this load?',
];

/**
 * The verdict, in precedence order:
 *  1. Gateway down: a Supabase outage. Nothing of ours can fix it.
 *  2. Reads failing or slow AND the server busy (or its load unreadable): OUR
 *     database is overloaded while Supabase is up. This was 2026-10-08.
 *  3. Saturated even though reads still answer: critical before the reads go.
 *  4. Reads failing with the server not loaded: PostgREST, not capacity.
 *  5. Reads slow without load: locks or long queries (warning).
 *  6. Busy (≥1 per vCPU) or low memory: warning, the early sign.
 *  7. Load unreadable while reads are fine: unknown, never healthy.
 *  8. Otherwise healthy.
 */
export function judgeDbHealth(input: {
  gateway: TimedCheck;
  rest: TimedCheck;
  host: DbHostMetrics | null;
  /** Why `host` is null, for the details line ("no answer within 3000ms", "HTTP 401"). */
  hostError?: string | null;
}): DbHealthVerdict {
  const { gateway, rest, host } = input;
  const perCpu = host && host.cpus ? host.load1 / host.cpus : null;
  const memFrac =
    host && host.memAvailableBytes !== null && host.memTotalBytes
      ? host.memAvailableBytes / host.memTotalBytes
      : null;

  const loadLine = host
    ? host.cpus
      ? `Database server load ${host.load1.toFixed(1)} on ${host.cpus} vCPU${host.cpus === 1 ? '' : 's'} (${perCpu!.toFixed(1)}× its cores)` +
        (host.load15 !== null ? `, 15-min average ${host.load15.toFixed(1)}.` : '.')
      : `Database server load ${host.load1.toFixed(1)}; vCPU count not reported, so it cannot be scaled.`
    : `Database server load unreadable: ${input.hostError ?? 'no answer'}.`;
  const memLine =
    host && memFrac !== null && host.memAvailableBytes !== null && host.memTotalBytes
      ? `Free memory ${fmtGiB(host.memAvailableBytes)} of ${fmtGiB(host.memTotalBytes)} (${Math.round(memFrac * 100)}%).`
      : null;
  const details = (lines: (string | null)[]) => lines.filter((l): l is string => !!l);
  const readings = [
    `Supabase gateway: ${fmtMs(gateway)}.`,
    `HRIS read (PostgREST): ${fmtMs(rest)}.`,
    loadLine,
    memLine,
  ];

  if (!gateway.ok) {
    return {
      status: 'critical',
      summary: 'Supabase is not answering. This is a platform outage, not our database.',
      details: details(readings),
      suggestedChecks: [CHECK_STATUS_PAGE, 'Confirm outbound network from the deployment.'],
    };
  }

  const restBad = !rest.ok || rest.timedOut || rest.ms > REST_SLOW_MS;
  const saturated = perCpu !== null && perCpu >= LOAD_SATURATED_PER_CPU;
  const busy = perCpu !== null && perCpu >= LOAD_BUSY_PER_CPU;

  // An unreadable load is NOT evidence of an idle server: with the gateway up
  // and reads stalling, the likeliest cause is still our own database.
  if (restBad && (busy || perCpu === null)) {
    return {
      status: 'critical',
      summary:
        perCpu === null
          ? 'Our database is not keeping up. Supabase is up, but reads stall and the server’s load could not be read.'
          : `Our database is overloaded (${perCpu.toFixed(1)}× its cores). Supabase is up; reads stall.`,
      details: details(readings),
      suggestedChecks: CHECK_WHO_IS_LOADING,
    };
  }
  if (saturated) {
    return {
      status: 'critical',
      summary: `Our database is saturated (${perCpu!.toFixed(1)}× its cores). Reads still answer, but not for long.`,
      details: details(readings),
      suggestedChecks: CHECK_WHO_IS_LOADING,
    };
  }
  if (!rest.ok && !rest.timedOut) {
    return {
      status: 'critical',
      summary: 'HRIS reads are failing while the database is not under load.',
      details: details(readings),
      suggestedChecks: [
        'Supabase dashboard → Logs → PostgREST / API for the error.',
        'A recent migration or permission change on app_settings.',
      ],
    };
  }
  if (restBad) {
    return {
      status: 'warning',
      summary: 'HRIS reads are slow while the database is not under heavy load.',
      details: details(readings),
      suggestedChecks: [
        'Supabase dashboard → Query Performance for long-running queries or locks.',
        'Re-check in 30 seconds; investigate if it persists.',
      ],
    };
  }
  if (busy || (memFrac !== null && memFrac < MEM_LOW_FRACTION)) {
    return {
      status: 'warning',
      summary: busy
        ? `Database busy (${perCpu!.toFixed(1)}× its cores). Reads still answer in ${rest.ms}ms.`
        : 'Database memory is running low.',
      details: details(readings),
      suggestedChecks: CHECK_WHO_IS_LOADING,
    };
  }
  if (host === null || perCpu === null) {
    return {
      status: 'unknown',
      summary: `Reads answer in ${rest.ms}ms, but the database load could not be read.`,
      details: details(readings),
      suggestedChecks: [
        'The probe reads Supabase’s metrics endpoint with the service-role key; confirm it is set in the deployment.',
      ],
    };
  }
  return {
    status: 'healthy',
    summary: `Database load ${perCpu.toFixed(1)}× its cores; reads answer in ${rest.ms}ms.`,
    details: details(readings),
    suggestedChecks: ['None. Watch this card during payday.'],
  };
}
