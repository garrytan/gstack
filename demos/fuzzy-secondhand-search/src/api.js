import { searchListings } from "./search-engine.js";

export function createApiHandler({ repository, ingestion, env = process.env } = {}) {
  return async function handleApiRequest(request) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/config") {
        return json({
          authEnabled: repository?.isConfigured ?? false,
          supabaseUrl: env.SUPABASE_URL || "",
          supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
        });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/request-otp") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email);
        if (!email) return json({ error: "Valid email is required." }, 400);
        await repository.assertEmailInvited(email);
        await repository.requestOtp(email, body.redirectTo || request.headers.get("origin") || undefined);
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/search") {
        const user = await requireBetaUser(request, repository);
        const query = url.searchParams.get("q") || "";
        const listings = await repository.searchableListings();
        const payload = searchListings(query, listings);
        await repository.recordSearchEvent({
          user,
          query,
          intent: payload.intent,
          results: payload.results,
        });
        return json(payload);
      }

      if (request.method === "POST" && url.pathname === "/api/saved-searches") {
        const user = await requireBetaUser(request, repository);
        const body = await readJson(request);
        if (!String(body.query || "").trim()) return json({ error: "Query is required." }, 400);
        const saved = await repository.saveSearch({
          user,
          query: String(body.query).trim(),
          cadence: body.cadence || "daily",
        });
        return json({ saved });
      }

      if (request.method === "POST" && url.pathname === "/api/ingest/run") {
        const expected = env.INGEST_ADMIN_TOKEN;
        const provided = bearerToken(request) || request.headers.get("x-ingest-token");
        if (!expected || provided !== expected) return json({ error: "Invalid ingestion token." }, 401);
        const body = await readJson(request, {});
        const summary = await ingestion.run({ only: body.sourceKey || null });
        return json({ summary });
      }

      return json({ error: "API route not found." }, 404);
    } catch (error) {
      const status = normalizeStatus(error);
      return json({ error: safeErrorMessage(error, status) }, status);
    }
  };
}

async function requireBetaUser(request, repository) {
  const token = bearerToken(request);
  if (!token) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }

  const user = await repository.verifyAccessToken(token);
  if (!user?.email || !user?.id) {
    const error = new Error("Invalid Supabase session.");
    error.status = 401;
    throw error;
  }

  await repository.claimBetaInvite(user);
  return user;
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function readJson(request, fallback = null) {
  const text = await request.text();
  if (!text) return fallback || {};
  return JSON.parse(text);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

function normalizeStatus(error) {
  if (Number.isInteger(error?.status)) {
    if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 || error.status === 503) {
      return error.status;
    }
    if (error.status >= 400 && error.status < 500) return 403;
    return 503;
  }
  if (/invite|required|limit reached/i.test(error?.message || "")) return 403;
  return 500;
}

function safeErrorMessage(error, status) {
  if (status >= 500) return "Service is temporarily unavailable.";
  return error?.message || "Request failed.";
}
