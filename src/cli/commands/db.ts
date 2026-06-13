import {
  loadConfig,
  saveConfig,
  resolveProfile,
  dialectFromUrl,
  type Dialect,
} from "../config.js";
import { parseArgs, getString } from "../args.js";

const DB_HELP = `covara db - manage database connection profiles

Usage:
  covara db list
  covara db current
  covara db use <name>
  covara db add <name> --url <url> [--token <token>] [--dialect sqlite|postgres]
  covara db remove <name>
`;

export const dbCommand = (args: string[]): number => {
  const [sub, ...rest] = args;
  const cwd = process.cwd();

  if (!sub || sub === "help" || sub === "--help") {
    console.log(DB_HELP);
    return sub ? 0 : 1;
  }

  if (sub === "list") {
    const config = loadConfig(cwd);
    const names = Object.keys(config.profiles);
    if (names.length === 0) {
      console.log("No profiles configured. Add one with `covara db add <name> --url <url>`.");
      return 0;
    }
    for (const name of names) {
      const p = config.profiles[name];
      const marker = name === config.active ? "* " : "  ";
      console.log(`${marker}${name}  [${p.dialect}]  ${p.url}`);
    }
    return 0;
  }

  if (sub === "current") {
    try {
      const p = resolveProfile(cwd);
      console.log(`${p.name}  [${p.dialect}]  ${p.url}`);
      return 0;
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  if (sub === "use") {
    const name = rest.find((a) => !a.startsWith("-"));
    if (!name) {
      console.error("error: missing profile name (usage: covara db use <name>)");
      return 1;
    }
    const config = loadConfig(cwd);
    if (!config.profiles[name]) {
      console.error(`error: unknown profile "${name}"`);
      return 1;
    }
    config.active = name;
    saveConfig(cwd, config);
    console.log(`Active profile is now "${name}".`);
    return 0;
  }

  if (sub === "add") {
    const parsed = parseArgs(rest, { aliases: { t: "token", d: "dialect" } });
    const name = parsed.positionals[0];
    const url = getString(parsed, "url");
    if (!name || !url) {
      console.error("error: usage: covara db add <name> --url <url> [--token <token>] [--dialect sqlite|postgres]");
      return 1;
    }
    const dialect = (getString(parsed, "dialect") as Dialect | undefined) ?? dialectFromUrl(url);
    const token = getString(parsed, "token");
    const config = loadConfig(cwd);
    config.profiles[name] = { dialect, url, ...(token ? { authToken: token } : {}) };
    if (!config.active) config.active = name;
    saveConfig(cwd, config);
    console.log(`Added profile "${name}" [${dialect}].`);
    return 0;
  }

  if (sub === "remove" || sub === "rm") {
    const name = rest.find((a) => !a.startsWith("-"));
    if (!name) {
      console.error("error: missing profile name (usage: covara db remove <name>)");
      return 1;
    }
    const config = loadConfig(cwd);
    if (!config.profiles[name]) {
      console.error(`error: unknown profile "${name}"`);
      return 1;
    }
    delete config.profiles[name];
    if (config.active === name) delete config.active;
    saveConfig(cwd, config);
    console.log(`Removed profile "${name}".`);
    return 0;
  }

  console.error(`error: unknown db subcommand "${sub}"\n`);
  console.log(DB_HELP);
  return 1;
};
