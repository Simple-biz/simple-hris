'use client';

import React from 'react';
import { PencilRuler, ExternalLink, Copy, Check, Lock } from 'lucide-react';

/**
 * Design & Specifications
 * -----------------------
 * Hosts the design/specifications artifact for the HRIS. The artifact lives on
 * claude.ai, which sends `X-Frame-Options: SAMEORIGIN` — so it CANNOT be embedded
 * in an <iframe> from this origin (the browser refuses the connection). We link
 * out to it instead (opens in a new tab). It's also private to the owner's
 * claude.ai login, so viewers may be prompted to sign in.
 *
 * To point this tab at a new artifact, update ARTIFACT_URL below.
 */
const ARTIFACT_URL = 'https://claude.ai/code/artifact/7a44f6e6-4f7e-419f-8d35-e44e8eed0465';

export default function AdminDesignSpecs() {
  const [copied, setCopied] = React.useState(false);

  const copyUrl = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ARTIFACT_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — the link button still works */
    }
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 bg-gradient-to-b from-zinc-50/80 to-transparent px-4 py-6 sm:px-6 lg:px-8 dark:from-zinc-950/50">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/15 ring-1 ring-orange-500/25">
            <PencilRuler className="h-5 w-5 text-orange-600 dark:text-orange-400" aria-hidden />
          </span>
          Design &amp; Specifications
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          The living design and specifications document for the HRIS — visual standards,
          layout patterns, and interface decisions, kept as a Claude artifact.
        </p>
      </header>

      {/* Document cover */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-900/40">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-orange-500/10 to-transparent" aria-hidden />
        <div className="relative flex flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 sm:py-12">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/15 ring-1 ring-orange-500/25">
            <PencilRuler className="h-8 w-8 text-orange-600 dark:text-orange-400" aria-hidden />
          </span>

          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">
              HRIS Design &amp; Specifications
            </h2>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              Opens the full document in a new tab. It&apos;s hosted on claude.ai, so it
              can&apos;t be shown inside this page — but everything lives one click away.
            </p>
          </div>

          <a
            href={ARTIFACT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 dark:bg-orange-500 dark:hover:bg-orange-400"
          >
            Open Design &amp; Specifications
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>

          {/* URL + copy */}
          <div className="flex w-full max-w-md flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-left font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
              {ARTIFACT_URL}
            </code>
            <button
              type="button"
              onClick={copyUrl}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              aria-label="Copy link"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy link
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Access note */}
      <div className="flex items-start gap-2.5 rounded-xl border border-zinc-200/80 bg-zinc-50/60 px-4 py-3 text-xs leading-relaxed text-zinc-500 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-400">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
        <p>
          The document is private to its owner&apos;s claude.ai account — you may be asked to
          sign in. Share it from the artifact&apos;s own menu on claude.ai to give teammates access.
        </p>
      </div>
    </div>
  );
}
