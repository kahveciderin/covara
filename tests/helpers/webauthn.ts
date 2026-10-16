import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

const head = (major: number, length: number): Uint8Array => {
  const m = major << 5;
  if (length < 24) return Uint8Array.of(m | length);
  if (length < 0x100) return Uint8Array.of(m | 24, length);
  if (length < 0x10000) return Uint8Array.of(m | 25, length >> 8, length & 0xff);
  return Uint8Array.of(
    m | 26,
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff
  );
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

export const cborEncode = (value: CborValue): Uint8Array => {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(cborEncode));
  const entries = [...value.entries()];
  return concat(
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])
  );
};

export const b64url = (bytes: Uint8Array | Buffer): string =>
  Buffer.from(bytes).toString("base64url");

const sha256 = (data: Uint8Array | string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(data).digest());

const u32 = (n: number): Uint8Array =>
  Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;

export type FakeAlg = "ES256" | "RS256";

interface CreationOptionsLike {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string }[];
}

interface RequestOptionsLike {
  challenge: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
}

export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  challenge?: string;
  type?: string;
  up?: boolean;
  uv?: boolean;
  counter?: number;
  userHandle?: string | null;
  tamperSignature?: boolean;
  crossOrigin?: boolean;
}

export interface FakeAuthenticatorOptions {
  alg?: FakeAlg;
  origin: string;
  rpId: string;
  credentialId?: Uint8Array;
  backupEligible?: boolean;
}

const cosePublicKey = (alg: FakeAlg, publicKey: KeyObject): Uint8Array => {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  if (alg === "ES256") {
    return cborEncode(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, bytes(jwk.x)],
        [-3, bytes(jwk.y)],
      ])
    );
  }
  return cborEncode(
    new Map<CborValue, CborValue>([
      [1, 3],
      [3, -257],
      [-1, bytes(jwk.n)],
      [-2, bytes(jwk.e)],
    ])
  );
};

export const createFakeAuthenticator = (options: FakeAuthenticatorOptions) => {
  const alg = options.alg ?? "ES256";
  const { publicKey, privateKey } =
    alg === "ES256"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentialId = options.credentialId ?? new Uint8Array(randomBytes(32));
  const id = b64url(credentialId);
  let counter = 0;
  let userHandle: string | null = null;

  const flagsFor = (o: CeremonyOverrides, extra = 0): number =>
    (o.up === false ? 0 : FLAG_UP) |
    (o.uv === false ? 0 : FLAG_UV) |
    (options.backupEligible ? FLAG_BE | FLAG_BS : 0) |
    extra;

  const clientData = (
    type: string,
    challenge: string,
    o: CeremonyOverrides
  ): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        type: o.type ?? type,
        challenge: o.challenge ?? challenge,
        origin: o.origin ?? options.origin,
        crossOrigin: o.crossOrigin ?? false,
      })
    );

  const register = (creation: CreationOptionsLike, o: CeremonyOverrides = {}) => {
    userHandle = creation.user.id;
    const rpId = o.rpId ?? creation.rp.id ?? options.rpId;
    const clientDataJSON = clientData("webauthn.create", creation.challenge, o);
    const attestedCredentialData = concat(
      new Uint8Array(16),
      Uint8Array.of((credentialId.length >> 8) & 0xff, credentialId.length & 0xff),
      credentialId,
      cosePublicKey(alg, publicKey)
    );
    const authData = concat(
      sha256(rpId),
      Uint8Array.of(flagsFor(o, FLAG_AT)),
      u32(o.counter ?? counter),
      attestedCredentialData
    );
    const attestationObject = cborEncode(
      new Map<CborValue, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ])
    );
    return {
      id,
      rawId: id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  };

  const authenticate = (request: RequestOptionsLike, o: CeremonyOverrides = {}) => {
    counter = o.counter ?? counter + 1;
    const rpId = o.rpId ?? request.rpId ?? options.rpId;
    const clientDataJSON = clientData("webauthn.get", request.challenge, o);
    const authenticatorData = concat(sha256(rpId), Uint8Array.of(flagsFor(o)), u32(counter));
    const signed = concat(authenticatorData, sha256(clientDataJSON));
    let signature = new Uint8Array(sign("sha256", signed, privateKey));
    if (o.tamperSignature) {
      signature = new Uint8Array(signature);
      signature[signature.length - 1] ^= 0xff;
    }
    const handle = o.userHandle === undefined ? userHandle : o.userHandle;
    return {
      id,
      rawId: id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(handle ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  };

  return {
    id,
    alg,
    get counter() {
      return counter;
    },
    set counter(n: number) {
      counter = n;
    },
    get userHandle() {
      return userHandle;
    },
    register,
    authenticate,
  };
};

export type FakeAuthenticator = ReturnType<typeof createFakeAuthenticator>;
