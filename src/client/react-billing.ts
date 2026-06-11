import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { getClient } from "./globals";
import {
  isActiveSubscription,
  BillingClient,
  BillingSubscription,
  CheckoutInput,
  CheckoutResult,
} from "./billing";

const resolveBilling = (): BillingClient => getClient().billing;

export interface UseCreditsResult {
  balance: number | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useCredits(): UseCreditsResult {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const billing = useMemo(() => resolveBilling(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await billing.getCredits();
      setBalance(value);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [billing]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { balance, loading, error, refresh };
}

export interface UseSubscriptionResult {
  subscriptions: BillingSubscription[];
  activeSubscription: BillingSubscription | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useSubscription(): UseSubscriptionResult {
  const [subscriptions, setSubscriptions] = useState<BillingSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const billing = useMemo(() => resolveBilling(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await billing.getSubscription();
      setSubscriptions(list);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [billing]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeSubscription = useMemo(
    () => subscriptions.find(isActiveSubscription) ?? null,
    [subscriptions]
  );

  return { subscriptions, activeSubscription, loading, error, refresh };
}

export interface UseCheckoutResult {
  checkout: (input: CheckoutInput) => Promise<CheckoutResult>;
  redirectToCheckout: (input: CheckoutInput) => Promise<void>;
  loading: boolean;
  error: Error | null;
}

export function useCheckout(): UseCheckoutResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const billing = useMemo(() => resolveBilling(), []);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const checkout = useCallback(
    async (input: CheckoutInput): Promise<CheckoutResult> => {
      setLoading(true);
      setError(null);
      try {
        return await billing.checkout(input);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current) setError(e);
        throw e;
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [billing]
  );

  const redirectToCheckout = useCallback(
    async (input: CheckoutInput): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        await billing.redirectToCheckout(input);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current) setError(e);
        throw e;
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [billing]
  );

  return { checkout, redirectToCheckout, loading, error };
}
