/**
 * Client-side proof-of-work solver. Wraps the isomorphic core solver so the
 * transport can transparently answer a 428 challenge. The loop is synchronous
 * but yields to the caller via a Promise; for very high difficulties consider
 * offloading to a Web Worker.
 */

import { solveChallenge, type PowAlgorithm } from "@/pow/core";

export interface PowClientConfig {
  /** Defaults to true. Set false to disable transparent challenge solving. */
  enabled?: boolean;
  /** Max number of challenge/solve round-trips per request (default 3). */
  maxAttempts?: number;
}

export const solvePowChallenge = async (
  token: string,
  difficulty: number,
  algorithm: PowAlgorithm = "sha256"
): Promise<string> => solveChallenge(token, difficulty, { algorithm });
