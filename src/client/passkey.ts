const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((char, i) => [char, i]));

export const bufferToBase64url = (input: ArrayBuffer | ArrayBufferView): string => {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += ALPHABET[(n >> (18 - 6 * j)) & 63];
  }
  return out;
};

export const base64urlToBuffer = (input: string): ArrayBuffer => {
  const clean = input.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = LOOKUP.get(char);
    if (digit === undefined) throw new Error("Invalid base64url string");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >> bits) & 0xff;
    }
  }
  return bytes.buffer;
};

export interface PasskeyCredentialDescriptorJSON {
  id: string;
  type?: "public-key";
  transports?: string[];
}

export interface PasskeyCreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { alg: number; type: "public-key" }[];
  timeout?: number;
  excludeCredentials?: PasskeyCredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: Record<string, unknown>;
}

export interface PasskeyRequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  allowCredentials?: PasskeyCredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
  extensions?: Record<string, unknown>;
}

export interface PasskeyRegistrationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
    publicKeyAlgorithm?: number;
    publicKey?: string;
    authenticatorData?: string;
  };
  authenticatorAttachment?: string;
  clientExtensionResults: Record<string, unknown>;
}

export interface PasskeyAuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  authenticatorAttachment?: string;
  clientExtensionResults: Record<string, unknown>;
}

const toDescriptor = (d: PasskeyCredentialDescriptorJSON): PublicKeyCredentialDescriptor => ({
  type: "public-key",
  id: base64urlToBuffer(d.id),
  ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
});

const credentialsApi = (): CredentialsContainer => {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (!nav?.credentials || typeof globalThis.PublicKeyCredential === "undefined") {
    throw new Error("Passkeys (WebAuthn) are not supported in this environment");
  }
  return nav.credentials;
};

export const isPasskeySupported = (): boolean => {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  return (
    typeof globalThis.PublicKeyCredential !== "undefined" &&
    typeof nav?.credentials?.create === "function" &&
    typeof nav?.credentials?.get === "function"
  );
};

export const isConditionalMediationAvailable = async (): Promise<boolean> => {
  if (!isPasskeySupported()) return false;
  const pkc = globalThis.PublicKeyCredential as unknown as {
    isConditionalMediationAvailable?: () => Promise<boolean>;
  };
  return (await pkc.isConditionalMediationAvailable?.()) ?? false;
};

const extensionResults = (credential: PublicKeyCredential): Record<string, unknown> => {
  try {
    return (credential.getClientExtensionResults?.() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const createPasskeyCredential = async (
  options: PasskeyCreationOptionsJSON,
  init: { signal?: AbortSignal } = {}
): Promise<PasskeyRegistrationResponseJSON> => {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64urlToBuffer(options.challenge),
    user: { ...options.user, id: base64urlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(toDescriptor),
  };
  const credential = (await credentialsApi().create({
    publicKey,
    signal: init.signal,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey registration was cancelled");

  const response = credential.response as AuthenticatorAttestationResponse & {
    getTransports?: () => string[];
    getPublicKeyAlgorithm?: () => number;
    getPublicKey?: () => ArrayBuffer | null;
    getAuthenticatorData?: () => ArrayBuffer;
  };
  const publicKeyBytes = response.getPublicKey?.();
  const authenticatorData = response.getAuthenticatorData?.();
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
      ...(response.getPublicKeyAlgorithm
        ? { publicKeyAlgorithm: response.getPublicKeyAlgorithm() }
        : {}),
      ...(publicKeyBytes ? { publicKey: bufferToBase64url(publicKeyBytes) } : {}),
      ...(authenticatorData ? { authenticatorData: bufferToBase64url(authenticatorData) } : {}),
    },
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    clientExtensionResults: extensionResults(credential),
  };
};

export const getPasskeyCredential = async (
  options: PasskeyRequestOptionsJSON,
  init: { signal?: AbortSignal; mediation?: CredentialMediationRequirement } = {}
): Promise<PasskeyAuthenticationResponseJSON> => {
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(toDescriptor),
  };
  const credential = (await credentialsApi().get({
    publicKey,
    signal: init.signal,
    ...(init.mediation ? { mediation: init.mediation } : {}),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey authentication was cancelled");

  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      ...(response.userHandle && response.userHandle.byteLength > 0
        ? { userHandle: bufferToBase64url(response.userHandle) }
        : {}),
    },
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    clientExtensionResults: extensionResults(credential),
  };
};

export interface PasskeyInfo {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean | null;
  transports: string[];
}

export interface RegisterPasskeyOptions {
  name?: string;
  signal?: AbortSignal;
}

export interface LoginWithPasskeyOptions {
  // Scope the ceremony to this account's credentials (non-discoverable keys).
  // Omit for usernameless login with a discoverable passkey.
  email?: string;
  // "conditional" drives the browser's passkey autofill UI.
  mediation?: CredentialMediationRequirement;
  signal?: AbortSignal;
}
