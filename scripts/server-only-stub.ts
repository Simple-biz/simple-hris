/**
 * Empty stand-in for the `server-only` marker import when running server libs
 * OUTSIDE Next.js (scripts/verify-readiness.ts via tsx). Next itself shims
 * `import 'server-only'` at build time — the package isn't installed — so plain
 * Node needs this mapped via tsconfig.readiness-verify.json paths.
 */
export {};
