'use client';

import { useState } from 'react';
import { Loader2, Lock, Mail, LogIn, HelpCircle, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface EmployeeLoginProps {
  onSuccess: (workEmail: string) => void;
}

export default function EmployeeLogin({ onSuccess }: EmployeeLoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      toast.error('Enter your work email and password.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/employee-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ work_email: email.trim(), password }),
      });
      const json = (await res.json()) as { success?: boolean; work_email?: string; error?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Login failed.');
        return;
      }
      toast.success('Welcome back.');
      onSuccess(json.work_email || email.trim());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-white via-orange-50/40 to-blue-50/30 p-6 dark:bg-none dark:bg-[#0d1117]">
      <Card className="w-full max-w-md border-zinc-200 shadow-lg dark:border-zinc-800">
        <CardContent className="p-8">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-orange-500/10">
              <LogIn className="h-7 w-7 text-orange-500" />
            </div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Sign in</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Enter your work email to continue.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                <Mail className="h-3.5 w-3.5" /> Work email
              </span>
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={submitting}
              />
            </label>

            <label className="block space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                <Lock className="h-3.5 w-3.5" /> Password
              </span>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="MMDDYY of your start date"
                disabled={submitting}
              />
            </label>

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
              Sign in
            </Button>
          </form>

          <button
            type="button"
            onClick={() => setForgotOpen(true)}
            className="mt-4 flex w-full items-center justify-center gap-1.5 text-xs text-zinc-500 transition hover:text-orange-600 dark:text-zinc-400 dark:hover:text-orange-400"
          >
            <HelpCircle className="h-3.5 w-3.5" /> Forgot password?
          </button>
        </CardContent>
      </Card>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
    </div>
  );
}

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [startMmddyy, setStartMmddyy] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !/^\d{6}$/.test(startMmddyy)) {
      toast.error('Enter your work email and 6-digit start date (MMDDYY).');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/employee-forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          work_email: email.trim(),
          start_mmddyy: startMmddyy,
          note: note.trim() || undefined,
        }),
      });
      const json = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Could not submit request.');
        return;
      }
      setDone(true);
      toast.success(json.message || 'Request sent to accounting.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md border-zinc-200 shadow-xl dark:border-zinc-800">
        <CardContent className="p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Forgot password</h2>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Verify your identity and the accounting team will reach out with a new password.
              </p>
            </div>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
              <X className="h-4 w-4" />
            </button>
          </div>

          {done ? (
            <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <p className="font-medium">Request submitted.</p>
              <p>The accounting team has been notified and will contact you shortly.</p>
              <Button variant="outline" className="w-full" onClick={onClose}>Close</Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Work email</span>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  disabled={submitting}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Start date (MMDDYY)</span>
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={startMmddyy}
                  onChange={(e) => setStartMmddyy(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 060526"
                  disabled={submitting}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Note <span className="text-zinc-400">(optional)</span>
                </span>
                <Input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Anything the accounting team should know"
                  disabled={submitting}
                />
              </label>
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Submit request
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
