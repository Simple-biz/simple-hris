/**
 * Shared Monday.com helper for the HRIS board sync. READ + WRITE primitives only — no policy.
 *
 * Every board id, group id, column id and label index is IMPORTED from
 * src/lib/monday/hris-plan.ts. Nothing is redeclared here: the plan file is the single source of
 * truth for board structure, and a second copy of these ids is exactly the drift this skill exists
 * to prevent.
 *
 * Monday's API throws ECONNRESET at random, so every call retries. A daily complexity budget is
 * NOT retryable — it raises DailyLimitExceeded immediately so a blown budget is loud rather than a
 * mysterious hang that eats the verification step.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The plan file is CJS (the repo's package.json has no `"type": "module"`), so a STATIC named import
 * of it from an ESM `.mts` fails module-lexer detection — `does not provide an export named ...`.
 * A dynamic import resolves the named exports correctly, so the interop is done exactly once here
 * and every other script in this skill imports these from `./monday.mts`.
 */
const plan = (await import('../../../../src/lib/monday/hris-plan')) as typeof import('../../../../src/lib/monday/hris-plan');

export const {
  EPIC_COLS,
  EPIC_GROUPS,
  EPIC_STATUS_INDEX,
  HRIS_PROJECT_ITEM_ID,
  MONDAY_BOARDS,
  PLAN_EPICS,
  PLAN_TASKS,
  PROJECT_COLS,
  QUARTER_INDEX,
  TASK_COLS,
  TASK_GROUPS,
  TASK_PRIORITY_INDEX,
  TASK_SPRINT_INDEX,
  TASK_SPRINT_LABELS,
  TASK_SPRINT_WINDOWS,
  taskSprintAttribution,
  TASK_STATUS_INDEX,
  TASK_TYPE_INDEX,
  epicItemName,
  taskItemName,
} = plan;
export type { PlanEpic, PlanTask, TaskStatus, TaskType } from '../../../../src/lib/monday/hris-plan';
/** Keys of TASK_STATUS_INDEX — the statuses the corrector may write. */
type TaskStatusName = keyof typeof TASK_STATUS_INDEX;

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
export const SKILL_DIR = path.resolve(import.meta.dirname, '..');
/** Kane Reroma — confirmed via `query{me{id}}` 2026-08-11. */
export const KANE_USER_ID = 96110050;
const API = 'https://api.monday.com/v2';

export class DailyLimitExceeded extends Error {}

/** Read MONDAY out of .env by hand — no dotenv dependency, and .env.local must not shadow it. */
export function loadToken(): string {
  const envPath = path.join(REPO_ROOT, '.env');
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^MONDAY\s*=/.test(l));
  const token = line?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') ?? '';
  if (!token) throw new Error(`no MONDAY key in ${envPath}`);
  return token;
}

let TOKEN: string | null = null;

export async function gql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  tries = 6,
): Promise<T> {
  TOKEN ??= loadToken();
  let last: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          Authorization: TOKEN,
          'Content-Type': 'application/json',
          'API-Version': '2024-10',
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      const text = await res.text();
      if (/DAILY_LIMIT_EXCEEDED/.test(text)) {
        // Surface everything the response knows about the reset. The old message threw away the body
        // and headers, which is why "when does it refresh?" has never had a measured answer — the
        // budget is only observable at the moment it refuses, so that moment must be recorded.
        const hints = ['retry-after', 'x-ratelimit-reset', 'ratelimit-reset', 'x-ratelimit-remaining']
          .map((h) => [h, res.headers.get(h)] as const)
          .filter(([, v]) => v)
          .map(([h, v]) => `${h}: ${v}`);
        throw new DailyLimitExceeded(
          'Monday daily API budget exhausted. Nothing further will succeed today, INCLUDING ' +
            'read-only verification. Do not report this pass as verified.\n' +
            `  observed at: ${new Date().toISOString()}\n` +
            `  reset hints: ${hints.length ? hints.join(' · ') : '(none in headers)'}\n` +
            `  response:    ${text.slice(0, 400)}`,
        );
      }
      if (res.status === 429 || res.status >= 500) {
        // Monday's rate-limit window is a full minute; short backoff just burns retries.
        last = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        await sleep(res.status === 429 ? 65_000 : 2000 + attempt * 3000);
        continue;
      }
      const body = JSON.parse(text) as { data?: T; errors?: unknown[] };
      if (body.errors?.length) {
        // A GraphQL error is deterministic — retrying the same query cannot fix it.
        throw new Error(`Monday API: ${JSON.stringify(body.errors).slice(0, 600)}`);
      }
      return body.data as T;
    } catch (e) {
      if (e instanceof DailyLimitExceeded) throw e;
      if (e instanceof Error && /^Monday API:/.test(e.message)) throw e;
      last = e; // ECONNRESET etc.
      await sleep(2000 + attempt * 3000);
    }
  }
  throw last instanceof Error ? last : new Error('Monday API unreachable');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BoardItem {
  id: string;
  name: string;
  groupId: string;
  groupTitle: string;
  cols: Record<string, string>;
  linked: Record<string, string[]>;
}

/**
 * Every item on a board, asking for ONLY the named columns. Pulling all ~21 columns across the
 * ~1,950 items on Sprint Tasks is the single most expensive thing these scripts can do and is what
 * exhausts the daily budget — always pass the shortest column list that answers the question.
 */
export async function listBoardItems(boardId: string, colIds: string[]): Promise<BoardItem[]> {
  const out: BoardItem[] = [];
  let cursor: string | null = null;
  do {
    const d = await gql<{
      boards: {
        items_page: {
          cursor: string | null;
          items: {
            id: string;
            name: string;
            group: { id: string; title: string };
            column_values: { id: string; text: string | null; linked_item_ids?: string[] }[];
          }[];
        };
      }[];
    }>(
      `query($b:[ID!],$c:String,$cols:[String!]){boards(ids:$b){items_page(limit:250,cursor:$c){cursor items{id name group{id title}
         column_values(ids:$cols){id text ... on BoardRelationValue{linked_item_ids}}}}}}`,
      { b: [boardId], c: cursor, cols: colIds },
    );
    const page = d.boards[0]?.items_page;
    if (!page) break;
    for (const it of page.items) out.push(toItem(it));
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** `items(ids:)` silently caps at 25 — ask for 40 and get 25 back with no error. Always batch. */
export async function getItemsByIds(ids: string[], colIds: string[]): Promise<BoardItem[]> {
  const out: BoardItem[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const d = await gql<{
      items: {
        id: string;
        name: string;
        group: { id: string; title: string };
        column_values: { id: string; text: string | null; linked_item_ids?: string[] }[];
      }[];
    }>(
      `query($ids:[ID!],$cols:[String!]){items(ids:$ids,limit:100){id name group{id title}
         column_values(ids:$cols){id text ... on BoardRelationValue{linked_item_ids}}}}`,
      { ids: ids.slice(i, i + 25), cols: colIds },
    );
    for (const it of d.items) out.push(toItem(it));
  }
  return out;
}

function toItem(it: {
  id: string;
  name: string;
  group: { id: string; title: string };
  column_values: { id: string; text: string | null; linked_item_ids?: string[] }[];
}): BoardItem {
  const cols: Record<string, string> = {};
  const linked: Record<string, string[]> = {};
  for (const c of it.column_values) {
    cols[c.id] = c.text ?? '';
    // Board relations return an EMPTY `text` — the ids only come from linked_item_ids.
    if (c.linked_item_ids) linked[c.id] = c.linked_item_ids.map(String);
  }
  return { id: it.id, name: it.name, groupId: it.group.id, groupTitle: it.group.title, cols, linked };
}

/** Re-query groups every pass. A cached list goes stale — Sprint 26 was missing from the old notes. */
export async function boardGroups(boardId: string): Promise<{ id: string; title: string }[]> {
  const d = await gql<{ boards: { groups: { id: string; title: string }[] }[] }>(
    `query($b:[ID!]){boards(ids:$b){groups{id title}}}`,
    { b: [boardId] },
  );
  return d.boards[0]?.groups ?? [];
}

/** Live label index → text for one status-type column. */
export async function columnLabels(boardId: string, columnId: string): Promise<Record<string, string>> {
  const d = await gql<{ boards: { columns: { id: string; settings_str: string }[] }[] }>(
    `query($b:[ID!],$c:[String!]){boards(ids:$b){columns(ids:$c){id settings_str}}}`,
    { b: [boardId], c: [columnId] },
  );
  const raw = JSON.parse(d.boards[0]?.columns[0]?.settings_str || '{}') as {
    labels?: Record<string, string | { name: string }>;
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.labels ?? {})) out[k] = typeof v === 'object' ? v.name : v;
  return out;
}

/**
 * The board is structure-locked: the API cannot add a Status/Sprint/Type label
 * (`create_labels_if_missing:true` returns 403 even when nothing is missing). So every index this
 * skill is about to write must already exist. Throws with the drift spelled out.
 */
export async function assertLabelsUnchanged(): Promise<void> {
  const problems: string[] = [];
  const checks: [string, Record<string, number>][] = [
    [TASK_COLS.status, TASK_STATUS_INDEX],
    [TASK_COLS.type, TASK_TYPE_INDEX],
  ];
  for (const [colId, expected] of checks) {
    const live = await columnLabels(MONDAY_BOARDS.tasks, colId);
    for (const [name, index] of Object.entries(expected)) {
      if (live[String(index)] !== name) {
        problems.push(`${colId}: expected index ${index} = "${name}", board has "${live[String(index)] ?? '(missing)'}"`);
      }
    }
  }
  const sprintLive = await columnLabels(MONDAY_BOARDS.tasks, TASK_COLS.sprint);
  for (const [key, label] of Object.entries(TASK_SPRINT_LABELS)) {
    if (!Object.values(sprintLive).includes(label)) {
      problems.push(`sprint label "${label}" (${key}) no longer exists on the board`);
    }
  }
  if (problems.length) {
    throw new Error(
      `Board labels have drifted from hris-plan.ts — refusing to write:\n  ${problems.join('\n  ')}\n` +
        `The board is structure-locked, so labels are added on the board by hand, then mirrored here.`,
    );
  }
}

// ── mutations ────────────────────────────────────────────────────────────────────────────────────
// create_labels_if_missing is ALWAYS false. `true` returns 403 UserUnauthorizedException on this
// board even when no label is missing.
export const M_SET_COLS = `mutation($board:ID!,$item:ID!,$vals:JSON!){
  change_multiple_column_values(board_id:$board,item_id:$item,column_values:$vals,
    create_labels_if_missing:false){id}}`;
export const M_POST_UPDATE = `mutation($item:ID!,$body:String!){create_update(item_id:$item,body:$body){id}}`;

export async function setColumns(boardId: string, itemId: string, vals: Record<string, unknown>) {
  await gql(M_SET_COLS, { board: boardId, item: String(itemId), vals: JSON.stringify(vals) });
}

export async function postUpdate(itemId: string, body: string) {
  await gql(M_POST_UPDATE, { item: String(itemId), body });
}

export const M_CREATE_ITEM = `mutation($board:ID!,$group:String!,$name:String!,$vals:JSON!){
  create_item(board_id:$board,group_id:$group,item_name:$name,column_values:$vals,
    create_labels_if_missing:false){id}}`;

/**
 * ONE exact-name lookup instead of paging all ~2,300 items. Returns every id that carries the name,
 * because duplicates are a real hazard on this board — the reconciler's Map silently keeps the last
 * one, so a caller that picked arbitrarily could write to the row nobody reads. Callers must refuse
 * an ambiguous result rather than guess.
 *
 * `items_page_by_column_values` matches the "name" pseudo-column EXACTLY, which is the same
 * byte-exact rule sync.ts uses — no trim, no case fold, no unicode normalisation.
 */
export async function findItemIdsByExactName(boardId: string, name: string): Promise<string[]> {
  const d = await gql<{ items_page_by_column_values: { items: { id: string; name: string }[] } }>(
    `query($b:ID!,$n:String!){items_page_by_column_values(board_id:$b,limit:50,
       columns:[{column_id:"name",column_values:[$n]}]){items{id name}}}`,
    { b: boardId, n: name },
  );
  // The API can match loosely on some column types — re-assert byte-exactness locally so a
  // near-miss can never be mistaken for the row we meant.
  return (d.items_page_by_column_values?.items ?? []).filter((i) => i.name === name).map((i) => i.id);
}

/** Creates one item with its columns in a single call. Never writes a board relation — those are
 *  full-set overwrites owned by the reconciler (see sync.ts). */
export async function createItem(
  boardId: string,
  groupId: string,
  name: string,
  vals: Record<string, unknown>,
): Promise<string> {
  const d = await gql<{ create_item: { id: string } }>(M_CREATE_ITEM, {
    board: boardId,
    group: groupId,
    name,
    vals: JSON.stringify(vals),
  });
  return d.create_item.id;
}

// ── name filters ─────────────────────────────────────────────────────────────────────────────────
// The boards are SHARED with other teams: Sprint Tasks holds ~1,950 items and Roadmap & Epics 212,
// of which 175 are not ours. A group listing is mostly not our work — always filter by name.
export const isOurTask = (name: string) => name.startsWith('[HRIS] ');
export const isOurEpic = (name: string) => /^HRIS-\d/.test(name);

/**
 * Names are matched byte-exact by the reconciler (sync.ts builds `new Map(items.map(i => [i.name, i]))`
 * with no trim, no case folding, no unicode normalisation). Plan names legitimately contain
 * em-dashes, curly quotes, ₱, →, ⊕, ⇄, ≈, × and an en-dash inside "Sun–Sat" — NEVER normalise them.
 * Angle brackets are the one hard ban: Monday strips HTML tags from item names on create, so the
 * stored name would differ from the sent name and the sync would recreate the row forever.
 */
export function assertNameIsSafe(name: string): void {
  if (/[<>]/.test(name)) {
    throw new Error(`item name contains angle brackets — Monday strips tags on create: ${name}`);
  }
  if (name !== name.trim()) throw new Error(`item name has leading/trailing whitespace: ${JSON.stringify(name)}`);
}

/**
 * The execution-state payload for ONE row — used by ALL write paths (full apply,
 * --only-new, and the pending-SP flush) so the rule cannot drift between them.
 *
 * Actual SP and Completed Date are a RECORD of shipped work, so they accompany Done
 * and nothing else. On a row moving OFF Done they are actively CLEARED rather than
 * left behind: a Pending Deploy row still carrying an Actual SP is precisely the
 * phantom verify.mts sweeps for. Actual SP is never invented — it is always the
 * plan's own `sp`, the identical value the create path writes.
 *
 * Lives here rather than in apply.mts because apply.mts RUNS a pass at import time;
 * anything that needs this rule must be able to import it without triggering one.
 */
export function correctionValues(
  row: { status: TaskStatusName; completed?: string },
  planSp: number,
): Record<string, unknown> {
  const done = row.status === 'Done';
  return {
    [TASK_COLS.status]: { index: TASK_STATUS_INDEX[row.status] },
    [TASK_COLS.actualSp]: done ? String(planSp) : '',
    [TASK_COLS.completed]: done && row.completed ? { date: row.completed } : '',
  };
}

/** Stable hash of a proposal, so an approval can be bound to exactly what was shown. */
export const proposalHash = (payload: unknown) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);

export const PROPOSAL_PATH = path.join(SKILL_DIR, 'proposal.json');

/** A single writer at a time. This checkout is shared between sessions and POST is unguarded. */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = path.join(SKILL_DIR, '.apply.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error(`another apply is running (${lock} exists). Delete it only if that is stale.`);
  }
  return fn().finally(() => {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  });
}
