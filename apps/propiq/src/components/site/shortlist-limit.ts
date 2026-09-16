/**
 * The Decision Room renders at most four columns; the tray must not exceed it.
 *
 * This lives in its own module, without `'use client'`, because server
 * components need the number too. Exporting it from `shortlist.tsx` made it a
 * client-boundary reference: importing it on the server did not yield `4`, it
 * yielded a proxy that React rendered as its own "attempted to call a client
 * function from the server" error text, straight into the page.
 */
export const SHORTLIST_LIMIT = 4;
