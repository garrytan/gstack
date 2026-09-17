/**
 * The navigation model.
 *
 * A plain module, not a component: the header, the mobile sheet and the command
 * palette all read the same structure, and `navigation.test.ts` reads it too.
 * Three copies of a menu is three chances for one of them to point somewhere
 * that does not exist.
 *
 * Every `href` here resolves to a route that is actually built. The brief this
 * was drawn from lists a larger menu — a dedicated map page, affordability and
 * stamp-duty calculators, a guides hub — and those entries are simply absent
 * rather than pointed at the nearest page that happens to load. A nav item that
 * goes somewhere other than its label is the fastest way to teach a visitor
 * that the rest of the product is not real either.
 */

export interface NavLink {
  readonly href: string;
  readonly label: string;
  /** One line, shown in the mega menu. Omitted in compact surfaces. */
  readonly blurb?: string;
}

export interface NavGroup {
  readonly id: string;
  readonly label: string;
  readonly columns: readonly {
    readonly heading: string;
    readonly links: readonly NavLink[];
  }[];
  /** The one thing worth doing from this menu if you do nothing else. */
  readonly feature?: {
    readonly href: string;
    readonly title: string;
    readonly body: string;
  };
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'discover',
    label: 'Discover',
    columns: [
      {
        heading: 'Find',
        links: [
          { href: '/search', label: 'Properties', blurb: 'Scored, ranked and filterable' },
          { href: '/localities', label: 'Localities', blurb: 'Every covered area, compared' },
          { href: '/developers', label: 'Developers', blurb: 'Delivery record, not reputation' },
        ],
      },
      {
        heading: 'Decide',
        links: [
          { href: '/compare', label: 'Compare', blurb: 'Up to four, side by side' },
          { href: '/decision-room', label: 'Decision Room', blurb: 'Where a shortlist is settled' },
          {
            href: '/valuation',
            label: 'Analyze a property',
            blurb: 'Fair value and what it rests on',
          },
        ],
      },
    ],
    feature: {
      href: '/#map',
      title: 'The covered market, mapped',
      body: 'Every property on its real coordinates, coloured by the verdict the engine reached.',
    },
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    columns: [
      {
        heading: 'The property',
        links: [
          {
            href: '/valuation',
            label: 'Price intelligence',
            blurb: 'Fair value against comparables',
          },
          {
            href: '/document-ai',
            label: 'Document intelligence',
            blurb: 'Title, Khata, RERA, approvals',
          },
          {
            href: '/methodology',
            label: 'Risk and scoring',
            blurb: 'The formula, published in full',
          },
        ],
      },
      {
        heading: 'The context',
        links: [
          {
            href: '/localities',
            label: 'Location intelligence',
            blurb: 'Connectivity, supply, livability',
          },
          {
            href: '/developers',
            label: 'Developer intelligence',
            blurb: 'On-time record and delays',
          },
          {
            href: '/investment',
            label: 'Investment intelligence',
            blurb: 'Yield, IRR and cash flow',
          },
        ],
      },
    ],
    feature: {
      href: '/methodology',
      title: 'Nothing here is a black box',
      body: 'Twelve pillars, their weights, their signals and the version they were computed under.',
    },
  },
  {
    id: 'tools',
    label: 'Tools',
    columns: [
      {
        heading: 'Calculators',
        links: [
          { href: '/tools/emi', label: 'Home loan EMI', blurb: 'Monthly outgo and total interest' },
          {
            href: '/tools/rental-yield',
            label: 'Rental yield',
            blurb: 'Gross and net, on real inputs',
          },
          {
            href: '/tools/carpet-area',
            label: 'Carpet vs super built-up',
            blurb: 'What you are paying for',
          },
        ],
      },
      {
        heading: 'Before you buy',
        links: [
          {
            href: '/site-visit-checklist',
            label: 'Site visit checklist',
            blurb: 'What to check, in order',
          },
          { href: '/checks/khata', label: 'Document guides', blurb: 'What each one proves' },
          { href: '/tools', label: 'All free tools', blurb: 'No account needed' },
        ],
      },
    ],
  },
  {
    id: 'research',
    label: 'Research',
    columns: [
      {
        heading: 'Read',
        links: [
          { href: '/research', label: 'Market reports', blurb: 'Dated, sourced and versioned' },
          { href: '/methodology', label: 'Methodology', blurb: 'How every number is reached' },
          { href: '/data-sources', label: 'Data sources', blurb: 'Where the evidence comes from' },
        ],
      },
      {
        heading: 'Company',
        links: [
          { href: '/about', label: 'About PropIQ' },
          { href: '/pricing', label: 'Pricing' },
          { href: '/privacy', label: 'Privacy' },
        ],
      },
    ],
  },
];

/** Flattened, for the mobile sheet and the command palette. */
export const NAV_LINKS: readonly NavLink[] = NAV_GROUPS.flatMap((g) =>
  g.columns.flatMap((c) => c.links),
);
