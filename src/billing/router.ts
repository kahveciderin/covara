import { Hono, type Context } from "hono";
import { getUser } from "@/server/context";
import { Billing } from "./index";
import { CheckoutMode } from "./types";

export interface BillingRouterOptions {
  // Resolve the credits/metadata account id for the authenticated request.
  // Defaults to the authenticated user's id.
  getAccount?: (c: Context) => string | undefined | Promise<string | undefined>;
  // Resolve the provider customer id for the authenticated user (used by the
  // subscription + portal endpoints). Optional.
  getCustomerId?: (c: Context) => string | undefined | Promise<string | undefined>;
  // Optional override for the customer email used at checkout.
  getCustomerEmail?: (c: Context) => string | undefined | Promise<string | undefined>;
}

interface CheckoutBody {
  plan?: string;
  items?: { priceId: string; quantity?: number }[];
  mode?: CheckoutMode;
  quantity?: number;
  successUrl: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
  trialDays?: number;
}

// Mountable HTTP surface for the typed client: checkout, subscription status,
// billing portal, credit balance, and the provider webhook. Non-webhook routes
// require an authenticated user; the webhook is signature-verified instead.
export const createBillingRouter = (
  billing: Billing,
  options: BillingRouterOptions = {}
): Hono => {
  const router = new Hono();
  const getAccount =
    options.getAccount ?? ((c: Context) => getUser(c)?.id);

  const requireAccount = async (c: Context): Promise<string | null> => {
    const account = await getAccount(c);
    return account ?? null;
  };

  router.post("/checkout", async (c) => {
    const account = await requireAccount(c);
    if (!account) return c.json({ error: "Unauthorized" }, 401);

    const body = (await c.req.json()) as CheckoutBody;
    const email = options.getCustomerEmail ? await options.getCustomerEmail(c) : undefined;
    const customerId = options.getCustomerId ? await options.getCustomerId(c) : undefined;
    const metadata = { ...(body.metadata ?? {}), accountId: account };

    const session = body.plan
      ? await billing.checkoutPlan(body.plan, {
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
          customerId,
          customerEmail: email,
          quantity: body.quantity,
          metadata,
          trialDays: body.trialDays,
          mode: body.mode,
        })
      : await billing.checkout({
          mode: body.mode ?? "subscription",
          items: body.items ?? [],
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
          customerId,
          customerEmail: email,
          metadata,
          trialDays: body.trialDays,
        });

    return c.json({ id: session.id, url: session.url });
  });

  router.get("/subscription", async (c) => {
    const account = await requireAccount(c);
    if (!account) return c.json({ error: "Unauthorized" }, 401);
    const customerId = options.getCustomerId ? await options.getCustomerId(c) : undefined;
    if (!customerId) return c.json({ subscriptions: [] });
    const subscriptions = await billing.adapter.listSubscriptions(customerId);
    return c.json({ subscriptions });
  });

  router.post("/portal", async (c) => {
    const account = await requireAccount(c);
    if (!account) return c.json({ error: "Unauthorized" }, 401);
    const customerId = options.getCustomerId ? await options.getCustomerId(c) : undefined;
    if (!customerId) return c.json({ error: "No customer for user" }, 400);
    const { returnUrl } = (await c.req.json()) as { returnUrl: string };
    const session = await billing.portal(customerId, returnUrl);
    return c.json(session);
  });

  router.get("/credits", async (c) => {
    const account = await requireAccount(c);
    if (!account) return c.json({ error: "Unauthorized" }, 401);
    const balance = await billing.credits.balance(account);
    return c.json({ balance });
  });

  router.post("/webhook", billing.webhookHandler());

  return router;
};
