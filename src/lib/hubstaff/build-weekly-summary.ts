/**
 * Pure transform: Hubstaff API daily activities + users → the same weekly-summary CSV
 * text a manual Hubstaff export produces. The API sync route feeds this text through
 * `replaceHubstaffHoursFromCsvText`, so both ingest paths (CSV upload and live sync)
 * converge on identical column mapping, archiving, and downstream payroll behavior.
 *
 * Day bucketing needs no timezone math here: the `activities/daily` endpoint already
 * aggregates by the ORGANIZATION's timezone date — the same bucketing the manual CSV
 * export uses.
 */
import type { HubstaffDailyActivity, HubstaffUser } from "@/lib/hubstaff/api-client";

/** Marker used in generated filenames so the archive can tell API batches from CSVs. */
export const API_SYNC_FILE_MARKER = "_api_sync_";

/** Matches the existing `YYYY-MM-DD_to_YYYY-MM-DD` period parser and rename lock. */
export function apiSyncFileName(weekStartIso: string, weekEndIso: string): string {
  return `simple-biz${API_SYNC_FILE_MARKER}${weekStartIso}_to_${weekEndIso}.csv`;
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Inclusive ISO date list weekStart..weekEnd (UTC arithmetic — inputs are plain dates). */
export function enumerateIsoDates(startIso: string, endIso: string): string[] {
  if (!isIsoDate(startIso) || !isIsoDate(endIso)) {
    throw new Error("weekStart/weekEnd must be YYYY-MM-DD dates.");
  }
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new Error("weekEnd must be on or after weekStart.");
  }
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days > 14) {
    throw new Error("Sync range too large — pick a single pay week (max 14 days).");
  }
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function toHHMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Builds the weekly-summary CSV text. Emits one row per user with any activity in the
 * range (matching what a Hubstaff time report contains). Users missing from the
 * sideload (e.g. removed members) still get a row — "User <id>" with no email — so
 * their hours are never silently dropped; reconciliation flags them downstream.
 */
export function buildWeeklySummaryCsv(
  users: HubstaffUser[],
  activities: HubstaffDailyActivity[],
  weekStartIso: string,
  weekEndIso: string,
): { csvText: string; rowCount: number } {
  const dayCols = enumerateIsoDates(weekStartIso, weekEndIso);
  const daySet = new Set(dayCols);
  const usersById = new Map(users.map((u) => [u.id, u]));

  type Agg = {
    secondsByDate: Map<string, number>;
    totalTracked: number;
    totalOverall: number;
    hasOverall: boolean;
  };
  const byUser = new Map<number, Agg>();

  for (const a of activities) {
    if (!a || typeof a.user_id !== "number") continue;
    if (!daySet.has(a.date)) continue; // defensive — the API already filters by range
    const tracked = typeof a.tracked === "number" && Number.isFinite(a.tracked) ? a.tracked : 0;
    let agg = byUser.get(a.user_id);
    if (!agg) {
      agg = { secondsByDate: new Map(), totalTracked: 0, totalOverall: 0, hasOverall: false };
      byUser.set(a.user_id, agg);
    }
    agg.secondsByDate.set(a.date, (agg.secondsByDate.get(a.date) ?? 0) + tracked);
    agg.totalTracked += tracked;
    if (typeof a.overall === "number" && Number.isFinite(a.overall)) {
      agg.totalOverall += a.overall;
      agg.hasOverall = true;
    }
  }

  const headers = ["Member", "Email", ...dayCols, "Total worked", "Activity"];
  const rows: string[][] = [];

  for (const [userId, agg] of byUser) {
    const user = usersById.get(userId);
    const activity =
      agg.hasOverall && agg.totalTracked > 0
        ? `${Math.round((agg.totalOverall / agg.totalTracked) * 100)}%`
        : "";
    rows.push([
      user?.name?.trim() || `User ${userId}`,
      user?.email?.trim() || "",
      ...dayCols.map((d) => toHHMMSS(agg.secondsByDate.get(d) ?? 0)),
      toHHMMSS(agg.totalTracked),
      activity,
    ]);
  }

  rows.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));

  const csvText = [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  return { csvText, rowCount: rows.length };
}
