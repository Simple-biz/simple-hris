import type Anthropic from '@anthropic-ai/sdk';

/**
 * Tool DEFINITIONS for the employee Penny AI — the JSON schemas Claude sees.
 *
 * Split out from `employee-tools.ts` (which is `server-only`) for one reason:
 * the guard tests that enforce "no employee tool accepts an identity argument"
 * must be able to import these without pulling a Supabase client into the test
 * runner. A guard that can only run inside Next.js is a guard that stops running.
 *
 * Pure data + two pure predicates. No I/O, no `server-only`.
 */


/**
 * Property names that would let the model choose a subject. Kept as a list so
 * the guard test can state exactly what it is forbidding.
 */
export const FORBIDDEN_TOOL_INPUT_KEYS = [
  'email',
  'work_email',
  'personal_email',
  'employee',
  'employee_email',
  'employee_id',
  'name',
  'person',
  'query',
  'department',
  'team',
] as const;

export const EMPLOYEE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_my_profile',
    description:
      "The signed-in employee's own employment record: name, employee ID, start date, team, weekly hours, hourly rate, overtime rate, and which standard (Attendance / Technology) and performance bonuses their team qualifies for. Use this for \"what's my rate\", \"when did I start\", \"what team am I on\", \"which bonuses can I get\". Figures come from the same resolver as their Certificate of Engagement, so they always agree.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_pay',
    description:
      "The signed-in employee's own recent weekly pay: hours, regular/overtime split, the computed amount, what was actually disbursed, and the status per pay week (most recent first) plus a summed total. Use for \"what was my last pay\", \"how much did I make over the last month\", \"how many hours did I log last week\". Never quote a figure for a week this does not return — tell them to open their Pay Stubs tab instead.",
    input_schema: {
      type: 'object',
      properties: {
        weeks: {
          type: 'integer',
          description:
            'How many recent pay weeks to return (1–26). Default 1 (their latest pay).',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_my_pay_schedule',
    description:
      'How and when the signed-in employee gets paid: the weekly Sunday–Saturday cycle, that payroll runs a week in arrears, their payout rail, and the next scheduled pay date. Use for "when do I get paid", "when is payday", "why haven\'t I been paid for this week yet".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_bonus_status',
    description:
      'The bonus programmes that apply to the signed-in employee, with the CURRENT configuration: the Attendance Bonus (PAB) — its amount for their team, the month\'s attendance window, how it is earned, and which pay week it lands in; the Technology Bonus — its amount, this month\'s configured payout week, and whether they have passed the 30-day service requirement; and their KPI/performance bonus results for periods a manager has actually submitted. Use for EVERY "when is the PAB", "how do I get the PAB", "how much is the PAB", "when do I receive my tech bonus" question. Report the window and the rule; for whether they have earned this month\'s PAB, point them at the PAB calendar on their Overview — this tool deliberately does not judge day-by-day attendance.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_company_policies',
    description:
      "The company policies published for the signed-in employee's own team, verbatim. Use for any policy question — time off, notice periods, work schedule, overtime approval, cameras, conduct. CRITICAL: answer policy questions ONLY from what this returns. When `has_team_page` is false, their team has no published page and the workday window and time-off notice period are deliberately absent — say they are not published for their team and point them at their manager. Never state a shift time, a notice period, or a leave allowance this tool did not return.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_company_benefits',
    description:
      'Company-wide benefit facts: the standard bonus programmes and their amounts, and the paid US holiday schedule (which dates are recognised for attendance purposes). Use for "what holidays do we get", "is Monday a holiday", "what bonuses does the company offer".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_leave_requests',
    description:
      "The signed-in employee's own leave requests — dates, type, status (pending / approved / rejected / cancelled) and any approver note. Use for \"was my leave approved\", \"how many leave requests do I have open\", \"when is my time off\". This is their request history, not a leave balance — the company does not track a balance here.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_company_how_to_guides',
    description:
      "Step-by-step instructions for the things employees do in this HRIS themselves: requesting a Certificate of Engagement (COE), getting pay stubs / payslips (both the copy they download instantly and the officially signed copy for a bank or visa), and filing a leave request — including their own team's advance-notice expectation. Call this for ANY \"how do I…\", \"where do I…\", \"can I get a…\" question about paperwork or time off. Follow the steps as returned: they name the real tabs and buttons. If a guide's `notes` say something can be refused or is not enforced, say so — do not smooth it over. Returns all three guides at once, so one call covers a follow-up question too.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_contacts',
    description:
      "Who the signed-in employee should contact: the manager(s) assigned to their own department, and how to escalate. Use for \"who is my manager\", \"who do I ask about X\", \"who handles payroll questions\". Only ever names people recorded as managers of THEIR department — if the list is empty, say so and tell them to raise it with HR rather than guessing a name.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

/**
 * Fail loudly if a tool ever gains an identity parameter. Called by the test
 * suite, and cheap enough to also run at module load in dev.
 */
export function assertNoIdentityInputs(tools: Anthropic.Tool[] = EMPLOYEE_TOOLS): string[] {
  const offenders: string[] = [];
  for (const tool of tools) {
    const schema = tool.input_schema as { properties?: Record<string, unknown> };
    for (const key of Object.keys(schema.properties ?? {})) {
      if ((FORBIDDEN_TOOL_INPUT_KEYS as readonly string[]).includes(key.toLowerCase())) {
        offenders.push(`${tool.name}.${key}`);
      }
    }
  }
  return offenders;
}

export function isEmployeeTool(name: string): boolean {
  return EMPLOYEE_TOOLS.some((t) => t.name === name);
}

