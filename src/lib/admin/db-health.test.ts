import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeDbHealth, parseDbHostMetrics, type DbHostMetrics, type TimedCheck } from './db-health';

/**
 * Pins the Supabase Postgres card's verdict (2026-10-08). That day, five clerks
 * paying drove the database to load average 43. Reads took 1–20 s while
 * Supabase's gateway answered in 0.5 s and its status page was green. The old
 * card could only say "Probe timed out" and pointed at the status page.
 */

// Line shapes as the Supabase metrics endpoint emits them (labels trimmed).
const LABELS = 'supabase_project_ref="ref",supabase_identifier="ref",service_type="db"';
const metricsText = (load1: number, cpus: number, availGiB: number, totalGiB: number) =>
  [
    '# HELP node_load1 1m load average.',
    '# TYPE node_load1 gauge',
    `node_load1{${LABELS}} ${load1}`,
    `node_load5{${LABELS}} ${load1 * 0.98}`,
    `node_load15{${LABELS}} ${load1 * 0.8}`,
    ...Array.from({ length: cpus }, (_, i) => `node_cpu_seconds_total{${LABELS},cpu="${i}",mode="idle"} 1234.5`),
    ...Array.from({ length: cpus }, (_, i) => `node_cpu_seconds_total{${LABELS},cpu="${i}",mode="user"} 99.1`),
    `node_memory_MemAvailable_bytes{${LABELS}} ${availGiB * 1024 ** 3}`,
    `node_memory_MemTotal_bytes{${LABELS}} ${totalGiB * 1024 ** 3}`,
    `pgbouncer_used_clients{${LABELS}} 1`,
  ].join('\n');

const ok = (ms: number): TimedCheck => ({ ok: true, ms, timedOut: false, httpStatus: 200 });
const timedOut = (ms = 3000): TimedCheck => ({ ok: false, ms, timedOut: true });
const host = (load1: number, cpus: number | null, availGiB = 2, totalGiB = 4): DbHostMetrics => ({
  load1,
  load5: load1,
  load15: load1,
  cpus,
  memAvailableBytes: availGiB * 1024 ** 3,
  memTotalBytes: totalGiB * 1024 ** 3,
});

// ── parser ───────────────────────────────────────────────────────────────────

test('parses load, cores (distinct cpu labels, not lines) and memory', () => {
  const m = parseDbHostMetrics(metricsText(43.83, 2, 1.03, 4));
  assert.ok(m);
  assert.equal(m.load1, 43.83);
  assert.equal(m.cpus, 2);
  assert.equal(m.memTotalBytes, 4 * 1024 ** 3);
  assert.ok(Math.abs((m.memAvailableBytes ?? 0) - 1.03 * 1024 ** 3) < 1);
});

test('no node_load1 means no reading at all', () => {
  assert.equal(parseDbHostMetrics(`pgbouncer_used_clients{${LABELS}} 1`), null);
  assert.equal(parseDbHostMetrics('<html>502 Bad Gateway</html>'), null);
});

test('missing cpu series leaves the core count unknown rather than guessing', () => {
  const m = parseDbHostMetrics(`node_load1{${LABELS}} 3.2`);
  assert.equal(m?.cpus, null);
});

test('CRLF line endings parse the same', () => {
  const m = parseDbHostMetrics(metricsText(5, 4, 8, 16).replace(/\n/g, '\r\n'));
  assert.equal(m?.load1, 5);
  assert.equal(m?.cpus, 4);
});

// ── verdict ──────────────────────────────────────────────────────────────────

test('2026-10-08: gateway fine, reads stalling, load 43 on 2 cores → OUR database overloaded, critical', () => {
  const v = judgeDbHealth({ gateway: ok(518), rest: timedOut(), host: parseDbHostMetrics(metricsText(43.83, 2, 1.03, 4)) });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /Our database is overloaded \(21\.9× its cores\)\. Supabase is up/);
  assert.ok(v.suggestedChecks.some((s) => /Payment Dispatch/.test(s)));
  assert.ok(!v.suggestedChecks.some((s) => /status\.supabase\.com/.test(s)), 'must not send the reader to a green status page');
});

test('the same day with the metrics endpoint starved too → still our database, critical', () => {
  const v = judgeDbHealth({ gateway: ok(500), rest: timedOut(), host: null, hostError: 'no answer within 3000ms' });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /Our database is not keeping up\. Supabase is up/);
  assert.ok(v.details.some((d) => /no answer within 3000ms/.test(d)));
});

test('gateway down → a Supabase outage, whatever else is true', () => {
  const v = judgeDbHealth({ gateway: timedOut(2000), rest: timedOut(), host: null });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /platform outage/);
  assert.ok(v.suggestedChecks.some((s) => /status\.supabase\.com/.test(s)));
});

test('saturated but reads still answering → critical before the reads go', () => {
  const v = judgeDbHealth({ gateway: ok(400), rest: ok(450), host: host(40, 8) });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /saturated \(5\.0× its cores\)/);
});

test('busy (≥1 per core) with fast reads → warning, the early sign', () => {
  const v = judgeDbHealth({ gateway: ok(400), rest: ok(300), host: host(10, 8) });
  assert.equal(v.status, 'warning');
  assert.match(v.summary, /Database busy \(1\.3× its cores\)/);
});

test('slow reads with a busy server → overloaded, critical', () => {
  const v = judgeDbHealth({ gateway: ok(400), rest: ok(2500), host: host(10, 8) });
  assert.equal(v.status, 'critical');
});

test('slow reads on an idle server → warning about locks/long queries, not capacity', () => {
  const v = judgeDbHealth({ gateway: ok(400), rest: ok(2500), host: host(1, 8) });
  assert.equal(v.status, 'warning');
  assert.match(v.summary, /not under heavy load/);
});

test('reads erroring on an idle server → critical, pointed at PostgREST', () => {
  const v = judgeDbHealth({ gateway: ok(400), rest: { ok: false, ms: 120, timedOut: false, httpStatus: 500 }, host: host(0.5, 8) });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /failing while the database is not under load/);
});

test('low memory alone → warning', () => {
  const v = judgeDbHealth({ gateway: ok(400), rest: ok(200), host: host(0.5, 8, 1, 32) });
  assert.equal(v.status, 'warning');
  assert.match(v.summary, /memory/);
});

test('load unreadable while reads are fine → unknown, never healthy', () => {
  assert.equal(judgeDbHealth({ gateway: ok(400), rest: ok(200), host: null, hostError: 'HTTP 401' }).status, 'unknown');
  assert.equal(judgeDbHealth({ gateway: ok(400), rest: ok(200), host: host(0.5, null) }).status, 'unknown');
});

test('a quiet 2XL on a normal day → healthy', () => {
  const v = judgeDbHealth({ gateway: ok(300), rest: ok(180), host: host(2, 8, 20, 32) });
  assert.equal(v.status, 'healthy');
});

test('the verdict carries numbers only: no labels, no project ref', () => {
  const v = judgeDbHealth({ gateway: ok(518), rest: timedOut(), host: parseDbHostMetrics(metricsText(43.83, 2, 1.03, 4)) });
  const all = [v.summary, ...v.details, ...v.suggestedChecks].join(' ');
  assert.ok(!/supabase_project_ref|service_type|ref"/.test(all));
});
