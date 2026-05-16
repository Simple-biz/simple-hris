'use client';

import React from 'react';

export default function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="shrink-0 border-t border-zinc-200/70 bg-white/80 px-4 py-1.5 text-center text-[10.5px] font-medium text-zinc-500 backdrop-blur-sm dark:border-zinc-800/70 dark:bg-[#0d1117]/80 dark:text-zinc-500">
      Developed by AI/API Team
      <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">/</span>
      Simple.biz © {year}
    </footer>
  );
}
