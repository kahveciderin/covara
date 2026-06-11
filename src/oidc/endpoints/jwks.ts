import { Hono } from "hono";
import { KeyManager } from "../types";

export const createJWKSEndpoint = (keyManager: KeyManager): Hono => {
  const router = new Hono();

  router.get("/", async (c) => {
    const keys = await keyManager.getPublicKeys();

    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ keys });
  });

  return router;
};
