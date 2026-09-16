/**
 * The declared data mode.
 *
 * Three states, named on the surface rather than inferred from an adapter:
 *
 *   live   real configured connectors; every figure is a real observation
 *   demo   a labelled synthetic dataset, badged as such on every surface
 *   empty  no source connected; a polished onboarding state, not an error
 *
 * Why this exists. The truthfulness rule is "never present sample data as live
 * Indian property intelligence" — not "never show sample data". The old guard
 * read it as the second, and refused the fixture adapter under
 * `NODE_ENV=production` outright. The result was a public deployment whose
 * every data-backed section resolved to "no property data source is connected":
 * a working scoring engine with nothing to score, which reads to a visitor as
 * an unfinished product rather than as an honest one.
 *
 * So demo is now a legitimate production mode, reachable exactly one way: by
 * declaring it publicly. `NEXT_PUBLIC_DATA_MODE` is inlined into the client
 * bundle, which is what lets the demo chrome render everywhere without a server
 * round trip — and it means the deployment that serves synthetic figures is the
 * same deployment that tells every visitor, in the header, that it is doing so.
 * There is deliberately no way to serve demo data quietly.
 */

export const DATA_MODES = ['live', 'demo', 'empty'] as const;
export type DataMode = (typeof DATA_MODES)[number];

/** The adapter each mode is backed by. One direction only: mode decides adapter. */
export const ADAPTER_FOR_MODE = {
  live: 'supabase',
  demo: 'fixture',
  empty: 'none',
} as const satisfies Readonly<Record<DataMode, 'supabase' | 'fixture' | 'none'>>;

/** The inverse, for reconciling a legacy `PROPIQ_DATA_ADAPTER` against a mode. */
export const MODE_FOR_ADAPTER = {
  supabase: 'live',
  fixture: 'demo',
  none: 'empty',
} as const satisfies Readonly<Record<'supabase' | 'fixture' | 'none', DataMode>>;

export interface DataModeCopy {
  /** Short chip text. Two words at most — it sits in the header. */
  readonly badge: string;
  /** One line, plain language, no adapter vocabulary. */
  readonly line: string;
}

export const DATA_MODE_COPY: Readonly<Record<DataMode, DataModeCopy | undefined>> = {
  live: undefined,
  demo: {
    badge: 'Demo data',
    line:
      'You are looking at an interactive product preview. Every figure is computed by the ' +
      'real scoring engine over a labelled synthetic dataset — the locality names are real ' +
      'Bengaluru localities, and none of the prices, projects or developers are.',
  },
  empty: {
    badge: 'No source connected',
    line:
      'No property source is connected to this deployment yet, so there are no properties to ' +
      'score. The calculators, the methodology and the research all work without one.',
  },
};
