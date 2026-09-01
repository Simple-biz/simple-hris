/** [TERMINATION-DOCS] TEST SUPPORT — the controls for the cycle-timesheet stub.
 *
 * Split out of `./cycle-hours-index-stub.ts` on purpose: that file statically
 * imports the REAL `cycle-hours-index` (for `personWorkedCycle`), which opens
 * `import 'server-only'`. A test file's static imports are resolved BEFORE its
 * first statement runs, so importing the stub directly would try to resolve
 * `server-only` before `installTerminationServerStubs()` had installed the hook.
 * These controls touch nothing but `globalThis`, so a test can import them at
 * the top of the file safely.
 */

const KEY = '__terminationDocsTestCycleHours__';
const CALLS_KEY = '__terminationDocsTestCycleHoursCalls__';

function bag(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

export interface TestCycleHours {
  emails?: string[];
  nameTokenKeys?: string[];
  sourceFile?: string | null;
  /** Set it to prove the fail-closed path: an unreadable timesheet must BLOCK. */
  error?: string | null;
}

/** Declare the cycle timesheet for the next call. `{}` — the default every test
 *  gets — is a HEALTHY, EMPTY timesheet: nobody logged hours, which is the shape
 *  of a real leaver. */
export function setTestCycleHours(index: TestCycleHours | null): void {
  bag()[KEY] = index;
  bag()[CALLS_KEY] = [];
}

export function readTestCycleHours(): TestCycleHours {
  return (bag()[KEY] as TestCycleHours | null | undefined) ?? {};
}

/** Every `sourceFile` argument the code passed, in order. `null` means "the
 *  `is_current` Hubstaff upload", which is the only correct argument here. */
export function testCycleHoursCalls(): Array<string | null> {
  return (bag()[CALLS_KEY] as Array<string | null> | undefined) ?? [];
}

export function recordCycleHoursCall(sourceFile: string | null): void {
  const calls = testCycleHoursCalls();
  calls.push(sourceFile);
  bag()[CALLS_KEY] = calls;
}
