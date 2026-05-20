// Single source of truth for the legal copy a hiree agrees to during
// onboarding. Rendered both on the public onboarding form (where the hiree
// signs) and in the HR submission-detail modal (where HR reviews what was
// signed). Keep these in sync by editing here only — never inline the text
// at a call site.

export const AGREEMENT_TITLES = {
  nonSolicitation: 'Non-Solicitation of Employees',
  privacy: 'Privacy Agreement',
  contract: 'Contract Worker Agreement',
} as const;

const proseClass = 'space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300';

export function NonSolicitationText() {
  return (
    <div className={proseClass}>
      <p>
        You agree not to hire, offer work to, or try to hire any employee or contractor of
        our company while you are working with us, or for one year after your work with us
        ends.
      </p>
      <p>
        This includes not asking anyone who works with us to leave their job, or to stop
        working with us in any way.
      </p>
    </div>
  );
}

export function PrivacyText() {
  return (
    <div className={proseClass}>
      <p>
        For the protection of yourself and the company, we ask that you do not include the
        name &quot;Simple.biz&quot; in any profiles, posts, video or the like on any social media
        platform. This is including but not limited to LinkedIn, Facebook, Instagram, etc...
        Instead, we recommend that you put &quot;Company Confidential&quot; or &quot;Web Design Firm&quot; when
        the need arises.
      </p>
    </div>
  );
}

export function ContractWorkerText() {
  return (
    <article className={proseClass}>
      <section>
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Effective Date</h3>
        <p>
          This Agreement will take place effective immediately and will remain in effect until
          voluntarily terminated by either Company or Contractor.
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Payment</h3>
        <p>Contractor will be paid as follows: for services as Company deems needed.</p>
      </section>

      <section>
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Expenses</h3>
        <p>
          Contractor will be responsible for all expenses incurred while performing services
          under this Agreement.
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Independent Contractor Status</h3>
        <p>
          Contractor is an independent contractor, and neither Contractor, nor Contractor&apos;s
          employees, or contract personnel is, or will be deemed, Company&apos;s employees. In its
          capacity as independent contractor, Contractor agrees and represents, and Company
          agrees as follows:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Contractor has the right to perform services for others during the term of this
            Agreement. However, Contractor agrees to not perform &quot;side work&quot; for any of Company&apos;s
            clients or referrals from Company&apos;s clients, as this represents an actionable breach
            of confidentiality.
          </li>
          <li>
            Contractor has the sole right to control and direct the means, manner, and method by
            which the services required by this Agreement will be performed.
          </li>
          <li>
            Contractor has the right to perform the services required by the Agreement at any
            place or location and at such times as Contractor may determine.
          </li>
          <li>
            Contractor will furnish all equipment and materials used to provide the services
            required by this Agreement.
          </li>
          <li>
            Contractor will not receive any training from Company in the professional skills
            necessary to perform the services required by this Agreement.
          </li>
          <li>
            Contractor will not withhold from Contractor&apos;s compensation any amount that would
            normally be withheld from an employee&apos;s pay.
          </li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Entire Agreement</h3>
        <p>
          This is the entire Agreement between the parties. It represents and supersedes any and
          all oral agreements between the parties, as well as any prior writings. This Agreement
          may not be amended except in writing.
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">No Partnership</h3>
        <p>
          This Agreement does not create a partnership relationship. Contractor does not have
          authority to enter into contracts on Company&apos;s behalf.
        </p>
      </section>
    </article>
  );
}
