'use client';

/**
 * The header's search affordance, and the palette's second way in.
 *
 * It does not hold a reference to the palette. The header is a server
 * component, so a callback cannot be handed down to it from the client
 * component that owns the dialog — a function is not serialisable across that
 * boundary. Rather than restructure the header around that constraint, the
 * trigger announces the intent on `window` and whoever is listening opens.
 *
 * One entry point, two gestures: this button and Cmd/Ctrl-K both raise the
 * same event, so there is never a search box in the header that disagrees with
 * the palette about what searching means.
 */

import { Command, Search } from 'lucide-react';

export const OPEN_PALETTE_EVENT = 'propiq:open-palette';

export const openPalette = (): void => {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
};

export const PaletteTrigger = () => (
  <button
    type="button"
    onClick={openPalette}
    aria-label="Search PropIQ"
    className="hidden items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-2.5 py-2 text-[13px] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)] md:inline-flex xl:px-3"
  >
    <Search aria-hidden className="size-3.5" />
    {/* Between `lg` and `xl` the mega menu, the word "Search", Login and the
        primary action together run 36px past a 1024px viewport. The word is
        the least load-bearing of the four — the icon and the shortcut still
        say what the control is — so it is what goes. */}
    <span className="hidden xl:inline">Search</span>
    <kbd className="inline-flex items-center gap-0.5 rounded border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] xl:ml-1">
      <Command aria-hidden className="size-2.5" />K
    </kbd>
  </button>
);
