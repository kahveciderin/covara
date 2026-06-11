// Regenerates src/ui/html/client/htmx-vendor.ts from the installed htmx.org
// package so the admin UI can serve htmx locally (no external CDN request).
// Run after bumping the htmx.org dependency:  node scripts/vendor-htmx.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(repo, "node_modules/htmx.org/dist/htmx.min.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(repo, "node_modules/htmx.org/package.json"), "utf8"));

const out =
  `// Vendored htmx ${pkg.version} (https://htmx.org), MIT-licensed, served locally so the\n` +
  `// admin UI makes zero external requests. Regenerate with: node scripts/vendor-htmx.mjs\n` +
  `export const htmxVersion = ${JSON.stringify(pkg.version)};\n` +
  `export const htmxScript = ${JSON.stringify(src)};\n`;

writeFileSync(join(repo, "src/ui/html/client/htmx-vendor.ts"), out);
console.log(`Vendored htmx ${pkg.version} (${src.length} bytes)`);
