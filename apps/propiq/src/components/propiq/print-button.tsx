'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Print / save as PDF.
 *
 * The browser's own print pipeline rather than a server-side renderer: it
 * produces a real PDF with selectable text, needs no extra dependency, and
 * works offline. A server renderer earns its place when reports need to be
 * emailed or stored, not before.
 */
export const PrintButton = () => (
  <Button type="button" variant="secondary" onClick={() => window.print()}>
    <Printer aria-hidden /> Print or save as PDF
  </Button>
);
