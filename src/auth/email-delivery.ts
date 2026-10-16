import type { Context } from "hono";
import { getGlobalEmail } from "@/email";
import type { EmailAdapter, EmailMessage } from "@/email/types";
import { hashToken } from "./verification";

export type AuthEmailFlow = "verification" | "passwordReset" | "magicLink";

export interface AuthEmailParams {
  identifier: string;
  token: string;
  expiresAt: Date;
  c: Context;
}

export type AuthEmailSender = (params: AuthEmailParams) => void | Promise<void>;

export type AuthEmailComposer = (params: AuthEmailParams) => EmailMessage | Promise<EmailMessage>;

export interface AuthEmailOptions {
  adapter?: EmailAdapter;
  onDeliveryError?: (
    error: Error,
    info: { flow: AuthEmailFlow; identifier: string }
  ) => void | Promise<void>;
}

export interface AuthEmailFlowConfig {
  send?: AuthEmailSender;
  composeEmail?: AuthEmailComposer;
}

export interface AuthEmailDispatcher {
  deliver(flow: AuthEmailFlow, config: AuthEmailFlowConfig, params: AuthEmailParams): Promise<void>;
  deliverQuietly(
    flow: AuthEmailFlow,
    config: AuthEmailFlowConfig,
    params: AuthEmailParams
  ): Promise<void>;
}

export const assertAuthEmailFlow = (
  flow: AuthEmailFlow,
  callbackName: string,
  config: AuthEmailFlowConfig
): void => {
  if (!config.send && !config.composeEmail) {
    throw new Error(`useAuth: ${flow} requires either ${callbackName} or composeEmail`);
  }
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const createAuthEmailDispatcher = (options: AuthEmailOptions = {}): AuthEmailDispatcher => {
  const deliver = async (
    flow: AuthEmailFlow,
    config: AuthEmailFlowConfig,
    params: AuthEmailParams
  ): Promise<void> => {
    if (config.send) {
      await config.send(params);
      return;
    }
    const message = await config.composeEmail!(params);
    const adapter = options.adapter ?? getGlobalEmail();
    await adapter.send(message, { idempotencyKey: `auth:${flow}:${hashToken(params.token)}` });
  };

  return {
    deliver,
    async deliverQuietly(flow, config, params) {
      try {
        await deliver(flow, config, params);
      } catch (thrown) {
        const error = toError(thrown);
        try {
          if (options.onDeliveryError) {
            await options.onDeliveryError(error, { flow, identifier: params.identifier });
          } else {
            console.error(`[covara] auth ${flow} email delivery failed: ${error.message}`);
          }
        } catch {
          return;
        }
      }
    },
  };
};
