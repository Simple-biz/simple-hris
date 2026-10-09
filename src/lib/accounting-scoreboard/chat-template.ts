/**
 * The words of a scheduled Chat post (Setup → Scheduled Posts). Pure, so the server renders what the editor previews.
 *
 * A template is plain text with ONE placeholder, `{progress}`, which becomes the counts in words: "49 of 97 weekly
 * tasks", or "98 of 170 daily tasks and 13 of 80 weekly tasks" (progressPhrase, the click's own wording). Any other
 * `{…}` is refused when saved: a typo like `{progres}` would otherwise reach the team's Chat as written.
 *
 * The seeded template is the sentence the schedule posted before templates existed, so rendering it gives exactly
 * buildProgressMessage (pinned in the test). The bars card under it is drawn from the counts either way.
 *
 * Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md § The words.
 */

import { progressPhrase } from './chat-summary';
import type { FrequencyProgress } from './tasks';

export const PROGRESS_TOKEN = '{progress}';
export const DEFAULT_POST_TEMPLATE =
  'Current progress: {progress} have been completed. As you complete your tasks, remember to check them off.';
export const TEMPLATE_MAX_LENGTH = 1000;

const TOKEN = /\{[^{}\n]*\}/g;

/** Why a template cannot be saved, or null. Checked by the route and shown by the editor as you type. */
export function templateProblem(template: string): string | null {
  if (!template.trim()) return 'Write the message.';
  if (template.length > TEMPLATE_MAX_LENGTH) return `Keep the message to ${TEMPLATE_MAX_LENGTH.toLocaleString('en-US')} characters.`;
  const unknown = [...new Set((template.match(TOKEN) ?? []).filter((t) => t !== PROGRESS_TOKEN))];
  if (unknown.length) {
    return `${unknown.join(', ')} ${unknown.length === 1 ? "isn't a placeholder" : "aren't placeholders"}. The only one is ${PROGRESS_TOKEN}.`;
  }
  return null;
}

/** The template with every `{progress}` replaced by the counts in words. */
export function renderPostTemplate(template: string, progress: readonly FrequencyProgress[]): string {
  return template.split(PROGRESS_TOKEN).join(progressPhrase(progress));
}
