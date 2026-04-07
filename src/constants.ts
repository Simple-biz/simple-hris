import { User, TimeRecord, PaymentLineItem } from './types';

export const MOCK_USERS: User[] = [
  {
    id: '1',
    name: 'Fran M',
    email: 'fran.m@simple.biz',
    hubstaffEmail: 'fran.m@simple.biz',
    bankInfo: {
      accountName: 'Fran M',
      accountNumber: '123456789',
      bankName: 'Chase Bank',
      routingNumber: '987654321',
    },
    address: {
      street: '123 Main St',
      city: 'New York',
      state: 'NY',
      zip: '10001',
      country: 'USA',
    },
    cycleType: 'STANDARD',
    status: 'ACTIVE',
    hourlyRate: 50.0,
  },
  {
    id: '2',
    name: 'Thomas Hogan',
    email: 'thomas.h@simple.biz',
    hubstaffEmail: 'thomas.h@simple.biz',
    bankInfo: {
      accountName: 'Thomas Hogan',
      accountNumber: '987654321',
      bankName: 'Bank of America',
      routingNumber: '123456789',
    },
    address: {
      street: '456 Elm St',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'USA',
    },
    cycleType: 'HOGAN',
    status: 'ACTIVE',
    hourlyRate: 60.0,
  },
  {
    id: '3',
    name: 'New Hire Alice',
    email: 'alice.n@simple.biz',
    hubstaffEmail: 'alice.n@simple.biz',
    cycleType: 'STANDARD',
    status: 'PENDING',
    hourlyRate: 45.0,
  },
  {
    id: '4',
    name: 'Disabled User Bob',
    email: 'bob.d@simple.biz',
    hubstaffEmail: 'bob.d@simple.biz',
    cycleType: 'STANDARD',
    status: 'DISABLED',
    hourlyRate: 40.0,
  },
];

export const MOCK_TIME_RECORDS: TimeRecord[] = [
  {
    id: 'tr1',
    workerId: '1',
    hours: 40.5,
    periodStart: '2026-03-22',
    periodEnd: '2026-03-28',
    source: 'HUBSTAFF',
  },
  {
    id: 'tr2',
    workerId: '2',
    hours: 38.25,
    periodStart: '2026-03-23',
    periodEnd: '2026-03-29',
    source: 'HUBSTAFF',
  },
];

export const MOCK_PAYMENTS: PaymentLineItem[] = [
  {
    id: 'p1',
    workerId: '1',
    type: 'BONUS',
    amount: 500,
    description: 'Quarterly Performance Bonus',
    date: '2026-03-28',
  },
];
