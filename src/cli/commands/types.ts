import fs from "node:fs";
import path from "node:path";
import { parseArgs, getString } from "../args.js";
import { generateTypes } from "../../client/typegen.js";

export const typesCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args);
  const serverUrl =
    getString(parsed, "server-url") ??
    getString(parsed, "url") ??
    `http://localhost:${process.env.PORT ?? 3000}`;
  const out = getString(parsed, "out");
  const format = (getString(parsed, "format") ?? "typescript") as
    | "typescript"
    | "dart"
    | "json";

  try {
    const result = await generateTypes({ serverUrl, output: format, includeClient: true });
    if (out) {
      fs.writeFileSync(path.resolve(process.cwd(), out), result.code);
      console.log(`Wrote types to ${out}`);
    } else {
      process.stdout.write(result.code);
    }
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};
