/** [TERMINATION-DOCS] TEST SUPPORT — make the `server-only` modules loadable.
 *
 * Six functions perform every read and write this feature does, and all six sit
 * behind `import 'server-only'`. `server-only` is a build-time alias Next
 * supplies (there is no such package in `node_modules`), so `npm test` —
 * `node --import tsx --test "src/**\/*.test.ts"` — cannot load those modules at
 * all. That is the whole reason the pure cores were split out, and it is also
 * why the round-1 audit found ZERO behavioural coverage on the queries.
 *
 * This installs a module-resolution hook for the current test process only:
 *   `server-only`                     → an empty module (what Next's own alias is)
 *   `src/lib/supabase/server.ts`      → `./supabase-server-stub`, which hands out the double
 *   `src/lib/payroll/cycle-hours-index.ts` → `./cycle-hours-index-stub`
 *
 * The two module redirects are keyed on the RESOLVED FILE, not on the specifier
 * text, because the same module is imported both as `@/lib/supabase/server` (the
 * termination modules) and as `./server` (`payment-dispatches.ts:1`, which the
 * ending-rate resolver goes through). A specifier-keyed redirect silently missed
 * the second one and the ledger read came back "Supabase client unavailable".
 *
 * NOTHING IS LOOSENED. The production modules keep their `import 'server-only'`
 * line — `termination-guard-map.test.ts` asserts that for all six, and
 * `termination-writeback.test.ts` for two of them. The guard is a bundler guard
 * against client import; a Node test process has no bundler and no client, so
 * supplying the alias Next would have supplied is the harness doing its job, not
 * the guard being weakened. What the redirects DO buy is the safety half: the
 * real `createClient` is never reached, so no test can touch the PRODUCTION
 * service-role credentials in `.env.local`.
 *
 * `node:module`'s `registerHooks` is synchronous and in-thread, so it applies to
 * the CJS require path tsx uses for `.ts` files (an async `register()` loader
 * does NOT — verified). It needs Node >= 22.15; this repo runs Node 24 and the
 * existing PDF tests already require >= 20.12 for `zlib.crc32`. If a runner's
 * Node is older these tests FAIL LOUDLY rather than skipping, which is the only
 * honest outcome for a test that cannot run.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolved from the repo root, the way every other test in this feature
 *  resolves its paths (`process.cwd()`), so it behaves identically under
 *  `npm test` and under a single-file run. */
const ROOT = process.cwd();
const SUPPORT_DIR = path.resolve(ROOT, 'src/lib/documents/termination/test-support');

function href(...segments: string[]): string {
  return pathToFileURL(path.resolve(ROOT, ...segments)).href;
}

/** Windows hands the drive letter back in either case depending on how a path
 *  was built, and a redirect that misses is a silent `null` client. */
function key(url: string): string {
  return url.toLowerCase();
}

const EMPTY_MODULE = pathToFileURL(path.join(SUPPORT_DIR, 'empty-module.cjs')).href;
const SUPABASE_SERVER_STUB = pathToFileURL(path.join(SUPPORT_DIR, 'supabase-server-stub.ts')).href;
const CYCLE_HOURS_STUB = pathToFileURL(path.join(SUPPORT_DIR, 'cycle-hours-index-stub.ts')).href;

/** REAL module file → the stub that stands in for it. */
const REDIRECTS = new Map<string, string>([
  [key(href('src/lib/supabase/server.ts')), SUPABASE_SERVER_STUB],
  // The ONE collaborator that cannot be driven through the client double: it
  // builds its own client from env with `createClient` and fetches the PostgREST
  // spec over raw `fetch`. See `./cycle-hours-index-stub.ts` — the matcher stays
  // real, only the loader is replaced.
  [key(href('src/lib/payroll/cycle-hours-index.ts')), CYCLE_HOURS_STUB],
]);

/** A stub importing the real module it stands in for must NOT be redirected back
 *  to itself. `cycle-hours-index-stub.ts` does exactly that, to keep the real
 *  `personWorkedCycle`. */
const SELF_IMPORTING_STUBS = new Set([key(CYCLE_HOURS_STUB)]);

let installed = false;

/** Idempotent: `registerHooks` stacks, and two copies of the same redirect would
 *  work but would also hide a double install. */
export function installTerminationServerStubs(): void {
  if (installed) return;
  installed = true;
  // Parameter types come from `ResolveHookSync` by contextual typing — spelling
  // them out by hand is how a harness drifts from the runtime's own contract.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'server-only') return { url: EMPTY_MODULE, shortCircuit: true };
      const resolved = nextResolve(specifier, context);
      const parent = context?.parentURL ? key(context.parentURL) : null;
      if (parent && SELF_IMPORTING_STUBS.has(parent)) return resolved;
      const stub = REDIRECTS.get(key(resolved.url));
      return stub ? { ...resolved, url: stub, shortCircuit: true } : resolved;
    },
  });
}

/** The modules this harness exists to reach. Named here so the harness test can
 *  assert each one still declares `server-only` — the redirect must never become
 *  an excuse to drop the marker. */
export const SERVER_ONLY_MODULES = [
  'termination-facts.ts',
  'termination-search.ts',
  'termination-rates.ts',
  'termination-log.ts',
  'termination-writeback.ts',
  // This feature's OWN departure-evidence read — the one with an error channel.
  // It exists BECAUSE `loadOffboardEvidenceByEmail` has none, so it is exactly
  // the module that must never quietly lose its marker and drift back into a
  // shared helper.
  'termination-evidence.ts',
] as const;
