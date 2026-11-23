import { getLogger } from "@/server/logger";

// The database write has already committed: a changelog or subscription failure
// (an unreachable KV) is logged, never reported to the caller as a failed write.
export async function publishCommitted(resource: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    getLogger().error("A committed write could not be recorded or pushed to subscribers", {
      resource,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
