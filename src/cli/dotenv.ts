import fs from "node:fs";
import path from "node:path";

export const parseEnv = (text: string): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    let value = t.slice(i + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    map[t.slice(0, i).trim()] = value;
  }
  return map;
};

export const loadDotEnv = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): void => {
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return;
  const map = parseEnv(fs.readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(map)) {
    if (env[key] === undefined) env[key] = value;
  }
};
