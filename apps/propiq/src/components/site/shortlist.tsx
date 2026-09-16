'use client';

/**
 * The shortlist.
 *
 * A visitor who is not signed in still needs somewhere to put the three
 * properties they are weighing. That place is this store: browser-local,
 * capped at what the Decision Room can actually render side by side, and
 * explicitly not the account watchlist. Saving to the watchlist is a separate
 * action that requires an account, and the copy says so rather than pretending
 * a local list is a stored one.
 *
 * The state lives outside React and is read through `useSyncExternalStore`, so
 * the server and the hydrating client both render the empty tray and the
 * persisted one arrives on the first client snapshot. Reading storage in an
 * effect instead would flash an empty dock on every load.
 */

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

export { SHORTLIST_LIMIT } from '@/components/site/shortlist-limit';
import { SHORTLIST_LIMIT } from '@/components/site/shortlist-limit';

const STORAGE_KEY = 'propiq.shortlist.v1';

export interface ShortlistEntry {
  readonly id: string;
  readonly name: string;
}

const EMPTY: readonly ShortlistEntry[] = [];

/**
 * Reads the persisted shortlist. Anything that is not a well-formed array of
 * `{id, name}` is discarded rather than repaired — a half-parsed tray would put
 * ids we never wrote into a `/compare` URL.
 */
const readStored = (): readonly ShortlistEntry[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    const entries = parsed
      .filter(
        (e): e is ShortlistEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as ShortlistEntry).id === 'string' &&
          typeof (e as ShortlistEntry).name === 'string',
      )
      .slice(0, SHORTLIST_LIMIT);
    return entries.length === 0 ? EMPTY : entries;
  } catch {
    // Private mode, disabled storage, corrupt JSON — an empty tray is correct.
    return EMPTY;
  }
};

let state: readonly ShortlistEntry[] = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

/** Cached: `useSyncExternalStore` requires a stable reference between changes. */
const getSnapshot = (): readonly ShortlistEntry[] => {
  if (!loaded) {
    state = readStored();
    loaded = true;
  }
  return state;
};

const getServerSnapshot = (): readonly ShortlistEntry[] => EMPTY;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const commit = (next: readonly ShortlistEntry[]): void => {
  state = next;
  loaded = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage being unavailable must not break the tray for this session.
  }
  for (const listener of listeners) listener();
};

const toggleEntry = (entry: ShortlistEntry): void => {
  const current = getSnapshot();
  if (current.some((e) => e.id === entry.id)) {
    commit(current.filter((e) => e.id !== entry.id));
    return;
  }
  if (current.length >= SHORTLIST_LIMIT) return;
  commit([...current, entry]);
};

const clearEntries = (): void => commit(EMPTY);

interface ShortlistApi {
  readonly entries: readonly ShortlistEntry[];
  /** False outside a provider, so a card rendered without a tray hides Compare. */
  readonly enabled: boolean;
  readonly has: (id: string) => boolean;
  readonly toggle: (entry: ShortlistEntry) => void;
  readonly clear: () => void;
}

const DISABLED: ShortlistApi = {
  entries: EMPTY,
  enabled: false,
  has: () => false,
  toggle: () => {},
  clear: () => {},
};

const ShortlistContext = createContext<ShortlistApi>(DISABLED);

export const useShortlist = (): ShortlistApi => useContext(ShortlistContext);

export const ShortlistProvider = ({ children }: { children: ReactNode }) => {
  const entries = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const api = useMemo<ShortlistApi>(
    () => ({
      entries,
      enabled: true,
      has: (id: string) => entries.some((e) => e.id === id),
      toggle: toggleEntry,
      clear: clearEntries,
    }),
    [entries],
  );

  return <ShortlistContext.Provider value={api}>{children}</ShortlistContext.Provider>;
};
