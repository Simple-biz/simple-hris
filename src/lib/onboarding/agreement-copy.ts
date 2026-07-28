// Single source of truth for the SHORT onboarding agreements' legal copy
// (Non-Solicitation, Privacy, Contract Worker) plus the shared agreement
// titles. Consumed by:
//   - the React renderers in src/components/onboarding/agreement-texts.tsx
//     (public onboarding form + HR submission-detail modal), and
//   - the signed-contracts packet PDF (src/lib/hr/onboarding-contracts-pdf.ts,
//     the View modal's Download tab),
// so the on-screen copy and the downloadable document can never drift.
//
// The long IP Assignment copy lives in ./ip-assignment-text.ts (same pattern).
// Kept ASCII-only (straight quotes/apostrophes, "-" not en/em dashes) so the
// same strings render cleanly through pdf-lib's WinAnsi Helvetica encoding.

import { IP_ASSIGNMENT_TITLE } from "./ip-assignment-text";

export const AGREEMENT_TITLES = {
  intellectualProperty: IP_ASSIGNMENT_TITLE,
  nonSolicitation: "Non-Solicitation of Employees",
  privacy: "Privacy Agreement",
  contract: "Contract Worker Agreement",
} as const;

export const NON_SOLICITATION_PARAGRAPHS: string[] = [
  "You agree not to hire, offer work to, or try to hire any employee or contractor of our company while you are working with us, or for one year after your work with us ends.",
  "This includes not asking anyone who works with us to leave their job, or to stop working with us in any way.",
];

export const PRIVACY_PARAGRAPHS: string[] = [
  'For the protection of yourself and the company, we ask that you do not include the name "Simple.biz" in any profiles, posts, video or the like on any social media platform. This is including but not limited to LinkedIn, Facebook, Instagram, etc... Instead, we recommend that you put "Company Confidential" or "Web Design Firm" when the need arises.',
];

export type ContractWorkerSection = {
  heading: string;
  paragraphs: string[];
  /** Optional bullet list rendered after the paragraphs. */
  bullets?: string[];
};

export const CONTRACT_WORKER_SECTIONS: ContractWorkerSection[] = [
  {
    heading: "Effective Date",
    paragraphs: [
      "This Agreement will take place effective immediately and will remain in effect until voluntarily terminated by either Company or Contractor.",
    ],
  },
  {
    heading: "Payment",
    paragraphs: ["Contractor will be paid as follows: for services as Company deems needed."],
  },
  {
    heading: "Expenses",
    paragraphs: [
      "Contractor will be responsible for all expenses incurred while performing services under this Agreement.",
    ],
  },
  {
    heading: "Independent Contractor Status",
    paragraphs: [
      "Contractor is an independent contractor, and neither Contractor, nor Contractor's employees, or contract personnel is, or will be deemed, Company's employees. In its capacity as independent contractor, Contractor agrees and represents, and Company agrees as follows:",
    ],
    bullets: [
      'Contractor has the right to perform services for others during the term of this Agreement. However, Contractor agrees to not perform "side work" for any of Company\'s clients or referrals from Company\'s clients, as this represents an actionable breach of confidentiality.',
      "Contractor has the sole right to control and direct the means, manner, and method by which the services required by this Agreement will be performed.",
      "Contractor has the right to perform the services required by the Agreement at any place or location and at such times as Contractor may determine.",
      "Contractor will furnish all equipment and materials used to provide the services required by this Agreement.",
      "Contractor will not receive any training from Company in the professional skills necessary to perform the services required by this Agreement.",
      "Contractor will not withhold from Contractor's compensation any amount that would normally be withheld from an employee's pay.",
    ],
  },
  {
    heading: "Entire Agreement",
    paragraphs: [
      "This is the entire Agreement between the parties. It represents and supersedes any and all oral agreements between the parties, as well as any prior writings. This Agreement may not be amended except in writing.",
    ],
  },
  {
    heading: "No Partnership",
    paragraphs: [
      "This Agreement does not create a partnership relationship. Contractor does not have authority to enter into contracts on Company's behalf.",
    ],
  },
];
