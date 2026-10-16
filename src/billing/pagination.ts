import type { BillingSubscription, SubscriptionPage } from "./types";

const MAX_PAGES = 1000;

export const clampPageSize = (limit: number | undefined, max: number): number =>
  Math.max(1, Math.min(max, Math.floor(limit ?? max)));

export const collectAllPages = async (
  fetchPage: (cursor?: string) => Promise<SubscriptionPage>
): Promise<BillingSubscription[]> => {
  const out: BillingSubscription[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPage(cursor);
    out.push(...page.subscriptions);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return out;
};
