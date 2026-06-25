/**
 * Client-side CAPTCHA support (BETA). The library cannot silently solve a human
 * CAPTCHA, so the app supplies a `CaptchaSolver` (or, in React, the
 * `<CovaraCaptcha/>` component registers one that renders the provider widget).
 *
 * `loadCaptchaWidget` is a browser-only helper that injects the provider script
 * once and renders its widget into a container, resolving with the token.
 */

export interface CaptchaChallenge {
  provider: string;
  siteKey?: string;
  action?: string;
}

export type CaptchaSolver = (challenge: CaptchaChallenge) => Promise<string | null>;

export interface PendingCaptcha {
  challenge: CaptchaChallenge;
  resolve: (token: string | null) => void;
}

/**
 * React-agnostic queue bridging the transport's `CaptchaSolver` to a UI. The
 * `solver` parks an incoming challenge and returns a promise; a UI subscribes,
 * renders the widget, and calls `resolveCurrent(token)` to fulfill it. Kept
 * outside React so the logic is testable without a DOM.
 */
export class CaptchaController {
  private pending: PendingCaptcha | null = null;
  private readonly listeners = new Set<() => void>();

  readonly solver: CaptchaSolver = (challenge) =>
    new Promise<string | null>((resolve) => {
      // A challenge arriving while one is pending supersedes it; resolve the
      // stale one as unsolved so its request fails cleanly.
      this.pending?.resolve(null);
      this.pending = { challenge, resolve };
      this.emit();
    });

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getCurrent = (): PendingCaptcha | null => this.pending;

  resolveCurrent(token: string | null): void {
    const pending = this.pending;
    this.pending = null;
    this.emit();
    pending?.resolve(token);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Shared controller used by the React `<CovaraCaptcha/>` component. */
export const captchaController = new CaptchaController();

interface WidgetApi {
  render: (
    container: HTMLElement,
    params: { sitekey: string; callback: (token: string) => void; "error-callback"?: () => void; action?: string }
  ) => unknown;
}

const SCRIPTS: Record<string, { src: string; global: string }> = {
  turnstile: { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", global: "turnstile" },
  hcaptcha: { src: "https://js.hcaptcha.com/1/api.js?render=explicit", global: "hcaptcha" },
  recaptcha: { src: "https://www.google.com/recaptcha/api.js?render=explicit", global: "grecaptcha" },
};

const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(script);
  });

const waitForGlobal = (name: string, timeoutMs = 10_000): Promise<WidgetApi> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const api = (globalThis as Record<string, unknown>)[name] as WidgetApi | undefined;
      if (api && typeof api.render === "function") return resolve(api);
      if (Date.now() - start > timeoutMs) return reject(new Error(`CAPTCHA provider "${name}" did not load`));
      setTimeout(tick, 50);
    };
    tick();
  });

/**
 * Render a provider widget into `container` and resolve with the solved token.
 * Browser-only. Throws for unknown providers (supply your own solver instead).
 */
export const loadCaptchaWidget = async (
  challenge: CaptchaChallenge,
  container: HTMLElement
): Promise<string> => {
  if (typeof document === "undefined") {
    throw new Error("loadCaptchaWidget can only run in a browser");
  }
  const entry = SCRIPTS[challenge.provider];
  if (!entry) {
    throw new Error(`Unknown CAPTCHA provider "${challenge.provider}"; provide a custom captcha solver`);
  }
  if (!challenge.siteKey) {
    throw new Error(`CAPTCHA challenge for "${challenge.provider}" is missing a site key`);
  }
  await loadScript(entry.src);
  const api = await waitForGlobal(entry.global);
  return new Promise<string>((resolve, reject) => {
    api.render(container, {
      sitekey: challenge.siteKey!,
      action: challenge.action,
      callback: (token: string) => resolve(token),
      "error-callback": () => reject(new Error("CAPTCHA widget error")),
    });
  });
};
