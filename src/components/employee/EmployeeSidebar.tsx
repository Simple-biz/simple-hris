'use client';

import React from 'react';
import { useTheme } from 'next-themes';
import {
  LayoutDashboard,
  FileText,
  Clock,
  Moon,
  Sun,
  LogOut,
  ChevronRight,
  User,
  UserCircle,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmployeeAvatar from './EmployeeAvatar';

interface EmployeeSidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  employeeName?: string;
  department?: string;
  /** Used for Gravatar (same email as ?email= on /employee). */
  employeeEmail?: string | null;
  /** Supabase profile photo URL when set. */
  profilePhotoUrl?: string | null;
}

const navItems = [
  { id: 'dashboard', label: 'My Dashboard', icon: LayoutDashboard },
  { id: 'profile', label: 'Profile', icon: UserCircle },
  { id: 'hours', label: 'My Hours', icon: Clock },
  { id: 'disputes', label: 'My Disputes', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function EmployeeSidebar({
  activeTab,
  setActiveTab,
  employeeName = 'Employee',
  department = 'Team Member',
  employeeEmail = null,
  profilePhotoUrl = null,
}: EmployeeSidebarProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const initials = employeeName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex h-screen w-64 flex-col border-r border-orange-100 bg-gradient-to-b from-white to-orange-50/40 text-zinc-600 dark:border-blue-950/60 dark:from-[#0d1117] dark:to-[#0f1729] dark:text-zinc-400">
      <div className="p-6">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 shadow-md shadow-orange-500/30">
            <User className="h-5 w-5 text-white" />
          </div>
          <div className="rounded-md bg-white px-2 py-1">
            <img
              src="/simple%20logo.png"
              alt="Simple HRIS"
              className="h-5 w-auto object-contain"
            />
          </div>
        </div>

        <ScrollArea className="-mx-2 flex-1">
          <nav className="space-y-1 px-2">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200',
                  activeTab === item.id
                    ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 shadow-sm dark:from-blue-950/70 dark:to-blue-950/40 dark:text-white'
                    : 'hover:bg-orange-50 hover:text-zinc-900 dark:hover:bg-blue-950/30 dark:hover:text-zinc-200',
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4',
                    activeTab === item.id
                      ? 'text-orange-500 dark:text-orange-400'
                      : 'text-zinc-500 group-hover:text-orange-500 dark:text-zinc-500 dark:group-hover:text-orange-400',
                  )}
                />
                {item.label}
                {activeTab === item.id && (
                  <ChevronRight className="ml-auto h-3 w-3 text-orange-400 dark:text-orange-500/70" />
                )}
              </button>
            ))}
          </nav>
        </ScrollArea>
      </div>

      <div className="mt-auto border-t border-orange-100 p-4 dark:border-blue-950/60">
        <button
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          className="mb-2 flex w-full items-center justify-between rounded-md border border-orange-100 bg-orange-50/60 px-3 py-2 transition-colors hover:bg-orange-100/80 dark:border-blue-950/60 dark:bg-blue-950/20 dark:hover:bg-blue-950/40"
          aria-label="Toggle dark mode"
        >
          <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            <span className="text-xs font-medium">{isDark ? 'Dark mode' : 'Light mode'}</span>
          </div>
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white shadow-sm dark:bg-blue-950/60">
            {isDark ? (
              <Sun className="h-3.5 w-3.5 text-orange-400" />
            ) : (
              <Moon className="h-3.5 w-3.5 text-blue-500" />
            )}
          </div>
        </button>
        <div className="mb-4 flex items-center gap-3 px-3 py-2">
          <EmployeeAvatar
            photoUrl={profilePhotoUrl}
            email={employeeEmail}
            initials={initials}
            className="h-8 w-8 text-xs"
            pixelSize={64}
          />
          <div className="flex min-w-0 flex-col overflow-hidden">
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200">
              {employeeName}
            </span>
            <span className="truncate text-xs text-zinc-500 dark:text-zinc-500">
              {department}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-zinc-600 hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
          onClick={() => (window.location.href = '/')}
        >
          <LogOut className="h-4 w-4" />
          Back to Admin
        </Button>
      </div>
    </div>
  );
}
