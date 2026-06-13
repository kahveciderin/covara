export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  passthrough: string[];
}

export interface ParseOptions {
  booleans?: string[];
  aliases?: Record<string, string>;
}

const splitInline = (arg: string): [string, string | undefined] => {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
};

export const parseArgs = (argv: string[], opts: ParseOptions = {}): ParsedArgs => {
  const booleans = new Set(opts.booleans ?? []);
  const aliases = opts.aliases ?? {};
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const passthrough: string[] = [];

  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift()!;

    if (arg === "--") {
      passthrough.push(...rest);
      break;
    }

    if (arg.startsWith("--")) {
      const [rawName, inline] = splitInline(arg.slice(2));
      if (rawName.startsWith("no-") && inline === undefined && !booleans.has(rawName)) {
        flags[rawName.slice(3)] = false;
        continue;
      }
      const name = aliases[rawName] ?? rawName;
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (booleans.has(rawName) || booleans.has(name)) {
        flags[name] = true;
      } else {
        const next = rest[0];
        if (next === undefined || next.startsWith("-")) {
          flags[name] = true;
        } else {
          flags[name] = rest.shift()!;
        }
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const [rawName, inline] = splitInline(arg.slice(1));
      const name = aliases[rawName] ?? rawName;
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (booleans.has(rawName) || booleans.has(name)) {
        flags[name] = true;
      } else {
        const next = rest[0];
        if (next === undefined || next.startsWith("-")) {
          flags[name] = true;
        } else {
          flags[name] = rest.shift()!;
        }
      }
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags, passthrough };
};

export const getString = (
  parsed: ParsedArgs,
  name: string
): string | undefined => {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
};

export const getBool = (parsed: ParsedArgs, name: string): boolean => {
  return parsed.flags[name] === true;
};

export const hasFlag = (parsed: ParsedArgs, name: string): boolean => {
  return name in parsed.flags;
};
