/**
 * Carpet area arithmetic.
 *
 * The single most expensive thing an Indian buyer misunderstands. A flat is
 * advertised on super built-up area, paid for on super built-up area, and
 * lived in on carpet area, and the gap between the two — the loading — is set
 * by the builder with no ceiling on it. Two flats quoted at the same rate per
 * square foot can differ by a fifth in what you can actually put furniture on.
 *
 * RERA §4(2)(l)(C) requires carpet area to be disclosed, which is what makes
 * this computable rather than a guess. Everything here is arithmetic over
 * numbers the buyer supplies, so it is correct for any property in any market
 * and depends on no dataset of ours.
 *
 * Carpet area under RERA is the net usable floor area inside the walls,
 * including internal partition walls and excluding the external walls,
 * service shafts, balcony and open terrace. That definition matters: a
 * "carpet area" quoted on a builder's brochure is not always this one.
 */

/**
 * Loading is expressed against the carpet area, which is how builders quote
 * it: "20% loading" means the super built-up is 1.2× the carpet.
 *
 * Returned as a fraction, so 0.2 is 20%. `undefined` when the inputs cannot
 * support the calculation, never a plausible zero.
 */
export const loadingFactor = (
  carpetAreaSqFt: number,
  superBuiltUpSqFt: number,
): number | undefined => {
  if (!(carpetAreaSqFt > 0) || !(superBuiltUpSqFt > 0)) return undefined;
  if (superBuiltUpSqFt < carpetAreaSqFt) return undefined;
  return superBuiltUpSqFt / carpetAreaSqFt - 1;
};

/** Carpet as a share of what you are billed for. The inverse view of loading. */
export const carpetEfficiency = (
  carpetAreaSqFt: number,
  superBuiltUpSqFt: number,
): number | undefined => {
  if (!(carpetAreaSqFt > 0) || !(superBuiltUpSqFt > 0)) return undefined;
  if (superBuiltUpSqFt < carpetAreaSqFt) return undefined;
  return carpetAreaSqFt / superBuiltUpSqFt;
};

/** Super built-up implied by a carpet area and a quoted loading percentage. */
export const superBuiltUpFrom = (
  carpetAreaSqFt: number,
  loadingPercent: number,
): number | undefined => {
  if (!(carpetAreaSqFt > 0) || loadingPercent < 0) return undefined;
  return carpetAreaSqFt * (1 + loadingPercent / 100);
};

/** Carpet implied by a super built-up area and a quoted loading percentage. */
export const carpetFrom = (
  superBuiltUpSqFt: number,
  loadingPercent: number,
): number | undefined => {
  if (!(superBuiltUpSqFt > 0) || loadingPercent < 0) return undefined;
  return superBuiltUpSqFt / (1 + loadingPercent / 100);
};

export interface AreaQuote {
  readonly label: string;
  readonly totalPrice: number;
  readonly superBuiltUpSqFt: number;
  readonly carpetAreaSqFt: number;
}

export interface AreaAnalysis {
  readonly label: string;
  readonly totalPrice: number;
  readonly superBuiltUpSqFt: number;
  readonly carpetAreaSqFt: number;
  readonly loading: number | undefined;
  readonly efficiency: number | undefined;
  /** The advertised rate. Not comparable across projects, and that is the point. */
  readonly quotedPsf: number | undefined;
  /** The only rate that compares across projects. */
  readonly carpetPsf: number | undefined;
  /** What the unusable area costs you, in rupees. */
  readonly loadingCost: number | undefined;
}

export const analyseQuote = (quote: AreaQuote): AreaAnalysis => {
  const { totalPrice, superBuiltUpSqFt, carpetAreaSqFt } = quote;
  const usable = totalPrice > 0 && superBuiltUpSqFt > 0;
  const carpetUsable = totalPrice > 0 && carpetAreaSqFt > 0;
  const loading = loadingFactor(carpetAreaSqFt, superBuiltUpSqFt);
  const carpetPsf = carpetUsable ? totalPrice / carpetAreaSqFt : undefined;
  const quotedPsf = usable ? totalPrice / superBuiltUpSqFt : undefined;

  return {
    label: quote.label,
    totalPrice,
    superBuiltUpSqFt,
    carpetAreaSqFt,
    loading,
    efficiency: carpetEfficiency(carpetAreaSqFt, superBuiltUpSqFt),
    quotedPsf,
    carpetPsf,
    // The rupees attached to floor you cannot stand on. Not a scandal on its
    // own — lobbies and lifts are real — but it is the number nobody quotes.
    loadingCost:
      quotedPsf === undefined || superBuiltUpSqFt < carpetAreaSqFt
        ? undefined
        : quotedPsf * (superBuiltUpSqFt - carpetAreaSqFt),
  };
};

export interface QuoteComparison {
  readonly quotes: readonly AreaAnalysis[];
  /** Cheapest on a carpet basis. `undefined` when no quote can be compared. */
  readonly bestOnCarpet: AreaAnalysis | undefined;
  /** Cheapest on the advertised rate, which is often a different flat. */
  readonly bestOnQuoted: AreaAnalysis | undefined;
  /**
   * True when the advertised-rate winner is not the carpet-rate winner — the
   * case the whole tool exists to catch.
   */
  readonly headlineMisleads: boolean;
  /** Extra rupees per carpet square foot between best and worst. */
  readonly carpetSpread: number | undefined;
}

export const compareQuotes = (quotes: readonly AreaQuote[]): QuoteComparison => {
  const analyses = quotes.map(analyseQuote);
  const withCarpet = analyses.filter((a) => a.carpetPsf !== undefined);
  const withQuoted = analyses.filter((a) => a.quotedPsf !== undefined);

  const bestOnCarpet = withCarpet.reduce<AreaAnalysis | undefined>(
    (best, a) => ((a.carpetPsf ?? Infinity) < (best?.carpetPsf ?? Infinity) ? a : best),
    undefined,
  );
  const bestOnQuoted = withQuoted.reduce<AreaAnalysis | undefined>(
    (best, a) => ((a.quotedPsf ?? Infinity) < (best?.quotedPsf ?? Infinity) ? a : best),
    undefined,
  );

  const carpetRates = withCarpet.map((a) => a.carpetPsf ?? 0);

  return {
    quotes: analyses,
    bestOnCarpet,
    bestOnQuoted,
    headlineMisleads:
      bestOnCarpet !== undefined &&
      bestOnQuoted !== undefined &&
      bestOnCarpet.label !== bestOnQuoted.label,
    carpetSpread:
      carpetRates.length < 2 ? undefined : Math.max(...carpetRates) - Math.min(...carpetRates),
  };
};
