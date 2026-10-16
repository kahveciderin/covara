import { Hono, type Context } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { generateUserID, isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "@/resource/error";
import type { UserContext } from "@/resource/types";
import { getClientIP, readJsonBody } from "@/server/request";
import { getGlobalKV, hasGlobalKV } from "@/kv/types";
import { enforceAbuse } from "@/abuse/enforce";
import type { EndpointCaptchaConfig, EndpointPowConfig } from "@/abuse/config";
import type { LoginThrottle } from "./login-throttle";
import type { AuthUser } from "./routes";
import {
  InMemoryPasskeyChallengeStore,
  createKVPasskeyChallengeStore,
  type PasskeyChallenge,
  type PasskeyChallengePurpose,
  type PasskeyChallengeStore,
  type PasskeyStore,
  type StoredPasskey,
} from "./passkey-store";

export * from "./passkey-store";

export type PasskeyUserVerification = "required" | "preferred" | "discouraged";

export interface PasskeyCounterRegression {
  id: string;
  userId: string;
  storedCounter: number;
  receivedCounter: number;
}

export interface PasskeyAuthOptions {
  rpId: string;
  rpName: string;
  origin: string | string[];
  store: PasskeyStore;
  challengeStore?: PasskeyChallengeStore;
  challengeTtlMs?: number;
  userVerification?: PasskeyUserVerification;
  residentKey?: "required" | "preferred" | "discouraged";
  authenticatorAttachment?: "platform" | "cross-platform";
  // Lets `/passkey/login/options` accept `{ email }` and return that user's
  // credentials as `allowCredentials` (for non-discoverable security keys).
  findUserByEmail?: (email: string) => Promise<AuthUser | null>;
  getUserName?: (user: UserContext) => string;
  maxPerUser?: number;
  basePath?: string;
  cost?: { options?: number; failed?: number };
  pow?: EndpointPowConfig;
  captcha?: EndpointCaptchaConfig;
  onRegister?: (passkey: StoredPasskey, user: UserContext, c: Context) => void | Promise<void>;
  // A validly signed assertion whose signCount did not advance: a strong signal
  // the authenticator was cloned. The login is rejected either way.
  onCounterRegression?: (info: PasskeyCounterRegression, c: Context) => void | Promise<void>;
}

export interface PasskeySummary {
  id: string;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string | null;
  backedUp: boolean | null;
  transports: string[];
}

export interface PasskeyRouterDeps {
  completeLogin: (c: Context, userId: string) => Promise<Record<string, unknown> | null>;
  requireCurrentUser: (c: Context) => Promise<UserContext>;
  throttle: LoginThrottle | null;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_NAME_LENGTH = 100;
const LOGIN_FAILED = "Passkey authentication failed";

const toSummary = (p: StoredPasskey): PasskeySummary => ({
  id: p.id,
  name: p.name ?? null,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt ?? null,
  deviceType: p.deviceType ?? null,
  backedUp: p.backedUp ?? null,
  transports: p.transports ?? [],
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readName = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`name must be a string of at most ${MAX_NAME_LENGTH} characters`);
  }
  return value.trim() || null;
};

const readCredentialResponse = (
  body: unknown,
  fields: string[]
): { credential: Record<string, unknown>; challenge: string } | null => {
  if (!isRecord(body) || !isRecord(body.response)) return null;
  const credential = body.response;
  if (typeof credential.id !== "string" || !isRecord(credential.response)) return null;
  const inner = credential.response;
  for (const field of ["clientDataJSON", ...fields]) {
    const value = inner[field];
    if (typeof value !== "string" || !isoBase64URL.isBase64URL(value)) return null;
  }
  try {
    const clientData = JSON.parse(
      isoBase64URL.toUTF8String(inner.clientDataJSON as string)
    ) as { challenge?: unknown };
    if (typeof clientData.challenge !== "string" || !clientData.challenge) return null;
    return { credential, challenge: clientData.challenge };
  } catch {
    return null;
  }
};

const readSignCount = (authenticatorData: string): number | null => {
  const bytes = isoBase64URL.toBuffer(authenticatorData);
  if (bytes.length < 37) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(33, false);
};

const isCounterRegression = (stored: number, received: number): boolean =>
  (received > 0 || stored > 0) && received <= stored;

export const createPasskeyRouter = (options: PasskeyAuthOptions, deps: PasskeyRouterDeps): Hono => {
  if (!options.rpId) throw new Error("passkey.rpId is required");
  if (!options.rpName) throw new Error("passkey.rpName is required");
  const origins = Array.isArray(options.origin) ? options.origin : [options.origin];
  if (origins.length === 0 || origins.some((o) => !o)) {
    throw new Error("passkey.origin must list at least one origin");
  }
  if (!options.store) throw new Error("passkey.store is required");

  const { store } = options;
  const challenges =
    options.challengeStore ??
    (hasGlobalKV() ? createKVPasskeyChallengeStore(getGlobalKV()) : new InMemoryPasskeyChallengeStore());
  const ttlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  const userVerification = options.userVerification ?? "preferred";
  const requireUserVerification = userVerification === "required";
  const userName = (user: UserContext): string =>
    options.getUserName?.(user) ?? user.email ?? user.name ?? user.id;

  const issueChallenge = async (
    challenge: string,
    purpose: PasskeyChallengePurpose,
    extra: Omit<PasskeyChallenge, "purpose" | "expiresAt"> = {}
  ): Promise<void> => {
    await challenges.set(challenge, { purpose, expiresAt: Date.now() + ttlMs, ...extra }, ttlMs);
  };

  const consumeChallenge = async (
    challenge: string,
    purpose: PasskeyChallengePurpose
  ): Promise<PasskeyChallenge | null> => {
    const data = await challenges.consume(challenge);
    return data && data.purpose === purpose ? data : null;
  };

  const router = new Hono();

  router.post("/register/options", async (c) => {
    const user = await deps.requireCurrentUser(c);
    const existing = await store.listByUser(user.id);
    if (options.maxPerUser !== undefined && existing.length >= options.maxPerUser) {
      throw new ConflictError("Passkey limit reached for this account");
    }
    const webauthnUserId =
      existing[0]?.webauthnUserId ?? isoBase64URL.fromBuffer(await generateUserID());

    const creation = await generateRegistrationOptions({
      rpName: options.rpName,
      rpID: options.rpId,
      userName: userName(user),
      userDisplayName: user.name ?? userName(user),
      userID: isoBase64URL.toBuffer(webauthnUserId),
      timeout: ttlMs,
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: p.transports ?? undefined,
      })),
      authenticatorSelection: {
        residentKey: options.residentKey ?? "preferred",
        userVerification,
        ...(options.authenticatorAttachment
          ? { authenticatorAttachment: options.authenticatorAttachment }
          : {}),
      },
    });

    await issueChallenge(creation.challenge, "registration", { userId: user.id, webauthnUserId });
    return c.json(creation);
  });

  router.post("/register/verify", async (c) => {
    const user = await deps.requireCurrentUser(c);
    const body = await readJsonBody(c);
    const parsed = readCredentialResponse(body, ["attestationObject"]);
    if (!parsed) throw new ValidationError("Invalid passkey registration response");
    const name = readName((body as Record<string, unknown>).name);

    const challenge = await consumeChallenge(parsed.challenge, "registration");
    if (!challenge || challenge.userId !== user.id || !challenge.webauthnUserId) {
      throw new ValidationError("Passkey challenge is invalid or expired");
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: parsed.credential as unknown as RegistrationResponseJSON,
        expectedChallenge: parsed.challenge,
        expectedOrigin: origins,
        expectedRPID: options.rpId,
        expectedType: "webauthn.create",
        requireUserVerification,
      });
    } catch {
      throw new ValidationError("Passkey registration could not be verified");
    }
    if (!verification.verified) {
      throw new ValidationError("Passkey registration could not be verified");
    }

    const info = verification.registrationInfo;
    if (await store.findById(info.credential.id)) {
      throw new ConflictError("This passkey is already registered");
    }

    const passkey: StoredPasskey = {
      id: info.credential.id,
      userId: user.id,
      webauthnUserId: challenge.webauthnUserId,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? null,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      name,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    try {
      await store.create(passkey);
    } catch {
      throw new ConflictError("This passkey is already registered");
    }
    await options.onRegister?.(passkey, user, c);

    return c.json({ passkey: toSummary(passkey) });
  });

  router.post("/login/options", async (c) => {
    await enforceAbuse(c, {
      operation: "auth.passkey.options",
      cost: options.cost?.options ?? 0,
      endpointPow: options.pow,
      endpointCaptcha: options.captcha,
    });
    const body = await readJsonBody(c);
    const email = isRecord(body) && typeof body.email === "string" ? body.email : undefined;

    let allowed: StoredPasskey[] = [];
    let userId: string | undefined;
    if (email && options.findUserByEmail) {
      // An email-scoped challenge only ever logs in that account. An unknown
      // email binds to "" (matches no credential) yet gets the same response
      // shape as a known one without passkeys, so accounts are not enumerable.
      const found = await options.findUserByEmail(email);
      userId = found?.id ?? "";
      if (found) allowed = await store.listByUser(found.id);
    }

    const request = await generateAuthenticationOptions({
      rpID: options.rpId,
      timeout: ttlMs,
      userVerification,
      allowCredentials: allowed.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
    });
    await issueChallenge(request.challenge, "authentication", userId === undefined ? {} : { userId });
    return c.json(request);
  });

  router.post("/login/verify", async (c) => {
    // Charge-on-failure, exactly like password login: gate first, settle only
    // when the attempt turns out to be a failure.
    const gate = await enforceAbuse(c, {
      operation: "auth.passkey.login",
      cost: options.cost?.failed ?? 0,
      endpointPow: options.pow,
      endpointCaptcha: options.captcha,
      defer: true,
    });
    const ip = getClientIP(c);
    const body = await readJsonBody(c);
    const parsed = readCredentialResponse(body, ["authenticatorData", "signature"]);
    if (!parsed) {
      await gate.settle();
      throw new ValidationError("Invalid passkey authentication response");
    }
    const credentialId = parsed.credential.id as string;
    const throttleKey = `passkey:${credentialId}`;

    if (deps.throttle) {
      const status = await deps.throttle.check(throttleKey, ip);
      if (status.locked) {
        throw new RateLimitError(status.retryAfterSeconds, "Too many login attempts, please try again later");
      }
    }

    const fail = async (): Promise<never> => {
      if (deps.throttle) await deps.throttle.recordFailure(throttleKey, ip);
      await gate.settle();
      throw new UnauthorizedError(LOGIN_FAILED);
    };

    const challenge = await consumeChallenge(parsed.challenge, "authentication");
    if (!challenge) return fail();

    const passkey = await store.findById(credentialId);
    if (!passkey) return fail();
    if (challenge.userId !== undefined && challenge.userId !== passkey.userId) return fail();

    const inner = parsed.credential.response as Record<string, unknown>;
    if (inner.userHandle !== undefined && inner.userHandle !== null && inner.userHandle !== "") {
      if (inner.userHandle !== passkey.webauthnUserId) return fail();
    }

    let verification;
    try {
      // The stored counter is checked below, after the signature is proven, so
      // a regression is only ever reported for a genuinely signed assertion.
      verification = await verifyAuthenticationResponse({
        response: parsed.credential as unknown as AuthenticationResponseJSON,
        expectedChallenge: parsed.challenge,
        expectedOrigin: origins,
        expectedRPID: options.rpId,
        expectedType: "webauthn.get",
        requireUserVerification,
        credential: {
          id: passkey.id,
          publicKey: isoBase64URL.toBuffer(passkey.publicKey),
          counter: 0,
          transports: passkey.transports ?? undefined,
        },
      });
    } catch {
      return fail();
    }
    if (!verification.verified) return fail();

    const receivedCounter =
      readSignCount(inner.authenticatorData as string) ?? verification.authenticationInfo.newCounter;
    if (isCounterRegression(passkey.counter, receivedCounter)) {
      await options.onCounterRegression?.(
        { id: passkey.id, userId: passkey.userId, storedCounter: passkey.counter, receivedCounter },
        c
      );
      return fail();
    }

    await store.update(passkey.id, {
      counter: receivedCounter,
      lastUsedAt: new Date(),
      backedUp: verification.authenticationInfo.credentialBackedUp,
    });

    const result = await deps.completeLogin(c, passkey.userId);
    if (!result) return fail();

    if (deps.throttle) await deps.throttle.reset(throttleKey, ip);
    return c.json(result);
  });

  router.get("/credentials", async (c) => {
    const user = await deps.requireCurrentUser(c);
    const passkeys = await store.listByUser(user.id);
    return c.json({ passkeys: passkeys.map(toSummary) });
  });

  const findOwned = async (c: Context): Promise<{ user: UserContext; passkey: StoredPasskey }> => {
    const user = await deps.requireCurrentUser(c);
    const id = c.req.param("id") ?? "";
    const passkey = await store.findById(id);
    if (!passkey || passkey.userId !== user.id) throw new NotFoundError("Passkey", id);
    return { user, passkey };
  };

  router.patch("/credentials/:id", async (c) => {
    const { passkey } = await findOwned(c);
    const body = await readJsonBody(c);
    const name = readName(isRecord(body) ? body.name : undefined);
    await store.update(passkey.id, { name });
    return c.json({ passkey: toSummary({ ...passkey, name }) });
  });

  router.delete("/credentials/:id", async (c) => {
    const { passkey } = await findOwned(c);
    await store.delete(passkey.id);
    return c.json({ success: true });
  });

  return router;
};
