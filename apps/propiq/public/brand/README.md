# Brand assets

Drop the PropIQ logo here and the site picks it up automatically.

Expected file, in order of preference:

    public/brand/propiq-logo.svg
    public/brand/propiq-logo.png

`src/components/brand/brand-mark.tsx` checks for these at render time on the
server. Until one exists it renders the typographic wordmark instead.

The logo is deliberately NOT recreated in CSS or SVG by hand. A wordmark that
approximates a brand is worse than an honest one that does not pretend to be
it, and the supplied asset is the source of truth.
