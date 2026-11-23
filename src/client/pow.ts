import { meetsDifficulty, type PowAlgorithm } from "@/pow/core";

export interface PowChallenge {
  token: string;
  difficulty: number;
  algorithm: PowAlgorithm;
}

export type PowSolver = (challenge: PowChallenge) => Promise<string>;

export interface PowClientConfig {
  /** Defaults to true. Set false to disable transparent challenge solving. */
  enabled?: boolean;
  /** Max number of challenge/solve round-trips per request (default 3). */
  maxAttempts?: number;
  /** Replaces the built-in solver; must resolve to a nonce that meets the difficulty. */
  solver?: PowSolver;
  /** Solve in a Web Worker when the runtime has one (default true). */
  worker?: boolean;
}

export interface SolveOptions {
  worker?: boolean;
  maxIterations?: number;
}

const MAX_ITERATIONS = 1e8;
const MAIN_THREAD_SLICE = 2000;

// Self-contained: it runs from a Blob URL and can import nothing. Leading zero
// bits are counted from the first byte's most significant bit, as in core.ts.
const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { token, difficulty, maxIterations } = event.data;
  const encoder = new TextEncoder();
  const zeroBits = (bytes) => {
    let bits = 0;
    for (const byte of bytes) {
      if (byte === 0) { bits += 8; continue; }
      return bits + Math.clz32(byte) - 24;
    }
    return bits;
  };
  const batch = 512;
  try {
    for (let base = 0; base < maxIterations; base += batch) {
      const digests = await Promise.all(
        Array.from({ length: batch }, (_, i) =>
          crypto.subtle.digest("SHA-256", encoder.encode(token + ":" + (base + i)))
        )
      );
      for (let i = 0; i < batch; i++) {
        if (zeroBits(new Uint8Array(digests[i])) >= difficulty) {
          self.postMessage({ nonce: String(base + i) });
          return;
        }
      }
    }
    self.postMessage({ error: "not solved" });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
`;

const canUseWorker = (): boolean =>
  typeof Worker === "function" &&
  typeof Blob === "function" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function";

const solveInWorker = (token: string, difficulty: number, maxIterations: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      reject(error);
      return;
    }
    const done = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = (event: MessageEvent<{ nonce?: string; error?: string }>) => {
      done();
      if (event.data?.nonce !== undefined) resolve(event.data.nonce);
      else reject(new Error(event.data?.error ?? "Proof-of-work worker failed"));
    };
    worker.onerror = (event) => {
      done();
      reject(event instanceof Error ? event : new Error("Proof-of-work worker failed"));
    };
    worker.postMessage({ token, difficulty, maxIterations });
  });

// Yields to the event loop between slices so the page stays responsive.
const solveOnMainThread = async (
  token: string,
  difficulty: number,
  algorithm: PowAlgorithm,
  maxIterations: number
): Promise<string> => {
  for (let base = 0; base < maxIterations; base += MAIN_THREAD_SLICE) {
    const end = Math.min(base + MAIN_THREAD_SLICE, maxIterations);
    for (let nonce = base; nonce < end; nonce++) {
      const candidate = String(nonce);
      if (meetsDifficulty(token, candidate, difficulty, algorithm)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Proof-of-work not solved within ${maxIterations} iterations (difficulty ${difficulty})`);
};

export const solvePowChallenge = async (
  token: string,
  difficulty: number,
  algorithm: PowAlgorithm = "sha256",
  options: SolveOptions = {}
): Promise<string> => {
  if (difficulty <= 0) return "0";
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  if (options.worker !== false && algorithm === "sha256" && canUseWorker()) {
    try {
      return await solveInWorker(token, difficulty, maxIterations);
    } catch {
      // A CSP without worker-src blob:, or a worker that failed: solve here instead.
    }
  }
  return solveOnMainThread(token, difficulty, algorithm, maxIterations);
};
