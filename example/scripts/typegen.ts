import { generateTypes } from "covara/client";
import { writeFileSync } from "fs";
import { join } from "path";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:3000";
const OUTPUT_PATH = join(import.meta.dirname, "../frontend/src/generated/api-types.ts");

async function main() {
  console.log(`Fetching schema from ${SERVER_URL}...`);

  try {
    const result = await generateTypes({
      serverUrl: SERVER_URL,
      output: "typescript",
      includeClient: true,
    });

    writeFileSync(OUTPUT_PATH, result.code);
    console.log(`Generated types written to ${OUTPUT_PATH}`);
    console.log(`Generated at: ${result.generatedAt}`);
    console.log(`Resources: ${result.schema.resources.map(r => r.name).join(", ")}`);
  } catch (error) {
    console.error("Failed to generate types:", error);
    process.exit(1);
  }
}

main();
