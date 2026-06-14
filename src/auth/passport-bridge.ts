// Run arbitrary Passport.js strategies inside Covara — on Node *and* Workers.
//
// Passport strategies do not actually need Express: `Strategy.authenticate(req)`
// only reads `req.query` / `req.headers` / `req.session` / `req.body` and signals
// its result through `this.success / fail / redirect / error / pass` — methods that
// Passport core injects, not Express. We inject them ourselves and synthesize a
// minimal `req` from a Web request.
//
// The only Workers blocker is that OAuth2 strategies do their HTTP through the old
// `node-oauth` package (`node:https`). All of node-oauth's requests funnel through
// one method, `oauth2._request(...)`, so we swap that for `fetch` — after which the
// entire `passport-oauth2` family does token exchange + profile fetch over `fetch`,
// i.e. runtime-agnostic. No dependency on `passport` is added; users bring their own
// strategy packages (`passport-github2`, `passport-discord`, ...).

// Structural type for a Passport Strategy — we never import `passport`.
export interface PassportStrategyLike {
  name?: string;
  authenticate(req: PassportRequest, options?: Record<string, unknown>): void;
  // node-oauth OAuth2 client, present on every passport-oauth2-derived strategy.
  _oauth2?: OAuthLikeClient;
}

interface OAuthLikeClient {
  _request?: OAuthRequestFn;
  _customHeaders?: Record<string, string>;
  _accessTokenName?: string;
  __covaraFetchTransport?: boolean;
}

type OAuthRequestFn = (
  method: string,
  url: string,
  headers: Record<string, string> | null,
  postBody: string | Buffer | null,
  accessToken: string | null,
  callback: (
    error: unknown,
    result?: string,
    response?: { statusCode: number; headers?: Record<string, string> }
  ) => void
) => void;

export interface PassportRequest {
  query: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  session: Record<string, unknown>;
  url: string;
  method: string;
  connection: Record<string, unknown>;
}

export type PassportOutcome =
  | { kind: "redirect"; url: string; status?: number }
  | { kind: "success"; user: unknown; info?: unknown }
  | { kind: "fail"; challenge?: unknown; status?: number }
  | { kind: "error"; error: Error }
  | { kind: "pass" };

export interface NormalizedProfile {
  id?: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  username?: string | null;
  raw: unknown;
}

export interface SocialAccount {
  provider: string;
  // Stable per-provider account id (the normalized `profile.id`). Use this with
  // `provider` as the key when linking accounts to your users.
  providerAccountId: string;
  // Whatever the strategy's verify callback passed to `done(null, X)`. For a
  // standard passport strategy this is its `profile` object. If you need the
  // OAuth tokens, have your verify return them here (e.g. `done(null, { profile,
  // accessToken })`) and supply a matching `mapProfile`.
  raw: unknown;
  profile: NormalizedProfile;
  info?: unknown;
}

export interface SocialProvider {
  name: string;
  scope?: string | string[];
  authenticate(req: PassportRequest): Promise<PassportOutcome>;
  toAccount(user: unknown, info?: unknown): SocialAccount;
}

export interface FromPassportOptions {
  // Display/route name. Defaults to the strategy's own `name` (e.g. "github").
  // Required when the strategy keeps the generic default name "oauth2".
  name?: string;
  scope?: string | string[];
  // Override how the value passed to the strategy's `done(...)` is normalized.
  mapProfile?: (raw: unknown) => NormalizedProfile;
}

// Swap node-oauth's single HTTP seam for `fetch`. Idempotent per client.
export const installFetchTransport = (strategy: PassportStrategyLike): void => {
  const oauth2 = strategy._oauth2;
  if (!oauth2 || oauth2.__covaraFetchTransport) return;
  oauth2.__covaraFetchTransport = true;

  const request: OAuthRequestFn = function (
    this: OAuthLikeClient,
    method,
    url,
    headers,
    postBody,
    accessToken,
    callback
  ) {
    const realHeaders: Record<string, string> = {
      ...(this._customHeaders ?? {}),
      ...(headers ?? {}),
    };
    // fetch manages these; node-oauth would set them on the raw request.
    delete realHeaders.Host;
    delete realHeaders.host;
    delete realHeaders["Content-Length"];
    delete realHeaders["Content-length"];
    if (!realHeaders["User-Agent"]) realHeaders["User-Agent"] = "covara";

    let finalUrl = url;
    if (accessToken && !("Authorization" in realHeaders)) {
      const u = new URL(url);
      u.searchParams.set(this._accessTokenName ?? "access_token", accessToken);
      finalUrl = u.toString();
    }

    const init: RequestInit = { method, headers: realHeaders };
    if (method !== "GET" && method !== "HEAD" && postBody != null) {
      init.body = typeof postBody === "string" ? postBody : postBody.toString();
    }

    fetch(finalUrl, init)
      .then(async (res) => {
        const text = await res.text();
        const ok =
          (res.status >= 200 && res.status <= 299) ||
          res.status === 301 ||
          res.status === 302;
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        const response = { statusCode: res.status, headers: responseHeaders };
        if (ok) callback(null, text, response);
        else callback({ statusCode: res.status, data: text }, undefined, response);
      })
      .catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
  };

  oauth2._request = request;
};

// Drive a strategy's authenticate() once, capturing its delegate outcome.
export const runStrategy = (
  strategy: PassportStrategyLike,
  req: PassportRequest,
  options: Record<string, unknown> = {}
): Promise<PassportOutcome> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (outcome: PassportOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const inst = Object.create(strategy) as PassportStrategyLike & {
      success(user: unknown, info?: unknown): void;
      fail(challenge?: unknown, status?: number): void;
      redirect(url: string, status?: number): void;
      error(error: Error): void;
      pass(): void;
    };
    inst.success = (user, info) => done({ kind: "success", user, info });
    inst.fail = (challenge, status) => done({ kind: "fail", challenge, status });
    inst.redirect = (url, status) => done({ kind: "redirect", url, status });
    inst.error = (error) => done({ kind: "error", error });
    inst.pass = () => done({ kind: "pass" });
    try {
      inst.authenticate(req, options);
    } catch (e) {
      done({ kind: "error", error: e instanceof Error ? e : new Error(String(e)) });
    }
  });

const asString = (value: unknown): string | undefined =>
  value == null ? undefined : String(value);

// Normalize a standard passport `Profile` (id/displayName/emails/photos/...) and
// the looser raw-object shapes commonly returned by OAuth providers.
export const normalizePassportProfile = (raw: unknown): NormalizedProfile => {
  if (!raw || typeof raw !== "object") return { raw };
  const p = raw as Record<string, unknown>;

  const emails = p.emails as Array<{ value?: string }> | undefined;
  const photos = p.photos as Array<{ value?: string }> | undefined;
  const nameObj = p.name as
    | { givenName?: string; familyName?: string }
    | undefined;

  const email =
    emails?.[0]?.value ?? (p.email as string | undefined) ?? null;
  const image =
    photos?.[0]?.value ??
    (p.avatar_url as string | undefined) ??
    (p.picture as string | undefined) ??
    null;
  const composedName =
    (p.displayName as string | undefined) ??
    (typeof p.name === "string" ? (p.name as string) : undefined) ??
    (nameObj?.givenName
      ? `${nameObj.givenName} ${nameObj.familyName ?? ""}`.trim()
      : undefined) ??
    null;

  return {
    id: asString(p.id) ?? asString(p.sub) ?? asString(p.user_id),
    email,
    image,
    name: composedName,
    username:
      (p.username as string | undefined) ??
      (p.login as string | undefined) ??
      null,
    raw,
  };
};

// Adapt an instantiated Passport strategy into a Covara social provider.
export const fromPassport = (
  strategy: PassportStrategyLike,
  options: FromPassportOptions = {}
): SocialProvider => {
  installFetchTransport(strategy);
  const name = options.name ?? strategy.name;
  if (!name || name === "oauth2") {
    throw new Error(
      "fromPassport: could not infer a provider name — pass `{ name }` " +
        "(the strategy's default name is the generic 'oauth2')."
    );
  }
  const mapProfile = options.mapProfile ?? normalizePassportProfile;
  return {
    name,
    scope: options.scope,
    async authenticate(req) {
      const opts: Record<string, unknown> = {};
      if (options.scope) opts.scope = options.scope;
      return runStrategy(strategy, req, opts);
    },
    toAccount(user, info) {
      const profile = mapProfile(user);
      return {
        provider: name,
        providerAccountId: profile.id ?? "",
        raw: user,
        profile,
        info,
      };
    },
  };
};
