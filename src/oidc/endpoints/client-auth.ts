import { type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { OIDCClient, OIDCProviderStores } from "../types";
import { verifyPassword } from "@/auth/password";

export interface ClientAuth {
  success: boolean;
  client?: OIDCClient;
  error?: string;
}

const constantTimeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

const verifyClientSecret = async (
  stored: string,
  provided: string
): Promise<boolean> => {
  if (stored.startsWith("scrypt$")) {
    return verifyPassword(provided, stored);
  }
  return constantTimeEqual(stored, provided);
};

export const authenticateClient = async (
  c: Context,
  body: Record<string, string>,
  clientStore: OIDCProviderStores["clients"]
): Promise<ClientAuth> => {
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const [id, secret] = decoded.split(":");
    clientId = decodeURIComponent(id);
    clientSecret = decodeURIComponent(secret ?? "");
  } else {
    clientId = body.client_id;
    clientSecret = body.client_secret;
  }

  if (!clientId) {
    return { success: false, error: "client_id is required" };
  }

  const client = await clientStore.get(clientId);
  if (!client) {
    return { success: false, error: "Unknown client" };
  }

  if (client.tokenEndpointAuthMethod === "none") {
    return { success: true, client };
  }

  if (client.secret) {
    if (!clientSecret) {
      return { success: false, error: "Invalid client credentials" };
    }
    const valid = await verifyClientSecret(client.secret, clientSecret);
    if (!valid) {
      return { success: false, error: "Invalid client credentials" };
    }
  }

  return { success: true, client };
};
