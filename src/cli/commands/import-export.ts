import fs from "node:fs";
import path from "node:path";
import { resolveProfile, resolveSchemaPath } from "../config.js";
import { queryData, importRows } from "../drizzle-bridge.js";
import { parseArgs, getString } from "../args.js";

type Row = Record<string, unknown>;

const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
};

const toCsv = (rows: Row[]): string => {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(",")),
  ].join("\n");
};

const parseCsv = (text: string): Row[] => {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const cols = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const row: Row = {};
    cols.forEach((c, i) => {
      row[c] = vals[i];
    });
    return row;
  });
};

const detectFormat = (file: string, explicit?: string): "json" | "jsonl" | "csv" => {
  if (explicit === "json" || explicit === "jsonl" || explicit === "csv") return explicit;
  if (file.endsWith(".csv")) return "csv";
  if (file.endsWith(".jsonl")) return "jsonl";
  return "json";
};

export const exportCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args);
  const table = parsed.positionals[0];
  if (!table) {
    console.error("error: usage: covara export <table> [--out file] [--format json|jsonl|csv] [--limit n]");
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
      limit: limit ? parseInt(limit, 10) : 1000,
    });
    const out = getString(parsed, "out");
    const format = detectFormat(out ?? "", getString(parsed, "format"));
    let content: string;
    if (format === "jsonl") content = (rows as Row[]).map((r) => JSON.stringify(r)).join("\n");
    else if (format === "csv") content = toCsv(rows as Row[]);
    else content = JSON.stringify(rows, null, 2);

    if (out) {
      fs.writeFileSync(path.resolve(cwd, out), content);
      console.log(`Exported ${rows.length} row(s) to ${out}`);
    } else {
      process.stdout.write(content + "\n");
    }
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};

export const importCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args);
  const table = parsed.positionals[0];
  const fileArg = getString(parsed, "file") ?? parsed.positionals[1];
  if (!table || !fileArg) {
    console.error("error: usage: covara import <table> --file <path> [--format json|jsonl|csv]");
    return 1;
  }
  const cwd = process.cwd();
  try {
    const profile = resolveProfile(cwd, {
      profile: getString(parsed, "profile"),
      url: getString(parsed, "url"),
    });
    const schemaPath = resolveSchemaPath(cwd);
    const text = fs.readFileSync(path.resolve(cwd, fileArg), "utf8");
    const format = detectFormat(fileArg, getString(parsed, "format"));
    let rows: Row[];
    if (format === "jsonl") {
      rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
    } else if (format === "csv") {
      rows = parseCsv(text);
    } else {
      const parsedJson = JSON.parse(text);
      rows = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
    }
    const { inserted } = await importRows(cwd, profile, schemaPath, table, rows);
    console.log(`Imported ${inserted} row(s) into ${table}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
};
