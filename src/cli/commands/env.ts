import fs from "node:fs";
import path from "node:path";

const envFile = (cwd: string): string => path.join(cwd, ".env");

const readEnvFile = (cwd: string): string => {
  const p = envFile(cwd);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};

const keyOf = (line: string): string | null => {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const i = t.indexOf("=");
  return i === -1 ? null : t.slice(0, i).trim();
};

const parseEnv = (text: string): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return map;
};

export const envCommand = (args: string[]): number => {
  const [sub, ...rest] = args;
  const cwd = process.cwd();

  if (sub === "list" || !sub) {
    const map = parseEnv(readEnvFile(cwd));
    for (const k of Object.keys(map)) console.log(`${k}=${map[k]}`);
    return 0;
  }

  if (sub === "get") {
    const key = rest[0];
    if (!key) {
      console.error("usage: covara env get <key>");
      return 1;
    }
    const map = parseEnv(readEnvFile(cwd));
    if (key in map) {
      console.log(map[key]);
      return 0;
    }
    return 1;
  }

  if (sub === "set") {
    const key = rest[0];
    const value = rest.slice(1).join(" ");
    if (!key) {
      console.error("usage: covara env set <key> <value>");
      return 1;
    }
    const lines = readEnvFile(cwd).split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (keyOf(line) === key) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) {
      if (updated.length && updated[updated.length - 1] === "") {
        updated.splice(updated.length - 1, 0, `${key}=${value}`);
      } else {
        updated.push(`${key}=${value}`);
      }
    }
    fs.writeFileSync(envFile(cwd), updated.join("\n"));
    console.log(`Set ${key}`);
    return 0;
  }

  if (sub === "remove" || sub === "rm") {
    const key = rest[0];
    if (!key) {
      console.error("usage: covara env remove <key>");
      return 1;
    }
    const lines = readEnvFile(cwd)
      .split("\n")
      .filter((line) => keyOf(line) !== key);
    fs.writeFileSync(envFile(cwd), lines.join("\n"));
    console.log(`Removed ${key}`);
    return 0;
  }

  console.error("usage: covara env <list|get|set|remove>");
  return 1;
};
