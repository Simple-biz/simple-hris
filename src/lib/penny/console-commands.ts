/**
 * Console commands — input the Admin Penny console handles ITSELF instead of
 * sending to the model.
 *
 * The failure this file exists to prevent is swallowing a real question. Penny
 * costs a model call and an audit row per prompt, but a question that silently
 * does nothing is worse than a wasted call: the admin retypes it, or worse,
 * believes it was answered. So the matcher is deliberately strict —
 * whole-input, exact, case-insensitive, nothing else — and
 * `console-commands.test.ts` pins the near-misses that must still reach Penny.
 *
 * `resolveConsoleCommand` returns null for anything it does not own, and the
 * caller sends that to Penny unchanged. A `/`-prefixed word that is NOT a
 * command is also passed through rather than rejected: refusing unknown slash
 * input would mean guessing which of an admin's phrasings were meant as
 * commands.
 */

export type ConsoleCommand = 'clear';

/** What each command's row says in the prompt hint. */
export const CONSOLE_COMMAND_HINTS: { command: string; describes: string }[] = [
  { command: '/clear', describes: 'wipe the screen and start a new session' },
];

/**
 * The exact strings that invoke each command. Slash-prefixed only: `clear` on
 * its own is a plausible (if terse) thing to ask Penny about a payroll note or
 * a dispute, and stealing it would be a silent failure of the kind described
 * above. Add a bare alias only if Kane asks for one.
 */
const COMMANDS: Record<ConsoleCommand, readonly string[]> = {
  clear: ['/clear'],
};

export function resolveConsoleCommand(input: string): ConsoleCommand | null {
  const key = input.trim().toLowerCase();
  if (!key.startsWith('/')) return null;

  for (const [command, aliases] of Object.entries(COMMANDS) as [
    ConsoleCommand,
    readonly string[],
  ][]) {
    if (aliases.includes(key)) return command;
  }
  return null;
}
