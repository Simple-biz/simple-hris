/**
 * Hand-authored example POST bodies for each known webhook slug, shown in the
 * Admin -> Webhooks "View" modal so whoever wires up the n8n workflow knows
 * exactly which fields will arrive. Shapes are kept in sync with the real
 * fetch() call sites (see each slug's description in AdminWebhooks.tsx for
 * the source file). Values are fictional placeholders, never real people.
 */
export const WEBHOOK_SAMPLE_PAYLOADS: Record<string, unknown> = {
  // The workflow sends `paystub_html` as-is — it does NOT build the statement.
  // The HRIS renders it (src/lib/payroll/paystub-email-html.ts) from the same
  // view the Payroll Wizard preview and the in-app Pay Stubs modal show, which
  // is what keeps the three from drifting. n8n skips any item without it.
  paystub_dispatch: {
    pay_period: { week: { start: '2026-07-19', end: '2026-07-25' }, fx_rate: 61.67, currency: 'PHP' },
    employees: [
      {
        name: 'Jordan Cruz',
        email: 'jordan.cruz@simple.biz',
        personal_email: 'jordan.cruz@gmail.com',
        department_name: 'Lead Gen',
        hours: { regular: 40, ot: 5 },
        rates_php: { regular: 125, ot: 187.5 },
        pay_php: { regular: 5000, ot: 937.5, final: 5937.5 },
        pay_period: { week: { start: '2026-07-19', end: '2026-07-25' }, fx_rate: 61.67 },
        paystub_subject: 'Paystub for Jordan Cruz · Jul 19 – Jul 25, 2026',
        paystub_html: '<!DOCTYPE html><html>…the complete rendered pay statement…</html>',
      },
    ],
    cycle: { source_file: 'hubstaff_2026-07-19_2026-07-25.csv', cycle_id: 'cyc_2026_07_19' },
  },

  create_workspace_account: {
    first_name: 'Jordan',
    last_name: 'CR',
    gmail_surname: 'CR',
    work_email: 'jordan.cr@simple.biz',
    personal_email: 'jordan.cruz@gmail.com',
    organization_id: 724122,
    project_names: ['Lead Gen - US'],
    role: 'project_user',
    pay_rate: 5.0,
    regular_rate: 5.0,
    ot_rate: 7.5,
    trackable: true,
    calltools_nickname: null,
    calltools_username: null,
  },

  verify_workspace_account: {
    work_email: 'jordan.cr@simple.biz',
  },

  hubstaff_invite_user: {
    username: 'jordan.cr',
    email: 'jordan.cr@simple.biz',
    organizationId: 724122,
    projectNames: ['Lead Gen - US'],
    role: 'project_user',
    pay_rate: 5.0,
    trackable: true,
  },

  onboarding_send: {
    submission_id: 'a1b2c3d4-0000-4000-8000-000000000000',
    token: '9f8e7d6c5b4a3f2e1d0c',
    link: 'https://app.simple.biz/onboarding/9f8e7d6c5b4a3f2e1d0c',
    sent_by: 'hr@simple.biz',
    to: 'jordan.cruz@gmail.com',
    invite_name: 'Jordan Cruz',
    invite_department: 'Lead Gen - US',
    invite_country: 'Philippines',
    invite_note: null,
    subject: "You're invited to join Simple — complete your onboarding",
    body: '<!-- plain-text fallback of the invite email -->',
    html: '<!-- rendered HTML invite email -->',
    pay_plan: {
      url: 'https://storage.simple.biz/pay-plans/lead-gen-ph.pdf?sig=...',
      file_name: 'Lead-Gen-PH-Pay-Plan.pdf',
      content_type: 'application/pdf',
      department: 'Lead Gen - US',
      country: 'Philippines',
      currency: 'PHP',
    },
    attachments: [
      {
        url: 'https://storage.simple.biz/forms/FW8BEN.pdf',
        filename: 'FW8BEN.pdf',
        contentType: 'application/pdf',
        description: 'Form W-8BEN',
      },
      {
        url: 'https://storage.simple.biz/pay-plans/lead-gen-ph.pdf?sig=...',
        filename: 'Lead-Gen-PH-Pay-Plan.pdf',
        contentType: 'application/pdf',
        description: 'Pay plan',
      },
    ],
  },

  // The deactivate flow is the suspend/temporary pathway only: fired for the
  // HR temporary_pause reason (and mirrored by manager_suspend below) with
  // deletion_mode "none" — never for a real offboard, which always rides
  // offboarding_delete.
  offboarding_deactivate: {
    event: 'employee.offboarded',
    phase: 'deactivate',
    deletion_mode: 'none',
    hubstaff_pay_rate: 0,
    off_boarded_by: 'hr@simple.biz',
    off_boarded_at: '2026-08-03T09:15:00.000Z',
    count: 1,
    employees: [
      {
        work_email: 'jordan.cr@simple.biz',
        personal_email: 'jordan.cruz@gmail.com',
        name: 'Jordan Cruz',
        departments: ['Lead Gen - US'],
        start_date: '2026-01-12',
        reason: 'temporary_pause',
        note: null,
        off_boarded_by: 'hr@simple.biz',
        off_boarded_at: '2026-08-03T09:15:00.000Z',
        scheduled_deletion_at: null,
      },
    ],
  },

  offboarding_delete: {
    event: 'employee.offboarded',
    phase: 'delete',
    deletion_mode: 'immediate',
    hubstaff_pay_rate: 0,
    off_boarded_by: 'hr@simple.biz',
    off_boarded_at: '2026-08-03T09:15:00.000Z',
    count: 1,
    employees: [
      {
        work_email: 'jordan.cr@simple.biz',
        personal_email: 'jordan.cruz@gmail.com',
        name: 'Jordan Cruz',
        departments: ['Lead Gen - US'],
        start_date: '2026-01-12',
        reason: 'end_of_contract',
        note: null,
        off_boarded_by: 'hr@simple.biz',
        off_boarded_at: '2026-08-03T09:15:00.000Z',
        scheduled_deletion_at: null,
      },
    ],
  },

  // Manager -> My Team "Suspend": the HR temporary_pause envelope, plus a
  // `source` marker. Built by buildManagerSuspendPayload — keep in sync with
  // src/lib/hr/manager-temp-pause-webhooks.ts.
  manager_suspend: {
    event: 'employee.offboarded',
    phase: 'deactivate',
    deletion_mode: 'none',
    hubstaff_pay_rate: 0,
    off_boarded_by: 'alex.rivera@simple.biz',
    off_boarded_at: '2026-08-05T09:15:00.000Z',
    source: 'manager_suspend',
    count: 1,
    employees: [
      {
        work_email: 'jordan.cr@simple.biz',
        personal_email: 'jordan.cruz@gmail.com',
        name: 'Jordan Cruz',
        departments: ['Lead Gen - US'],
        start_date: '2026-01-12',
        reason: 'temporary_pause',
        note: null,
        off_boarded_by: 'alex.rivera@simple.biz',
        off_boarded_at: '2026-08-05T09:15:00.000Z',
        scheduled_deletion_at: null,
      },
    ],
  },

  // Manager -> My Team "Reactivation": re-enable after a temporary pause.
  // Built by buildManagerReactivatePayload — keep in sync with
  // src/lib/hr/manager-temp-pause-webhooks.ts.
  manager_reactivate: {
    event: 'employee.reactivated',
    action: 'reactivate',
    reason: 'temporary_pause',
    triggered_by: 'alex.rivera@simple.biz',
    triggered_at: '2026-08-05T10:00:00.000Z',
    source: 'manager_reactivate',
    count: 1,
    employees: [
      {
        work_email: 'jordan.cr@simple.biz',
        personal_email: 'jordan.cruz@gmail.com',
        name: 'Jordan Cruz',
        departments: ['Lead Gen - US'],
        start_date: '2026-01-12',
        action: 'reactivate',
        reason: 'temporary_pause',
        triggered_by: 'alex.rivera@simple.biz',
        triggered_at: '2026-08-05T10:00:00.000Z',
      },
    ],
  },

  new_hire_checklist_lock: {
    event: 'new_hire_checklist.locked',
    period_start: '2026-07-19',
    period_end: '2026-07-25',
    status: 'locked',
    locked_at: '2026-07-25T10:00:00.000Z',
    locked_by: 'hr@simple.biz',
    row_count: 1,
    start_date: '08/03/2026',
    orientation_date: '08/04/2026',
    orientation_weekday: 'Tuesday',
    zoom_link: 'https://zoom.us/j/3136183188',
    rows: [
      {
        id: 'row_0001',
        position: 1,
        name: 'Jordan Cruz',
        first_name: 'Jordan',
        personal_email: 'jordan.cruz@gmail.com',
        location: 'Manila, PH',
        phone_number: '+63 900 000 0000',
        date_of_interview: '07/28/2026',
        source: 'Indeed',
        hired_by: 'recruiter@simple.biz',
        department: 'Lead Gen - US',
        country: 'Philippines',
        start_date: '08/03/2026',
        orientation_date: '08/04/2026',
        orientation_weekday: 'Tuesday',
        zoom_link: 'https://zoom.us/j/3136183188',
        hire_index: 1,
      },
    ],
  },

  manager_offboard_notify: {
    event: 'manager.offboarding.requested',
    count: 2,
    manager: 'Alex Rivera',
    manager_email: 'alex.rivera@simple.biz',
    requested_at: '2026-08-03T09:00:00.000Z',
  },

  call_tools_creation: {
    event: 'hire.orientation_attended',
    pending_employee_id: 4821,
    name: 'Jordan Cruz',
    first_name: 'Jordan',
    last_name: 'Cruz',
    work_email: 'jordan.cr@simple.biz',
    personal_email: 'jordan.cruz@gmail.com',
    department: 'Lead Gen - US',
    lead_gen: true,
    calltools_nickname: 'Jordan',
    calltools_username: 'Jordan C. R.',
    pay_rate: 5.0,
    regular_rate: 5.0,
    ot_rate: 7.5,
    attended_on: '2026-08-04',
    orientation_attended_at: '2026-08-04T01:00:00.000Z',
    marked_by: 'manager@simple.biz',
    note: null,
    already_marked: false,
  },

  bank_info_notify: {
    event: 'bank_info.requested',
    recipients: [{ email: 'jordan.cr@simple.biz', name: 'Jordan Cruz' }],
    sent_by: 'system',
  },

  urgent_payment_notify: {
    event: 'urgent_payment.requested',
    full_name: 'Jordan Cruz',
    work_email: 'jordan.cr@simple.biz',
    department: 'Lead Gen - US',
    amount_php: 3500,
    note: 'Advance requested for medical expense',
    requested_by: 'accounting@simple.biz',
  },

  ticket_created: {
    event: 'ticket.created',
    send_to: 'kaner@simple.biz',
    ticket_no: 128,
    title: 'Payroll Wizard: rate snapshot toggle stays open on mobile',
    description: 'Reported by accounting — panel does not collapse below 1180px.',
    priority: 'medium',
    priority_label: 'Medium',
    status: 'open',
    status_label: 'Open',
    created_by: 'accounting@simple.biz',
    created_by_name: 'Alex Rivera',
    created_at: '2026-08-03T09:00:00.000Z',
    board_url: 'https://app.simple.biz/tickets',
    ticket_url: 'https://app.simple.biz/tickets?ticket=128',
  },

  ticket_done: {
    event: 'ticket.done',
    send_to: 'accounting@simple.biz',
    creator_name: 'Alex Rivera',
    ticket_no: 128,
    title: 'Payroll Wizard: rate snapshot toggle stays open on mobile',
    description: 'Reported by accounting — panel does not collapse below 1180px.',
    priority_label: 'Medium',
    moved_by: 'kaner@simple.biz',
    done_at: '2026-08-03T14:30:00.000Z',
    board_url: 'https://app.simple.biz/tickets',
    ticket_url: 'https://app.simple.biz/tickets?ticket=128',
  },

  ticket_assigned: {
    event: 'ticket.assigned',
    send_to: 'kaner@simple.biz',
    assignee_name: 'Kane',
    assigned_by: 'accounting@simple.biz',
    ticket_no: 128,
    title: 'Payroll Wizard: rate snapshot toggle stays open on mobile',
    description: 'Reported by accounting — panel does not collapse below 1180px.',
    priority: 'medium',
    priority_label: 'Medium',
    status_label: 'Open',
    created_by: 'accounting@simple.biz',
    created_by_name: 'Alex Rivera',
    board_url: 'https://app.simple.biz/tickets',
    ticket_url: 'https://app.simple.biz/tickets?ticket=128',
  },

  payment_cycle_complete: {
    event: 'payment_cycle.completed',
    cycle: {
      source_file: 'hubstaff_2026-07-19_2026-07-25.csv',
      cycle_id: 'cyc_2026_07_19',
      label: 'Jul 19 – 25, 2026',
      period_start: '2026-07-19',
      period_end: '2026-07-25',
      completed_at: '2026-08-03T09:00:00.000Z',
      completed_by: 'accounting@simple.biz',
    },
    stats: {
      paid_count: 84,
      total_count: 84,
      total_paid_usd: 1200.5,
      total_paid_php: 412000,
    },
    recipients: [
      { email: 'carla@simple.biz', name: 'Carla' },
      { email: 'claire@simple.biz', name: 'Claire' },
    ],
    sent_by: 'system',
  },
};

/** Generic ping shape used for custom/unrecognized slugs — matches what the "Test" button actually sends. */
export function genericTestPayload(slug: string) {
  return {
    test: true,
    source: 'simple-hris-admin',
    slug: slug || '(unset)',
    at: '2026-08-03T09:00:00.000Z',
  };
}
