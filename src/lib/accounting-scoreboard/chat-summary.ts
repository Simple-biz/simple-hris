/**
 * The team's task progress message (plan Task 8, Open item 393): what Copy message copies and Post to Chat posts.
 * Pure. It keeps the wording someone types into the team chat by hand today ("Current progress, 98 out of 170 daily
 * tasks and 13 of 80 weekly tasks have been completed. As you complete your task, remember to check them off").
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § The progress message.
 */

import type { CountedFrequency, FrequencyProgress } from './tasks';

const WORD: Record<CountedFrequency, string> = {
  daily: 'daily',
  weekly: 'weekly',
  biweekly: 'bi-weekly',
  monthly: 'monthly',
  bimonthly: 'bimonthly',
  quarterly: 'quarterly',
  annually: 'annual',
};

export function buildProgressMessage(progress: readonly FrequencyProgress[]): string {
  if (progress.length === 0) return 'No tasks on the board yet.';
  const parts = progress.map((p) => `${p.done} of ${p.total} ${WORD[p.frequency]} tasks`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Current progress: ${list} have been completed. As you complete your tasks, remember to check them off.`;
}
