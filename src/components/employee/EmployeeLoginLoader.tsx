'use client';

import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import DashboardSwitchLoader from '@/components/common/DashboardSwitchLoader';
import {
  LOGIN_LOADER_EYEBROW,
  LOGIN_LOADER_FADE_S,
  LOGIN_LOADER_STATUS_MESSAGES,
} from '@/lib/employee/login-loader';

/**
 * "Loading your Employee Dashboard" — the card that covers the employee shell
 * from the sign-in hand-off until the Overview is on screen. The same
 * `DashboardSwitchLoader` a dashboard switch paints, with sign-in copy.
 *
 * The shell decides when it is up (`shouldLiftLoginLoader`); this only draws it
 * and fades it out. Portaled to <body> at the ViewSwitcher's layer (z-[100]) so
 * a transformed shell ancestor cannot trap the fixed overlay, and so whatever
 * sits above the switch card (the sign-in white veil at z-[200], Carla's song
 * toast, the cobrowse chrome) sits above this one too.
 *
 * See docs/features/employee-login-loader.md.
 */
export default function EmployeeLoginLoader({ show }: { show: boolean }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {show && (
        <motion.div
          key="employee-login-loader"
          className="fixed inset-0 z-[100]"
          initial={false}
          exit={{ opacity: 0 }}
          transition={{ duration: LOGIN_LOADER_FADE_S, ease: 'easeOut' }}
        >
          <DashboardSwitchLoader
            view="employee"
            eyebrow={LOGIN_LOADER_EYEBROW}
            statusMessages={LOGIN_LOADER_STATUS_MESSAGES}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
