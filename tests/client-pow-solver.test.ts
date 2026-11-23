import { describe, it, expect, vi, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { FetchTransport } from "@/client/transport";
import { solvePowChallenge } from "@/client/pow";
import { meetsDifficulty, solveChallenge } from "@/pow/core";
import { computeFingerprint, issueChallenge, verifySolution } from "@/pow/server";

const SECRET = "solver-secret";

const challengingFetch = (difficulty: number) =>
  vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const fingerprint = computeFingerprint((init.method ?? "GET").toUpperCase(), u.pathname + u.search, "");
    const token = headers["Covara-PoW-Challenge"];
    const nonce = headers["Covara-PoW-Nonce"];
    if (token && nonce && verifySolution({ secret: SECRET, token, nonce, fingerprint }).ok) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const issued = issueChallenge({ secret: SECRET, difficulty, fingerprint });
    return new Response(JSON.stringify({ status: 428 }), {
      status: 428,
      headers: {
        "content-type": "application/problem+json",
        "Covara-PoW-Challenge": issued.token,
        "Covara-PoW-Difficulty": String(issued.difficulty),
        "Covara-PoW-Algorithm": issued.algorithm,
      },
    });
  });

// A Worker double that runs the real inline worker source with WebCrypto.
const installWorker = (behaviour: "run" | "throw" | "error" = "run") => {
  const sources = new Map<string, Blob>();
  let created = 0;
  let terminated = 0;
  const posted: unknown[] = [];
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      const url = `blob:test/${sources.size}`;
      sources.set(url, blob);
      return url;
    },
    revokeObjectURL: (url: string) => void sources.delete(url),
  }));
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private self: { onmessage?: (e: { data: unknown }) => void; postMessage: (d: unknown) => void };
    constructor(url: string) {
      if (behaviour === "throw") throw new Error("Refused to create a worker (CSP)");
      created++;
      this.self = {
        postMessage: (data) => {
          posted.push(data);
          queueMicrotask(() => this.onmessage?.({ data }));
        },
      };
      const blob = sources.get(url)!;
      this.ready = blob.text().then((source) => {
        if (behaviour === "error") {
          queueMicrotask(() => this.onerror?.(new Error("worker failed")));
          return;
        }
        new Function("self", "crypto", "TextEncoder", source)(this.self, webcrypto, TextEncoder);
      });
    }
    ready: Promise<void>;
    postMessage(data: unknown) {
      void this.ready.then(() => this.self.onmessage?.({ data }));
    }
    terminate() {
      terminated++;
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  return { created: () => created, terminated: () => terminated, posted };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client proof-of-work solving", () => {
  it("a pow.solver option replaces the built-in solver", async () => {
    vi.stubGlobal("fetch", challengingFetch(6));
    const solver = vi.fn(async ({ token, difficulty }: { token: string; difficulty: number; algorithm: string }) =>
      solvePowChallenge(token, difficulty)
    );
    const transport = new FetchTransport({ baseUrl: "http://localhost", pow: { solver } });
    await expect(transport.request({ method: "GET", path: "/x" })).resolves.toBeDefined();
    expect(solver).toHaveBeenCalledWith(expect.objectContaining({ difficulty: 6, algorithm: "sha256" }));
  });

  it("solves in a Web Worker when one is available, and cleans it up", async () => {
    const worker = installWorker();
    const token = issueChallenge({ secret: SECRET, difficulty: 10, fingerprint: "f" }).token;
    const nonce = await solvePowChallenge(token, 10);
    expect(meetsDifficulty(token, nonce, 10)).toBe(true);
    expect(worker.posted).toEqual([{ nonce }]);
    expect(worker.created()).toBe(1);
    expect(worker.terminated()).toBe(1);
  });

  it("the transport uses the worker", async () => {
    const worker = installWorker();
    vi.stubGlobal("fetch", challengingFetch(8));
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    await expect(transport.request({ method: "GET", path: "/x" })).resolves.toBeDefined();
    expect(worker.created()).toBe(1);
  });

  it.each(["throw", "error"] as const)("falls back to the main thread when the worker can't run (%s)", async (mode) => {
    installWorker(mode);
    const token = issueChallenge({ secret: SECRET, difficulty: 8, fingerprint: "f" }).token;
    const nonce = await solvePowChallenge(token, 8);
    expect(meetsDifficulty(token, nonce, 8)).toBe(true);
  });

  it("pow.worker: false never creates a worker", async () => {
    const worker = installWorker();
    vi.stubGlobal("fetch", challengingFetch(6));
    const transport = new FetchTransport({ baseUrl: "http://localhost", pow: { worker: false } });
    await expect(transport.request({ method: "GET", path: "/x" })).resolves.toBeDefined();
    expect(worker.created()).toBe(0);
  });

  it("without a worker the solve yields to the event loop", async () => {
    let token = "";
    for (let i = 0; !token; i++) {
      const candidate = issueChallenge({ secret: SECRET, difficulty: 12, fingerprint: `f${i}` }).token;
      if (Number(solveChallenge(candidate, 12)) > 5000) token = candidate;
    }
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);
    const nonce = await solvePowChallenge(token, 12);
    clearTimeout(timer);
    expect(ticked).toBe(true);
    expect(meetsDifficulty(token, nonce, 12)).toBe(true);
  });
});
