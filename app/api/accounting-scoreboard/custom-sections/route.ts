import { after } from 'next/server';
import {
  badRequest,
  crashResponse,
  createCustomSection,
  failureResponse,
  okResponse,
  patchCustomSection,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { announceScoreboardChange } from '@/lib/accounting-scoreboard/live-server';
import { parseCustomSectionCreate, parseCustomSectionPatch } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST  /api/accounting-scoreboard/custom-sections
 *       { title, kind: 'daily' | 'am_pm', goal?, goalDirection?: 'at_least' | 'below', hostSectionKey? }   (Admins)
 * PATCH /api/accounting-scoreboard/custom-sections
 *       { id, title?, enabled?, showOnOverview?, goal? (null clears), goalDirection?, hostSectionKey? (null = own tab), archived?: true }
 *
 * Carla, 2026-10-02: "Add a button to create new sections". A custom section gets a tab and an
 * Overview card of its own, or (Carla, 2026-10-07) is shown inside a built-in section's tab
 * (`hostSectionKey`, e.g. 'onboarding'), keeping its Overview card. `showOnOverview: false` (Carla,
 * 2026-10-07) takes that card off the Overview and out of the Team Score. Its rows are added under Setup →
 * Rows like any section, and its numbers are typed into its grid (PUT /entries). An AM/PM section is
 * scored like Accounting Buckets (0–10, goal "at least"); a one-number-a-day section totals its week.
 * Archived, never deleted.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseCustomSectionCreate(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await createCustomSection(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('setup', req));
    return okResponse({ section: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseCustomSectionPatch(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await patchCustomSection(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('setup', req));
    return okResponse({ section: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
