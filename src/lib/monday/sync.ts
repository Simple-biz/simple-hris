/**
 * Monday.com board reconciler for the Simple HRIS project.
 *
 * Server-only (uses the MONDAY API token from env). Reconciles the live boards
 * against the plan in ./hris-plan:
 *   • epics / tasks missing on the board → created with full column values
 *   • existing items → STRUCTURE patched (SP, type, sprint, quarter, priority,
 *     epic + project relations). Status and Actual SP are never overwritten —
 *     the board owns execution state.
 *   • project rollup refreshed: Total SP = Σ plan Epic SP; SP Completed =
 *     Σ Epic SP of epics whose LIVE board status is Shipped.
 *   • every epic's Linked Tasks and the project's Sprint Tasks relations are
 *     re-pointed (connect columns are one-way — both sides must be written).
 */

import {
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
  TASK_STATUS_DONE,
  TASK_STATUS_READY,
  TASK_TYPE_INDEX,
  epicItemName,
  taskItemName,
} from './hris-plan';

const API = 'https://api.monday.com/v2';

export interface SyncReport {
  dryRun: boolean;
  epicsCreated: string[];
  epicsUpdated: number;
  tasksCreated: string[];
  tasksUpdated: number;
  projectTotalSp: number;
  projectCompletedSp: number;
  warnings: string[];
}

interface BoardItem {
  id: string;
  name: string;
  statusText: string | null;
}

function token(): string {
  const t = (process.env.MONDAY ?? '').trim();
  if (!t) throw new Error('MONDAY API token is not configured on the server');
  return t;
}

async function gql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          Authorization: token(),
          'Content-Type': 'application/json',
          'API-Version': '2024-10',
        },
        body: JSON.stringify({ query, variables }),
        cache: 'no-store',
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Monday API HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      const body = (await res.json()) as { data?: T; errors?: unknown[] };
      if (body.errors?.length) {
        throw new Error(`Monday API: ${JSON.stringify(body.errors).slice(0, 400)}`);
      }
      return body.data as T;
    } catch (e) {
      // network-level failure (ECONNRESET etc.) — retry with backoff
      if (e instanceof Error && /Monday API:/.test(e.message)) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Monday API unreachable');
}

/** All items on a board with the given status column's text (paginated). */
async function listItems(boardId: string, statusColumnId: string): Promise<BoardItem[]> {
  const items: BoardItem[] = [];
  let cursor: string | null = null;
  do {
    const data = await gql<{
      boards: {
        items_page: {
          cursor: string | null;
          items: { id: string; name: string; column_values: { id: string; text: string | null }[] }[];
        };
      }[];
    }>(
      `query($b:[ID!],$c:String,$col:[String!]){boards(ids:$b){items_page(limit:500,cursor:$c){cursor items{id name column_values(ids:$col){id text}}}}}`,
      { b: [boardId], c: cursor, col: [statusColumnId] },
    );
    const page = data.boards[0]?.items_page;
    if (!page) break;
    for (const it of page.items) {
      items.push({ id: it.id, name: it.name, statusText: it.column_values[0]?.text ?? null });
    }
    cursor = page.cursor;
  } while (cursor);
  return items;
}

const M_CREATE = `mutation($board:ID!,$group:String,$name:String!,$cols:JSON){create_item(board_id:$board,group_id:$group,item_name:$name,column_values:$cols){id}}`;
const M_UPDATE = `mutation($board:ID!,$item:ID!,$cols:JSON!){change_multiple_column_values(board_id:$board,item_id:$item,column_values:$cols){id}}`;

/** Run promise factories with bounded concurrency (Monday tolerates ~6 well). */
async function pool<T>(jobs: (() => Promise<T>)[], size = 5): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function syncHrisBoard(opts: { dryRun?: boolean; ownerId?: number }): Promise<SyncReport> {
  const dryRun = opts.dryRun ?? false;
  const report: SyncReport = {
    dryRun,
    epicsCreated: [],
    epicsUpdated: 0,
    tasksCreated: [],
    tasksUpdated: 0,
    projectTotalSp: 0,
    projectCompletedSp: 0,
    warnings: [],
  };

  // Owner for newly created items — default to the token's user.
  let ownerId = opts.ownerId ?? 0;
  if (!ownerId) {
    const me = await gql<{ me: { id: string } }>(`query{me{id}}`);
    ownerId = Number(me.me.id);
  }
  const ownerValue = { personsAndTeams: [{ id: ownerId, kind: 'person' }] };

  const [liveEpics, liveTasks] = await Promise.all([
    listItems(MONDAY_BOARDS.epics, EPIC_COLS.status),
    listItems(MONDAY_BOARDS.tasks, TASK_COLS.status),
  ]);
  const epicByName = new Map(liveEpics.map((e) => [e.name, e]));
  const taskByName = new Map(liveTasks.map((t) => [t.name, t]));

  // ── epics: create missing / patch structure ────────────────────────────────
  const epicIdByCode = new Map<string, string>();
  const epicCreateJobs: (() => Promise<void>)[] = [];
  const epicUpdateJobs: (() => Promise<void>)[] = [];

  for (const epic of PLAN_EPICS) {
    const name = epicItemName(epic);
    const live = epicByName.get(name);
    if (live) {
      epicIdByCode.set(epic.code, live.id);
      const cols = JSON.stringify({
        [EPIC_COLS.sp]: String(epic.sp),
        [EPIC_COLS.quarter]: { index: QUARTER_INDEX[epic.quarter] },
        [EPIC_COLS.project]: { item_ids: [Number(HRIS_PROJECT_ITEM_ID)] },
      });
      epicUpdateJobs.push(async () => {
        await gql(M_UPDATE, { board: MONDAY_BOARDS.epics, item: live.id, cols });
      });
    } else {
      report.epicsCreated.push(epic.code);
      const cols = JSON.stringify({
        [EPIC_COLS.owner]: ownerValue,
        [EPIC_COLS.status]: { index: EPIC_STATUS_INDEX[epic.status] },
        [EPIC_COLS.quarter]: { index: QUARTER_INDEX[epic.quarter] },
        [EPIC_COLS.sp]: String(epic.sp),
        [EPIC_COLS.project]: { item_ids: [Number(HRIS_PROJECT_ITEM_ID)] },
      });
      epicCreateJobs.push(async () => {
        const d = await gql<{ create_item: { id: string } }>(M_CREATE, {
          board: MONDAY_BOARDS.epics,
          group: EPIC_GROUPS[epic.quarter],
          name,
          cols,
        });
        epicIdByCode.set(epic.code, d.create_item.id);
      });
    }
  }

  if (!dryRun) {
    await pool(epicCreateJobs);
    await pool(epicUpdateJobs);
    report.epicsUpdated = epicUpdateJobs.length;
  }

  // ── tasks: create missing / patch structure ────────────────────────────────
  const taskCreateJobs: (() => Promise<void>)[] = [];
  const taskUpdateJobs: (() => Promise<void>)[] = [];
  const taskIdsByEpic = new Map<string, number[]>();
  const allTaskIds: number[] = [];

  for (const task of PLAN_TASKS) {
    const name = taskItemName(task);
    const live = taskByName.get(name);
    const epicId = epicIdByCode.get(task.epic);
    if (!epicId && !dryRun) {
      report.warnings.push(`No epic on the board for ${task.epic} — task "${task.name}" left unlinked`);
    }
    const relationCols: Record<string, unknown> = {
      [TASK_COLS.project]: { item_ids: [Number(HRIS_PROJECT_ITEM_ID)] },
      ...(epicId ? { [TASK_COLS.epic]: { item_ids: [Number(epicId)] } } : {}),
    };
    if (live) {
      allTaskIds.push(Number(live.id));
      if (epicId) {
        const list = taskIdsByEpic.get(task.epic) ?? [];
        list.push(Number(live.id));
        taskIdsByEpic.set(task.epic, list);
      }
      const cols = JSON.stringify({
        [TASK_COLS.type]: { index: TASK_TYPE_INDEX[task.type] },
        [TASK_COLS.estimatedSp]: String(task.sp),
        [TASK_COLS.sprint]: { index: TASK_SPRINT_INDEX[task.sprint] },
        ...(task.priority ? { [TASK_COLS.priority]: { index: TASK_PRIORITY_INDEX[task.priority] } } : {}),
        ...relationCols,
      });
      taskUpdateJobs.push(async () => {
        await gql(M_UPDATE, { board: MONDAY_BOARDS.tasks, item: live.id, cols });
      });
    } else {
      report.tasksCreated.push(task.name);
      const cols = JSON.stringify({
        [TASK_COLS.owner]: ownerValue,
        [TASK_COLS.type]: { index: TASK_TYPE_INDEX[task.type] },
        [TASK_COLS.status]: { index: task.done ? TASK_STATUS_DONE : TASK_STATUS_READY },
        [TASK_COLS.estimatedSp]: String(task.sp),
        ...(task.done ? { [TASK_COLS.actualSp]: String(task.sp) } : {}),
        [TASK_COLS.sprint]: { index: TASK_SPRINT_INDEX[task.sprint] },
        ...(task.priority ? { [TASK_COLS.priority]: { index: TASK_PRIORITY_INDEX[task.priority] } } : {}),
        ...relationCols,
      });
      taskCreateJobs.push(async () => {
        const d = await gql<{ create_item: { id: string } }>(M_CREATE, {
          board: MONDAY_BOARDS.tasks,
          group: TASK_GROUPS[task.sprint],
          name,
          cols,
        });
        allTaskIds.push(Number(d.create_item.id));
        if (epicId) {
          const list = taskIdsByEpic.get(task.epic) ?? [];
          list.push(Number(d.create_item.id));
          taskIdsByEpic.set(task.epic, list);
        }
      });
    }
  }

  if (!dryRun) {
    await pool(taskCreateJobs);
    await pool(taskUpdateJobs);
    report.tasksUpdated = taskUpdateJobs.length;
  }

  // ── relations: epics' Linked Tasks + project's Sprint Tasks ────────────────
  if (!dryRun) {
    const linkJobs: (() => Promise<void>)[] = [];
    for (const [code, ids] of taskIdsByEpic) {
      const epicId = epicIdByCode.get(code);
      if (!epicId || ids.length === 0) continue;
      const cols = JSON.stringify({ [EPIC_COLS.linkedTasks]: { item_ids: ids } });
      linkJobs.push(async () => {
        await gql(M_UPDATE, { board: MONDAY_BOARDS.epics, item: epicId, cols });
      });
    }
    await pool(linkJobs);
  }

  // ── project rollup ─────────────────────────────────────────────────────────
  // Total = Σ plan Epic SP. Completed = Σ Epic SP where the LIVE board status is
  // Shipped (falling back to the plan status for epics created this run).
  report.projectTotalSp = PLAN_EPICS.reduce((a, e) => a + e.sp, 0);
  report.projectCompletedSp = PLAN_EPICS.reduce((a, e) => {
    const live = epicByName.get(epicItemName(e));
    const status = live ? live.statusText : e.status;
    return status === 'Shipped' ? a + e.sp : a;
  }, 0);

  if (!dryRun) {
    await gql(M_UPDATE, {
      board: MONDAY_BOARDS.projects,
      item: HRIS_PROJECT_ITEM_ID,
      cols: JSON.stringify({
        [PROJECT_COLS.status]: { index: 4 }, // Live
        [PROJECT_COLS.totalSp]: String(report.projectTotalSp),
        [PROJECT_COLS.spCompleted]: String(report.projectCompletedSp),
        ...(allTaskIds.length ? { [PROJECT_COLS.sprintTasks]: { item_ids: allTaskIds } } : {}),
      }),
    });
  }

  return report;
}
