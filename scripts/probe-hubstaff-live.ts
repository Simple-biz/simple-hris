/**
 * Diagnostic probe for the live Hubstaff API integration. Exercises the EXACT
 * production code path (token exchange + rotation persistence + daily activities)
 * and prints only metadata — never tokens or full emails.
 *
 * Run: node --env-file=.env.local --import tsx scripts/probe-hubstaff-live.ts
 */
import {
  fetchDailyActivities,
  getHubstaffAccessToken,
  getHubstaffOrgId,
  hubstaffApiConfigured,
} from "../src/lib/hubstaff/api-client";

function mask(email: string | null): string {
  if (!email) return "(no email)";
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}***@${domain ?? "?"}`;
}

async function main() {
  console.log("configured:", hubstaffApiConfigured(), "orgId:", getHubstaffOrgId());
  if (!hubstaffApiConfigured()) {
    console.log("HUBSTAFF_PAT set:", Boolean(process.env.HUBSTAFF_PAT?.trim()));
    return;
  }

  const token = await getHubstaffAccessToken();
  console.log("access token obtained, length:", token.length);

  const DAY = 86_400_000;
  const iso = (off: number) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
  const start = iso(-13);
  const stop = iso(1);
  console.log("range:", start, "→", stop);

  const { activities, users } = await fetchDailyActivities(getHubstaffOrgId()!, start, stop);
  console.log("activities:", activities.length, "| users sideloaded:", users.length);
  console.log("users with email:", users.filter((u) => u.email).length);
  console.log("sample users:", users.slice(0, 3).map((u) => `${u.id}:${mask(u.email)}`));

  if (activities.length > 0) {
    const a = activities[0];
    console.log("first activity keys:", Object.keys(a as unknown as Record<string, unknown>));
    const byDate = new Map<string, number>();
    for (const act of activities) {
      byDate.set(act.date, (byDate.get(act.date) ?? 0) + (act.tracked ?? 0));
    }
    console.log(
      "org totals by date:",
      [...byDate.entries()].sort().map(([d, s]) => `${d}=${(s / 3600).toFixed(1)}h`).join(", "),
    );
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
