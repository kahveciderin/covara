import { resolveProfile, resolveSchemaPath } from "../config.js";
import { queryData } from "../drizzle-bridge.js";
import { parseArgs, getString } from "../args.js";

export const dataCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args);
  const table = parsed.positionals[0];
  if (!table) {
    console.error("error: usage: covara data <table> [--limit n] [--profile name]");
    return 1;
  }
  const cwd = process.cwd();
  try {
    const profile = resolveProfile(cwd, {
      profile: getString(parsed, "profile"),
      url: getString(parsed, "url"),
    });
    const schemaPath = resolveSchemaPath(cwd);
    const limit = getString(parsed, "limit");
    const { rows } = await queryData(cwd, profile, schemaPath, table, {
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    console.log(JSON.stringify(rows, null, 2));
    console.log(`\n(${rows.length} row(s))`);
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};
