/**
 * What belongs in Employee Support, and what gets pointed somewhere else.
 *
 * Carla's Decision 4 (2026-09-15) carried two routing rules alongside the
 * category list:
 *
 *   "Time adjustments should be restricted. They should only ask about
 *    timeadjustments that have been approved. They shouldn't be able to request
 *    an adjustment through the support channels. Similar to questions about
 *    schedules/time-off, this is a manager question."
 *
 * NOTHING HERE REFUSES A TICKET.
 * ---------------------------------------------------------------------------
 * The steer is copy, shown before the person types, not a guard that rejects
 * what they wrote. That is a deliberate default and it is reversible: making it
 * a refusal means looking up whether the filer actually has an approved
 * adjustment on record, which is a real query, a real failure mode, and a real
 * decision about what happens when the lookup is wrong. Until someone rules on
 * that, an employee who files in the wrong place gets an answer and a pointer,
 * which is what they would have got from a person.
 *
 * The practical reason the soft version is enough: support is staffed by five
 * named people who can say "ask your manager" in one line. The cost of a
 * misfiled ticket is one reply. The cost of a wrong refusal is an employee who
 * cannot ask anyone.
 */

import type { SupportCategory } from './types';

export type SupportSteer =
  | { kind: 'accept' }
  | { kind: 'accept_with_notice'; notice: string };

/**
 * Shown under the category picker the moment a category is chosen, so the
 * person reads it BEFORE writing rather than after being told off.
 */
export function steerForCategory(category: SupportCategory): SupportSteer {
  if (category === 'hours_time_adjustment') {
    return {
      kind: 'accept_with_notice',
      notice:
        'Use this to ask about a time adjustment that has already been approved. ' +
        'To request a new one, file it from My Hours — your manager approves it there, ' +
        'and support cannot approve one for you.',
    };
  }
  return { kind: 'accept' };
}

/**
 * Subjects that have no category because they are not ours to answer. Rendered
 * once on the form, not attached to any single category, because someone
 * heading for "Something else" is exactly who needs to read it.
 *
 * These are statements about who decides, not about who may ask. Support will
 * still answer a question that arrives here; it just cannot be the thing that
 * changes the answer.
 */
export const STEERED_SUBJECTS: readonly { subject: string; goesTo: string }[] = [
  { subject: 'Requesting a time adjustment', goesTo: 'My Hours, then your manager' },
  { subject: 'Your schedule', goesTo: 'your manager' },
  { subject: 'Time off and leave', goesTo: 'your manager' },
];

/**
 * One sentence for the form, built from the list above so the list is the only
 * place a subject is added or removed.
 */
export function describeSteeredSubjects(): string {
  const subjects = STEERED_SUBJECTS.map((s) => s.subject.toLowerCase());
  const last = subjects[subjects.length - 1];
  const head = subjects.slice(0, -1).join(', ');
  return `${head} and ${last} are decided by your manager, not by support — but ask here if you are not sure who to go to.`;
}
