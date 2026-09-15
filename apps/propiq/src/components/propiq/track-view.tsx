'use client';

import { useEffect } from 'react';
import { track, type AnalyticsEvent, type AnalyticsProperties } from '@/lib/analytics';

/**
 * Fires one analytics event when a server-rendered page mounts.
 * Kept as a leaf client component so the page itself stays a server component.
 */
export const TrackView = ({
  event,
  properties,
}: {
  event: AnalyticsEvent;
  properties?: AnalyticsProperties;
}) => {
  useEffect(() => {
    track(event, properties ?? {});
    // The property bag is a stable server-rendered object per page render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
  return null;
};
