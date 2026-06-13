import { resolveProfile, resolveSchemaPath } from "../config.js";
import { startStudio } from "../drizzle-bridge.js";
import { parseArgs, getString } from "../args.js";

export const studioCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args);
  const cwd = process.cwd();

  try {
    const profile = resolveProfile(cwd, {
      profile: getString(parsed, "profile"),
      url: getString(parsed, "url"),
    });
    const schemaPath = resolveSchemaPath(cwd);
    const portStr = getString(parsed, "port");
    console.log(`Starting Drizzle Studio for "${profile.name}"...`);
    return await startStudio(
      cwd,
      profile,
      schemaPath,
      portStr ? parseInt(portStr, 10) : undefined
    );
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};
