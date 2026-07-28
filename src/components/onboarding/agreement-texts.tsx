// Single source of truth for RENDERING the legal copy a hiree agrees to during
// onboarding. Rendered both on the public onboarding form (where the hiree
// signs) and in the HR submission-detail modal (where HR reviews what was
// signed). The copy itself lives in plain data modules
// (src/lib/onboarding/ip-assignment-text.ts + agreement-copy.ts) shared with
// the PDF generators, so the on-screen text and the downloadable documents
// stay byte-for-byte identical — edit the copy there, never inline it here.

import {
  IP_ASSIGNMENT_INTRO,
  IP_ASSIGNMENT_SECTIONS,
} from '@/lib/onboarding/ip-assignment-text';
import {
  CONTRACT_WORKER_SECTIONS,
  NON_SOLICITATION_PARAGRAPHS,
  PRIVACY_PARAGRAPHS,
} from '@/lib/onboarding/agreement-copy';

export { AGREEMENT_TITLES } from '@/lib/onboarding/agreement-copy';

const proseClass = 'space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300';

/**
 * Intellectual Property Assignment, Talent Release, and Copyright Waiver.
 * Rendered from the shared data module so this React copy and the server-side
 * PDF generator stay byte-for-byte identical.
 */
export function IntellectualPropertyText() {
  return (
    <article className={proseClass}>
      {IP_ASSIGNMENT_INTRO.map((p, i) => (
        <p key={`intro-${i}`}>{p}</p>
      ))}
      {IP_ASSIGNMENT_SECTIONS.map((section) => (
        <section key={section.heading}>
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{section.heading}</h3>
          {section.paragraphs.map((p, i) => (
            <p key={i} className={i > 0 ? 'mt-2' : undefined}>
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}

export function NonSolicitationText() {
  return (
    <div className={proseClass}>
      {NON_SOLICITATION_PARAGRAPHS.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

export function PrivacyText() {
  return (
    <div className={proseClass}>
      {PRIVACY_PARAGRAPHS.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

export function ContractWorkerText() {
  return (
    <article className={proseClass}>
      {CONTRACT_WORKER_SECTIONS.map((section) => (
        <section key={section.heading}>
          <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{section.heading}</h3>
          {section.paragraphs.map((p, i) => (
            <p key={i} className={i > 0 ? 'mt-2' : undefined}>
              {p}
            </p>
          ))}
          {section.bullets && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {section.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </article>
  );
}
