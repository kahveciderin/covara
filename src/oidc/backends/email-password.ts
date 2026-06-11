import type { Context } from "hono";
import {
  AuthBackend,
  AuthBackendResult,
  EmailPasswordBackendConfig,
} from "../types";
import { readFormBody } from "../body";

export const createEmailPasswordBackend = (
  config: EmailPasswordBackendConfig
): AuthBackend => ({
  name: "email-password",

  async authenticate(c: Context): Promise<AuthBackendResult> {
    const body = await readFormBody(c);
    const { email, password } = body;

    if (!email || !password) {
      return { success: false, error: "Email and password are required" };
    }

    const user = await config.validateUser(email, password);
    if (!user) {
      return { success: false, error: "Invalid email or password" };
    }

    return {
      success: true,
      user,
      authTime: Math.floor(Date.now() / 1000),
      amr: ["pwd"],
    };
  },

  getLoginForm() {
    return {
      fields: [
        { name: "email", type: "email", label: "Email", required: true },
        { name: "password", type: "password", label: "Password", required: true },
      ],
    };
  },

  supportsSignup: !!config.createUser,

  async createUser(data: { email: string; password: string; name?: string }) {
    if (!config.createUser) {
      throw new Error("User creation not supported");
    }
    return config.createUser(data);
  },
});
