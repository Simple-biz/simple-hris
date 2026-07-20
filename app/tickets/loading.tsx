import DashboardSwitchLoader from '@/components/common/DashboardSwitchLoader';

// Tickets carries its fixed black+red tone (see the tickets theme notes); the
// loader swaps its accents to match when view === 'tickets'.
export default function Loading() {
  return <DashboardSwitchLoader view="tickets" />;
}
