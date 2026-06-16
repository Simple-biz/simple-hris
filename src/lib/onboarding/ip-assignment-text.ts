// Single source of truth for the "Intellectual Property Assignment, Talent
// Release, and Copyright Waiver" copy. Shared by three surfaces so they can
// never drift:
//   - the public onboarding form (React, where the hire reads + signs it),
//   - the HR submission-detail modal (React review),
//   - the server-side PDF generator (pdf-lib) that bakes the signed document.
//
// Kept ASCII-only (straight quotes/apostrophes, "-" not en/em dashes) so the
// same strings render cleanly through pdf-lib's WinAnsi Helvetica encoding.

export const IP_ASSIGNMENT_TITLE =
  "Intellectual Property Assignment, Talent Release, and Copyright Waiver";

/** Lead paragraphs shown before the numbered sections. */
export const IP_ASSIGNMENT_INTRO: string[] = [
  "This Agreement is entered into between Simple.Biz (\"Company\") and the undersigned participant (\"Participant\").",
  "The Participant acknowledges that they may contribute services, appearances, performances, voice recordings, photographs, video footage, editing, production work, scripts, graphics, written materials, or other creative works (\"Materials\") in connection with the activities, programs, ministries, events, productions, social media content, websites and website designs, and other projects of the Company, including its Orphanage Ministry.",
];

export type IpAssignmentSection = { heading: string; paragraphs: string[] };

export const IP_ASSIGNMENT_SECTIONS: IpAssignmentSection[] = [
  {
    heading: "1. ASSIGNMENT OF RIGHTS",
    paragraphs: [
      "The Participant irrevocably assigns to the Company all rights, title, and interest in any Materials created, contributed, performed, recorded, edited, produced, or otherwise provided by the Participant in connection with the Company. To the fullest extent permitted by law, such Materials shall be considered works made for hire for the benefit of the Company.",
    ],
  },
  {
    heading: "2. CONSENT TO USE NAME, IMAGE, AND VOICE",
    paragraphs: [
      "The Participant grants the Company the perpetual, worldwide, royalty-free right to record, photograph, reproduce, publish, edit, distribute, display, stream, broadcast, monetize, and otherwise use the Participant's name, image, likeness, voice, performance, and Materials in any media now known or later developed, including YouTube, Facebook, Instagram, TikTok, websites, livestreams, podcasts, advertising, promotional materials, fundraising materials, and ministry content.",
    ],
  },
  {
    heading: "3. COMPANY OWNERSHIP",
    paragraphs: [
      "All Materials, copyrights, intellectual property rights, recordings, edits, copies, reproductions, and derivative works shall be the sole and exclusive property of the Company.",
    ],
  },
  {
    heading: "4. WAIVER OF CLAIMS",
    paragraphs: [
      "The Participant waives and releases any claim against the Company relating to the Materials or their use, including claims involving copyright, ownership, privacy, publicity rights, moral rights, compensation, royalties, revenue sharing, or approval of final content. Furthermore, participant agrees to waive any of these claims in relation to any social media platform or similar publication.",
    ],
  },
  {
    heading: "5. SURVIVAL OF RIGHTS",
    paragraphs: [
      "The rights granted under this Agreement are perpetual, worldwide, irrevocable, transferable, and shall survive the end of the Participant's employment, volunteer service, contractor relationship, ministry involvement, or any other affiliation with the Company.",
    ],
  },
  {
    heading: "6. GOVERNING LAW",
    paragraphs: [
      "This Agreement shall be governed by the laws of the State of Florida, United States.",
      "The Participant acknowledges that they may reside or participate from outside the United States, including the Republic of the Philippines, and agrees that the rights granted to the Company under this Agreement shall remain valid and enforceable regardless of the country in which the Participant resides or participates.",
    ],
  },
  {
    heading: "7. COVERAGE OF MINOR CHILDREN AND GUESTS",
    paragraphs: [
      "Participant acknowledges that this Agreement also applies to any minor children, family members, or guests accompanying or participating with the Participant in the orphanage ministry or appearing in any related social media or digital content, without the need for a separate signed agreement.",
    ],
  },
  {
    heading: "8. ENTIRE AGREEMENT",
    paragraphs: [
      "This Agreement constitutes the entire agreement between the Company and the Participant concerning the subject matter herein.",
    ],
  },
];

/** The checkbox acknowledgement the hire must tick to proceed. */
export const IP_ASSIGNMENT_ACKNOWLEDGEMENT =
  "I have read and understood this Agreement and acknowledge that Simple.Biz shall be the sole owner of all copyrights and intellectual property rights in the Materials.";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Format an ISO date (yyyy-mm-dd) as "April 5, 1999". Parses the parts directly
 * rather than via `new Date(iso)` so a UTC-midnight ISO string never shifts a
 * day backward in a behind-UTC timezone. Returns "" for empty input.
 */
export function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return iso;
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

/**
 * Local-time yyyy-mm-dd for the given date (default now). Used to stamp the IP
 * agreement with the day the hire opened the link. Call this CLIENT-SIDE only
 * so it reflects the hire's local day, not the server's UTC day.
 */
export function todayLocalIso(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
