import { getLogger } from "@/server/logger";

let failedWrites = 0;

export async function publishCommitted(resource: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (failedWrites++ === 0) {
      getLogger().error("A committed write could not be recorded or pushed to subscribers", {
        resource,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (failedWrites > 0) {
    getLogger().info("Committed writes are being recorded and pushed again", { failedWrites });
    failedWrites = 0;
  }
}
