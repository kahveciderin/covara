import { parseArgs, getString } from "../args.js";

export const runCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args);
  const target = parsed.positionals[0];
  if (!target) {
    console.error("error: usage: covara run <resource>.<rpc> [jsonArgs] [--server-url url]");
    return 1;
  }

  const serverUrl = (
    getString(parsed, "server-url") ??
    getString(parsed, "url") ??
    `http://localhost:${process.env.PORT ?? 3000}`
  ).replace(/\/$/, "");
  const basePath = getString(parsed, "base") ?? "/api";

  let routePath: string;
  if (target.includes(".")) {
    const [resource, rpc] = target.split(".");
    routePath = `${basePath}/${resource}/rpc/${rpc}`;
  } else {
    routePath = target.startsWith("/") ? target : `/${target}`;
  }

  const bodyArg = parsed.positionals[1];
  let body: unknown;
  if (bodyArg) {
    try {
      body = JSON.parse(bodyArg);
    } catch {
      console.error("error: arguments must be valid JSON");
      return 1;
    }
  }

  try {
    const res = await fetch(serverUrl + routePath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsedOut: unknown = text;
    try {
      parsedOut = JSON.parse(text);
    } catch {
      /* keep text */
    }
    console.log(JSON.stringify(parsedOut, null, 2));
    return res.ok ? 0 : 1;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};
