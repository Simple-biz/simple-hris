export type CycleType = 'STANDARD' | 'HOGAN';
export type WorkerStatus = 'ACTIVE' | 'PENDING' | 'DISABLED' | 'ON_LEAVE';
export type PaymentType = 'SALARY' | 'BONUS' | 'ADJUSTMENT' | 'URGENT';

export interface BankInfo {
  accountName: string;
  accountNumber: string;
  bankName: string;
  routingNumber?: string;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  hubstaffEmail?: string;
  bankInfo?: BankInfo;
  address?: Address;
  cycleType: CycleType;
  status: WorkerStatus;
  hourlyRate: number;
}

export interface TimeRecord {
  id: string;
  workerId: string;
  hours: number;
  periodStart: string;
  periodEnd: string;
  source: 'HUBSTAFF' | 'MANUAL';
}

export interface PaymentLineItem {
  id: string;
  workerId: string;
  type: PaymentType;
  amount: number;
  description: string;
  date: string;
}

export interface AuditLog {
  id: string;
  action: string;
  timestamp: string;
  userId: string;
  details?: string;
}

export interface HubstaffRow {
  email: string;
  name: string;
  hours: string; // "40:30" or "40.5"
  decimalHours: number;
  /** Department/job-type from Hubstaff — used as a fallback when the employee
   *  is absent from global_master_list. Populated from the "Job type" column
   *  in both CSV uploads and the hubstaff_hours Supabase table. */
  department?: string | null;
}

export interface ReconciliationIssue {
  type: 'UNMATCHED_EMAIL' | 'MISSING_BANK_INFO' | 'STATUS_CONFLICT';
  workerId?: string;
  email?: string;
  description: string;
}
