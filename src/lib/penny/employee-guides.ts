/**
 * "How do I…" procedures for the employee suite — the self-service knowledge
 * Penny hands back when someone asks how to get a document or file a leave.
 *
 * ── Why these are DATA, not prompt text ──────────────────────────────────────
 * Every step names a real tab, a real button and a real option. Baked into the
 * system prompt they would rot silently the next time a label changed; here they
 * are reviewable, diffable, and pinned by tests that assert the labels still
 * match the components (`employee-guides.test.ts`). A guide that sends someone to
 * a button that no longer exists is worse than no guide — they go to HR anyway,
 * having first lost five minutes and some trust.
 *
 * ── Procedure vs. policy ─────────────────────────────────────────────────────
 * These describe HOW the HRIS works. They never state a policy VALUE. The one
 * value that matters here — the advance notice for planned time off — is
 * per-team and lives in `team-policies.ts`, so it is injected by the caller from
 * that single source and is `null` for the ~15 teams whose page does not publish
 * one. See docs/features/employee-team-directory.md:176: the omission is
 * deliberate, because a default "would tell someone the wrong shift".
 */

export interface EmployeeGuide {
  key: 'coe' | 'payslips' | 'leave';
  title: string;
  /** Exact navigation path, as the sidebar and tab bar spell it. */
  where: string;
  steps: string[];
  /** Things people get wrong, or that the system will refuse. */
  notes: string[];
}

export interface GuideContext {
  /** The team's published time-off notice sentence, verbatim, or null. */
  noticePolicyBody: string | null;
  /** Whether this employee's team has a published policy page at all. */
  hasTeamPage: boolean;
  /** How the policy set names the team ("AI/Automation", "Company-wide"). */
  teamLabel: string;
}

/**
 * The Certificate of Engagement guide.
 *
 * The one thing employees consistently expect and this flow does NOT do: upload
 * anything. The HRIS writes the certificate (docs/features/documents-tab.md
 * § Certificate of Engagement), which is why the button says "Request
 * certificate" and not "Submit request".
 */
function coeGuide(): EmployeeGuide {
  return {
    key: 'coe',
    title: 'Request a Certificate of Engagement (COE)',
    where: 'Employee → Profile → Request Documents',
    steps: [
      'Open Profile from the sidebar, then the "Request Documents" tab.',
      'Choose the document type "Certificate of Engagement (COE)".',
      'No file to attach — the HRIS writes the certificate for you. A preview card shows exactly what it will say: your name, employee ID, engaged-since date, team, hourly and overtime rate, and the bonus lines your team qualifies for.',
      'Read that preview. It is the moment a wrong start date or rate gets caught, by the one person who would notice.',
      'Press "Request certificate".',
      'Accounting reviews and signs it. Watch the status in the same tab — pending, signed or rejected.',
      'Once signed, download it there with the "Signed document" button. You also get a notification when it is returned.',
    ],
    notes: [
      'It is called a Certificate of ENGAGEMENT, not Employment, because the certificate states you are engaged as a contractor. Banks, embassies and landlords accept it as the equivalent document.',
      'The signed copy carries the requested date, the signed date, a reference ID and the signatory\'s signature, so it can be verified as genuine.',
      'The request can be REFUSED if your record is incomplete — a missing start date, department or pay rate. The HRIS declines rather than printing blanks, because a certificate with gaps looks forged and is useless at a bank. If that happens, ask HR to complete your record and request again.',
      'A pending request can be cancelled from the same tab.',
    ],
  };
}

/**
 * Pay stubs. Two different things share one name, and confusing them is the
 * usual reason someone gets the wrong file: the copy you download yourself, and
 * the copy Accounting signs for a bank.
 */
function payslipsGuide(): EmployeeGuide {
  return {
    key: 'payslips',
    title: 'Get your pay stubs / payslips',
    where: 'Employee → Profile → Pay Stubs (your own copy) · Profile → Request Documents (a signed copy)',
    steps: [
      'For your own records: open Profile → the "Pay Stubs" tab. Every pay week is listed; "View" opens that week\'s statement.',
      'The same tab exports every week at once as a PDF or a spreadsheet, straight to your device.',
      'Quickest route for the latest week: on your Overview, use the "Open Paystubs" button beside the pay-week selector. The "Salary Paid" notification also carries an "Open Pay Stub" button.',
      'For an OFFICIAL signed copy — a bank, a loan, a visa, tax filing: Profile → "Request Documents" → type "Pay Summary / Pay Slips".',
      'Pick the period you need: last 3, 6 or 12 months, or everything. The HRIS builds the PDF and attaches it for you.',
      'Press "Submit request", then download the "Signed document" from that tab once Accounting has signed it.',
    ],
    notes: [
      'The Pay Stubs tab is instant and needs nobody\'s approval — use it unless somebody specifically needs a signed document.',
      'A week marked as an estimate was reconstructed from your logged hours rather than from a finalised payroll run. Performance bonuses and manual adjustments are not included on those weeks, so the total can differ from what was actually paid.',
      'Only your own statements are ever visible here.',
    ],
  };
}

/**
 * Filing a leave request.
 *
 * The notice period is the caller's to supply, from the team's published policy.
 * Note also what the code does NOT do: `EmployeeLeaves.tsx` validates only that
 * the start date is today or later and that the end date is not before it. The
 * form will happily accept a request for tomorrow — so the notice period is an
 * expectation to meet, never a gate the system enforces, and Penny must not
 * imply otherwise.
 */
function leaveGuide(ctx: GuideContext): EmployeeGuide {
  const notes: string[] = [];

  if (ctx.noticePolicyBody) {
    notes.push(
      `Advance notice, from your team's published policy (${ctx.teamLabel}): "${ctx.noticePolicyBody}"`,
    );
  } else {
    // The deliberate omission. Say it is unpublished; never fill in a number.
    notes.push(
      ctx.hasTeamPage
        ? 'Your team\'s policy page does not state an advance-notice period for planned time off. Agree the timing with your manager before you file.'
        : 'Your team does not have its own published policy page, and the company-wide set deliberately does not state an advance-notice period — it is one of the things that genuinely differs per team. Ask your manager how much notice they need, rather than assuming a number.',
    );
  }

  notes.push(
    'The form does not enforce a notice period — it will accept a start date of tomorrow. Meeting your team\'s notice expectation is between you and your manager, not something the system checks.',
    'Missing a workday can affect your attendance bonus. An approved leave is not automatically the same as attendance forgiveness — check the PAB calendar on your Overview and raise anything that looks wrong with your manager.',
    'The HRIS does not track a leave balance, so there is no "days remaining" figure to quote.',
  );

  return {
    key: 'leave',
    title: 'File a leave request',
    where: 'Employee → Leave → New request',
    steps: [
      'Open "Leave" from the sidebar and stay on the "New request" tab.',
      'Pick the type: Vacation, Sick, Personal, Bereavement or Other.',
      'Choose your start and end date. For a single day, set both to the same date.',
      'Add a reason if it helps your manager decide — it is optional.',
      'Submit. The request goes to the manager(s) of your department, and any ONE of them approving clears it.',
      'Track it under "My requests" in the same tab: pending, approved, rejected (with the approver\'s note) or cancelled. A pending request can be cancelled there.',
    ],
    notes,
  };
}

/** All three guides, with the team's own notice policy folded into the leave one. */
export function buildEmployeeGuides(ctx: GuideContext): EmployeeGuide[] {
  return [coeGuide(), payslipsGuide(), leaveGuide(ctx)];
}

/**
 * Pull the team's time-off notice sentence out of a policy set.
 *
 * Reads the `attendance` policy — the only published policy that carries the
 * notice period — and returns its body VERBATIM. Deliberately does not parse a
 * number out of it: "one week" and "two weeks" are both live values, the
 * sentence also carries the attendance-bonus condition, and a regex that
 * extracted "one" would strip the context that makes it correct.
 */
export function noticePolicyBodyFrom(
  policies: { id: string; body: string }[],
): string | null {
  return policies.find((p) => p.id === 'attendance')?.body ?? null;
}
