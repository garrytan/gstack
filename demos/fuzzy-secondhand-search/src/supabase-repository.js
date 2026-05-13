import { dbRowToListing, normalizedListingToDbRow } from "./listing-mapper.js";
import { createSupabaseRestClient } from "./supabase-rest.js";

export function createSupabaseRepository({
  env = process.env,
  fetchImpl = fetch,
  schema = "fuzzy_secondhand",
} = {}) {
  const serviceKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const client = createSupabaseRestClient({
    url: env.SUPABASE_URL,
    apiKey: serviceKey,
    schema,
    fetchImpl,
  });
  const authClient = createSupabaseRestClient({
    url: env.SUPABASE_URL,
    apiKey: publishableKey,
    schema,
    fetchImpl,
  });

  function assertConfigured() {
    if (!client) {
      const error = new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.");
      error.status = 503;
      throw error;
    }
  }

  return {
    isConfigured: Boolean(client && authClient),

    async requestOtp(email, redirectTo) {
      if (!authClient || !publishableKey) {
        const error = new Error("Supabase Auth is not configured.");
        error.status = 503;
        throw error;
      }
      return authClient.requestOtp(email, redirectTo, publishableKey);
    },

    async verifyAccessToken(token) {
      if (!authClient || !publishableKey) {
        const error = new Error("Supabase Auth is not configured.");
        error.status = 503;
        throw error;
      }
      const user = await authClient.authUser(token, publishableKey);
      return {
        id: user.id,
        email: user.email,
      };
    },

    async claimBetaInvite(user) {
      assertConfigured();
      const rows = await client.rpc("claim_beta_invite", {
        p_email: user.email,
        p_user_id: user.id,
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async assertEmailInvited(email) {
      assertConfigured();
      const params = new URLSearchParams({
        select: "email,accepted_at",
        email: `eq.${email}`,
        limit: "1",
      });
      const rows = await client.select("beta_invites", params);
      if (rows.length === 0) {
        const error = new Error("Beta invite required.");
        error.status = 403;
        throw error;
      }
      return rows[0];
    },

    async searchableListings({ limit = 500 } = {}) {
      assertConfigured();
      const params = new URLSearchParams({
        select: "*",
        status: "eq.active",
        stale_after: `gte.${new Date().toISOString()}`,
        order: "seen_at.desc",
        limit: String(limit),
      });
      const rows = await client.select("listings", params);
      return rows.map(dbRowToListing);
    },

    async recordSearchEvent({ user, query, intent, results }) {
      assertConfigured();
      const top = results[0]?.listing;
      await client.insert("search_events", [{
        user_id: user.id,
        email: user.email,
        query,
        intent,
        result_count: results.length,
        top_listing_id: top?.id || null,
      }]);
    },

    async saveSearch({ user, query, cadence = "daily" }) {
      assertConfigured();
      const rows = await client.insert("saved_searches", [{
        user_id: user.id,
        email: user.email,
        query,
        cadence,
        active: true,
      }]);
      return rows[0];
    },

    async ensureSource(source) {
      assertConfigured();
      const rows = await client.upsert("listing_sources", [{
        source_key: source.key,
        name: source.name,
        homepage_url: source.homepageUrl || null,
        adapter: source.adapter || source.key,
        enabled: source.enabled !== false,
        crawl_delay_seconds: source.crawlDelaySeconds || 10,
        terms_url: source.termsUrl || null,
      }], "source_key");
      return rows[0];
    },

    async startIngestionRun(sourceKey, metadata = {}) {
      assertConfigured();
      const rows = await client.insert("ingestion_runs", [{
        source_key: sourceKey,
        status: "running",
        metadata,
      }]);
      return rows[0];
    },

    async finishIngestionRun(runId, patch) {
      assertConfigured();
      const params = new URLSearchParams({ id: `eq.${runId}` });
      const rows = await client.update("ingestion_runs", {
        ...patch,
        finished_at: new Date().toISOString(),
      }, params);
      return rows[0];
    },

    async upsertListings(source, listings) {
      assertConfigured();
      if (listings.length === 0) return [];
      const sourceRow = await this.ensureSource(source);
      const rows = listings
        .filter((listing) => listing.sourceUrl && listing.title && listing.price)
        .map((listing) => normalizedListingToDbRow(listing, sourceRow.id));
      if (rows.length === 0) return [];
      return client.upsert("listings", rows, "source_url");
    },
  };
}
