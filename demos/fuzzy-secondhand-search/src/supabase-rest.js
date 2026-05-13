export class SupabaseRestError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "SupabaseRestError";
    this.status = status;
    this.details = details;
  }
}

export function createSupabaseRestClient({ url, apiKey, schema = "fuzzy_secondhand", fetchImpl = fetch }) {
  if (!url || !apiKey) {
    return null;
  }

  const baseUrl = url.replace(/\/+$/, "");

  async function request(path, options = {}) {
    const headers = {
      apikey: apiKey,
      accept: "application/json",
      "content-type": "application/json",
      "accept-profile": schema,
      "content-profile": schema,
      ...(options.headers || {}),
    };

    if (!headers.authorization) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers,
    });

    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new SupabaseRestError(body?.message || response.statusText, response.status, body || text);
    }

    return body;
  }

  return {
    select(table, params = new URLSearchParams()) {
      const query = params.toString();
      return request(`/rest/v1/${table}${query ? `?${query}` : ""}`, { method: "GET" });
    },

    insert(table, rows, params = new URLSearchParams()) {
      params.set("select", "*");
      return request(`/rest/v1/${table}?${params}`, {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(rows),
      });
    },

    upsert(table, rows, conflictTarget) {
      const params = new URLSearchParams({ on_conflict: conflictTarget, select: "*" });
      return request(`/rest/v1/${table}?${params}`, {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });
    },

    update(table, patch, params = new URLSearchParams()) {
      params.set("select", "*");
      return request(`/rest/v1/${table}?${params}`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
    },

    rpc(functionName, payload = {}) {
      return request(`/rest/v1/rpc/${functionName}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    authUser(token, publishableKey = apiKey) {
      return fetchImpl(`${baseUrl}/auth/v1/user`, {
        headers: {
          apikey: publishableKey,
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      }).then(async (response) => {
        const text = await response.text();
        const body = text ? safeJson(text) : null;
        if (!response.ok) {
          throw new SupabaseRestError(body?.msg || body?.message || response.statusText, response.status, body || text);
        }
        return body;
      });
    },

    requestOtp(email, redirectTo, publishableKey = apiKey) {
      return fetchImpl(`${baseUrl}/auth/v1/otp`, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          email,
          create_user: true,
          options: redirectTo ? { email_redirect_to: redirectTo } : undefined,
        }),
      }).then(async (response) => {
        const text = await response.text();
        const body = text ? safeJson(text) : null;
        if (!response.ok) {
          throw new SupabaseRestError(body?.msg || body?.message || response.statusText, response.status, body || text);
        }
        return body;
      });
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
