import type { Env, ModelProvider } from "./types.js";

interface Credential {
  id: string;
  user_id: string;
  provider: string;
  credential_type: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  metadata: string | null;
}

interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
}

const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  openai: {
    authorizeUrl: "https://auth.openai.com/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: "openid profile email model.request.write",
  },
  anthropic: {
    authorizeUrl: "https://console.anthropic.com/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/oauth/token",
    scopes: "messages:write",
  },
};

/**
 * Get API key for a provider — checks user credentials first, falls back to env secrets.
 */
export async function getApiKey(
  env: Env,
  provider: ModelProvider,
  userId: string = "default",
): Promise<string | null> {
  // Check user credentials in D1
  const cred = await env.DB.prepare(
    `SELECT access_token, credential_type, token_expires_at, refresh_token
     FROM credentials WHERE user_id = ? AND provider = ?`,
  )
    .bind(userId, provider)
    .first<Credential>();

  if (cred?.access_token) {
    // Check if OAuth token needs refresh
    if (cred.credential_type === "oauth_token" && cred.token_expires_at) {
      const expiresAt = new Date(cred.token_expires_at);
      if (expiresAt < new Date() && cred.refresh_token) {
        const refreshed = await refreshOAuthToken(env, provider, cred.refresh_token, userId);
        if (refreshed) return refreshed;
      }
    }
    return cred.access_token;
  }

  // Fallback to env secrets
  switch (provider) {
    case "openai": return env.OPENAI_API_KEY ?? null;
    case "anthropic": return env.ANTHROPIC_API_KEY ?? null;
    default: return null;
  }
}

/**
 * Handle OAuth routes: /auth/:provider/connect, /auth/:provider/callback
 */
export async function handleAuthRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const appUrl = env.APP_URL ?? url.origin;

  // GET /auth/:provider/connect — redirect to OAuth provider
  const connectMatch = url.pathname.match(/^\/auth\/(openai|anthropic)\/connect$/);
  if (connectMatch && request.method === "GET") {
    const provider = connectMatch[1];
    const config = OAUTH_CONFIGS[provider];
    const clientId = provider === "openai" ? env.OPENAI_CLIENT_ID : env.ANTHROPIC_CLIENT_ID;

    if (!clientId || !config) {
      return Response.json({ error: `OAuth not configured for ${provider}` }, { status: 400 });
    }

    const state = crypto.randomUUID();
    // Store state in KV for CSRF protection
    await env.CACHE.put(`oauth_state:${state}`, provider, { expirationTtl: 600 });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${appUrl}/auth/${provider}/callback`,
      response_type: "code",
      scope: config.scopes,
      state,
    });

    return Response.redirect(`${config.authorizeUrl}?${params}`);
  }

  // GET /auth/:provider/callback — exchange code for token
  const callbackMatch = url.pathname.match(/^\/auth\/(openai|anthropic)\/callback$/);
  if (callbackMatch && request.method === "GET") {
    const provider = callbackMatch[1];
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return Response.json({ error: `OAuth error: ${error}` }, { status: 400 });
    }
    if (!code || !state) {
      return Response.json({ error: "Missing code or state" }, { status: 400 });
    }

    // Verify CSRF state
    const storedProvider = await env.CACHE.get(`oauth_state:${state}`);
    if (storedProvider !== provider) {
      return Response.json({ error: "Invalid state" }, { status: 400 });
    }
    await env.CACHE.delete(`oauth_state:${state}`);

    // Exchange code for token
    const config = OAUTH_CONFIGS[provider];
    const clientId = provider === "openai" ? env.OPENAI_CLIENT_ID : env.ANTHROPIC_CLIENT_ID;
    const clientSecret = provider === "openai" ? env.OPENAI_CLIENT_SECRET : env.ANTHROPIC_CLIENT_SECRET;

    const tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${appUrl}/auth/${provider}/callback`,
        client_id: clientId!,
        client_secret: clientSecret!,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return Response.json({ error: `Token exchange failed: ${err}` }, { status: 400 });
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    const userId = "default"; // TODO: extract from session/JWT
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Upsert credential
    await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, access_token, refresh_token, token_expires_at, scopes)
       VALUES (?, ?, ?, 'oauth_token', ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, credentials.refresh_token),
         token_expires_at = excluded.token_expires_at,
         scopes = excluded.scopes,
         updated_at = datetime('now')`,
    )
      .bind(
        crypto.randomUUID(), userId, provider,
        tokens.access_token, tokens.refresh_token ?? null,
        expiresAt, tokens.scope ?? config.scopes,
      )
      .run();

    // Redirect to dashboard with success
    return Response.redirect(`${appUrl}/?connected=${provider}`);
  }

  // POST /auth/:provider/apikey — store API key directly
  const apikeyMatch = url.pathname.match(/^\/auth\/(openai|anthropic)\/apikey$/);
  if (apikeyMatch && request.method === "POST") {
    const provider = apikeyMatch[1];
    const body = (await request.json()) as { apiKey: string; userId?: string };
    const userId = body.userId ?? "default";

    await env.DB.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, access_token)
       VALUES (?, ?, ?, 'api_key', ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         access_token = excluded.access_token,
         credential_type = 'api_key',
         updated_at = datetime('now')`,
    )
      .bind(crypto.randomUUID(), userId, provider, body.apiKey)
      .run();

    return Response.json({ ok: true, provider, userId });
  }

  // GET /auth/status — check which providers are connected
  if (url.pathname === "/auth/status" && request.method === "GET") {
    const userId = url.searchParams.get("userId") ?? "default";
    const { results } = await env.DB.prepare(
      `SELECT provider, credential_type, token_expires_at, scopes, updated_at
       FROM credentials WHERE user_id = ?`,
    )
      .bind(userId)
      .all();

    return Response.json({
      providers: results,
      oauth_available: {
        openai: !!env.OPENAI_CLIENT_ID,
        anthropic: !!env.ANTHROPIC_CLIENT_ID,
      },
      fallback_keys: {
        openai: !!env.OPENAI_API_KEY,
        anthropic: !!env.ANTHROPIC_API_KEY,
      },
    });
  }

  return null;
}

async function refreshOAuthToken(
  env: Env,
  provider: string,
  refreshToken: string,
  userId: string,
): Promise<string | null> {
  const config = OAUTH_CONFIGS[provider];
  const clientId = provider === "openai" ? env.OPENAI_CLIENT_ID : env.ANTHROPIC_CLIENT_ID;
  const clientSecret = provider === "openai" ? env.OPENAI_CLIENT_SECRET : env.ANTHROPIC_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) return null;

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(
    `UPDATE credentials SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
     token_expires_at = ?, updated_at = datetime('now')
     WHERE user_id = ? AND provider = ?`,
  )
    .bind(tokens.access_token, tokens.refresh_token ?? null, expiresAt, userId, provider)
    .run();

  return tokens.access_token;
}
