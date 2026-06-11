import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Algorithm, JWK, KeyConfig, KeyManager, KeyPair } from "../types";

const generateKeyId = (): string => {
  return crypto.randomBytes(16).toString("hex");
};

const generateRSAKeyPair = async (
  algorithm: Algorithm
): Promise<{ privateKey: string; publicKey: string }> => {
  return new Promise((resolve, reject) => {
    const modulusLength = algorithm.includes("384") ? 3072 : 2048;
    crypto.generateKeyPair(
      "rsa",
      {
        modulusLength,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
      (err, publicKey, privateKey) => {
        if (err) reject(err);
        else resolve({ publicKey, privateKey });
      }
    );
  });
};

const generateECKeyPair = async (
  algorithm: Algorithm
): Promise<{ privateKey: string; publicKey: string }> => {
  const namedCurve =
    algorithm === "ES256"
      ? "prime256v1"
      : algorithm === "ES384"
        ? "secp384r1"
        : "secp521r1";

  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      "ec",
      {
        namedCurve,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
      (err, publicKey, privateKey) => {
        if (err) reject(err);
        else resolve({ publicKey, privateKey });
      }
    );
  });
};

const rsaPublicKeyToJWK = (publicKey: string, kid: string, alg: string): JWK => {
  const keyObject = crypto.createPublicKey(publicKey);
  const exported = keyObject.export({ format: "jwk" });

  return {
    kty: "RSA",
    use: "sig",
    alg,
    kid,
    n: exported.n as string,
    e: exported.e as string,
  };
};

const ecPublicKeyToJWK = (publicKey: string, kid: string, alg: string): JWK => {
  const keyObject = crypto.createPublicKey(publicKey);
  const exported = keyObject.export({ format: "jwk" });

  return {
    kty: "EC",
    use: "sig",
    alg,
    kid,
    x: exported.x as string,
    y: exported.y as string,
    crv: exported.crv as string,
  };
};

export const createKeyManager = (config: KeyConfig): KeyManager => {
  const algorithm: Algorithm = config.algorithm ?? "RS256";
  const isEC = algorithm.startsWith("ES");
  const keys = new Map<string, KeyPair>();
  let currentKeyId: string;
  let initialized = false;
  let initPromise: Promise<void> | null = null;

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (config.privateKey) {
        const privateKey =
          typeof config.privateKey === "string"
            ? config.privateKey
            : config.privateKey.toString("utf-8");
        const publicKey = config.publicKey
          ? typeof config.publicKey === "string"
            ? config.publicKey
            : config.publicKey.toString("utf-8")
          : crypto.createPublicKey(privateKey).export({
              type: "spki",
              format: "pem",
            }) as string;

        const kid = config.keyId ?? generateKeyId();
        keys.set(kid, { privateKey, publicKey, kid, alg: algorithm });
        currentKeyId = kid;
      } else {
        await rotateKeys();
      }
      initialized = true;
    })();

    return initPromise;
  };

  const rotateKeys = async (): Promise<void> => {
    const { privateKey, publicKey } = isEC
      ? await generateECKeyPair(algorithm)
      : await generateRSAKeyPair(algorithm);

    const kid = generateKeyId();
    keys.set(kid, { privateKey, publicKey, kid, alg: algorithm });

    const oldKeyId = currentKeyId;
    currentKeyId = kid;

    if (keys.size > 2 && oldKeyId) {
      const keysArray = Array.from(keys.keys());
      const oldestKey = keysArray.find((k) => k !== currentKeyId && k !== oldKeyId);
      if (oldestKey) {
        keys.delete(oldestKey);
      }
    }
  };

  const getCurrentKey = async (): Promise<KeyPair> => {
    await initialize();
    return keys.get(currentKeyId)!;
  };

  const getPublicKeys = async (): Promise<JWK[]> => {
    await initialize();
    return Array.from(keys.values()).map((kp) =>
      isEC
        ? ecPublicKeyToJWK(kp.publicKey, kp.kid, kp.alg)
        : rsaPublicKeyToJWK(kp.publicKey, kp.kid, kp.alg)
    );
  };

  const signToken = async (payload: Record<string, unknown>): Promise<string> => {
    await initialize();
    const key = keys.get(currentKeyId)!;
    return jwt.sign(payload, key.privateKey, {
      algorithm: algorithm as jwt.Algorithm,
      keyid: key.kid,
    });
  };

  const verifyToken = async (token: string): Promise<Record<string, unknown>> => {
    await initialize();

    const decoded = jwt.decode(token, { complete: true }) as {
      header: { kid?: string };
    } | null;
    if (!decoded?.header) {
      throw new Error("Invalid token format");
    }

    const kid = decoded.header.kid;
    let keyPair: KeyPair | undefined;

    if (kid) {
      keyPair = keys.get(kid);
    }
    if (!keyPair) {
      keyPair = keys.get(currentKeyId);
    }
    if (!keyPair) {
      throw new Error("No valid key found for token verification");
    }

    return jwt.verify(token, keyPair.publicKey, {
      algorithms: [algorithm as jwt.Algorithm],
    }) as Record<string, unknown>;
  };

  const getKeyId = (): string => currentKeyId;
  const getAlgorithm = (): Algorithm => algorithm;

  if (config.rotationIntervalMs) {
    setInterval(() => rotateKeys(), config.rotationIntervalMs);
  }

  return {
    getCurrentKey,
    getPublicKeys,
    signToken,
    verifyToken,
    rotateKeys,
    getKeyId,
    getAlgorithm,
  };
};
