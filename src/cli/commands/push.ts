import { resolveProfile, resolveSchemaPath } from "../config.js";
import { pushSchema } from "../drizzle-bridge.js";
import { parseArgs, getString, getBool } from "../args.js";
import { confirm } from "../prompt.js";

export const pushCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args, { booleans: ["force", "yes"] });
  const cwd = process.cwd();

  let profile, schemaPath: string;
  try {
    profile = resolveProfile(cwd, {
      profile: getString(parsed, "profile"),
      url: getString(parsed, "url"),
    });
    schemaPath = resolveSchemaPath(cwd);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  console.log(`Pushing schema to "${profile.name}" [${profile.dialect}] ${profile.url}`);

  const result = await pushSchema(cwd, profile, schemaPath, {
    force: getBool(parsed, "force"),
  });

  if (result.applied) {
    console.log(
      result.statementsToExecute.length === 0
        ? "Already up to date."
        : `Applied ${result.statementsToExecute.length} statement(s).`
    );
    return 0;
  }

  console.log("\n⚠ This change is destructive and may cause data loss:\n");
  for (const stmt of result.statementsToExecute) console.log(`  ${stmt}`);
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  console.log("");

  const approved = getBool(parsed, "yes") || (await confirm("Apply anyway?"));
  if (!approved) {
    console.log("Aborted. (re-run with --force to apply non-interactively)");
    return 1;
  }

  const forced = await pushSchema(cwd, profile, schemaPath, { force: true });
  console.log(`Applied ${forced.statementsToExecute.length} statement(s).`);
  return 0;
};
