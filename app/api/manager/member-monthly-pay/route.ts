import { NextResponse } from 'next/server';
import { computeMemberMonthlyPay } from '@/lib/payroll/member-monthly-pay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const yearRaw = searchParams.get('year');
    const monthRaw = searchParams.get('month'); // 0-indexed
    if (!email) {
      return NextResponse.json({ data: null, error: 'Missing email' }, { status: 400 });
    }
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 0 || month > 11) {
      return NextResponse.json(
        { data: null, error: 'Invalid year/month (month is 0-indexed, 0-11)' },
        { status: 400 },
      );
    }
    const { data, error } = await computeMemberMonthlyPay({ email, year, month });
    if (error) return NextResponse.json({ data: null, error }, { status: 500 });
    return NextResponse.json({ data, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ data: null, error: msg }, { status: 500 });
  }
}
