import type { ScaffoldOptions } from "../options.js";
import { renderPackageJson } from "./package-json.js";
import {
  NODE_TSCONFIG,
  CLOUDFLARE_TSCONFIG,
  renderDrizzleConfig,
  renderWranglerToml,
  renderGitignore,
  renderEnvExample,
} from "./configs.js";
import { renderSchema, renderNodeIndex, renderWorker } from "./source.js";
import { renderReadme } from "./readme.js";
import { renderAgents } from "./agents.js";
import {
  renderDockerfile,
  renderDockerignore,
  renderDockerCompose,
  renderCiWorkflow,
} from "./deploy.js";
import { buildFrontendFiles } from "./frontend.js";

export const buildProjectFiles = (
  options: ScaffoldOptions
): Record<string, string> => {
  const files: Record<string, string> = {
    "package.json": renderPackageJson(options),
    "drizzle.config.ts": renderDrizzleConfig(options),
    "src/schema.ts": renderSchema(options),
    "README.md": renderReadme(options),
    "AGENTS.md": renderAgents(options),
    ".gitignore": renderGitignore(options),
    ".env.example": renderEnvExample(options),
    ".github/workflows/ci.yml": renderCiWorkflow(),
  };

  if (options.template === "node") {
    files["tsconfig.json"] = NODE_TSCONFIG;
    files["src/index.ts"] = renderNodeIndex(options);
    files["Dockerfile"] = renderDockerfile();
    files[".dockerignore"] = renderDockerignore();
    files["docker-compose.yml"] = renderDockerCompose(options);
  } else {
    files["tsconfig.json"] = CLOUDFLARE_TSCONFIG;
    files["src/worker.ts"] = renderWorker(options);
    files["wrangler.toml"] = renderWranglerToml(options);
  }

  if (options.frontend === "react") {
    Object.assign(files, buildFrontendFiles(options));
  }

  return files;
};

export {
  NODE_TSCONFIG,
  CLOUDFLARE_TSCONFIG,
  renderDrizzleConfig,
  renderWranglerToml,
  renderGitignore,
  renderEnvExample,
} from "./configs.js";
export { renderPackageJson } from "./package-json.js";
export { renderSchema, renderNodeIndex, renderWorker } from "./source.js";
export { renderReadme } from "./readme.js";
export { renderAgents } from "./agents.js";
export {
  renderDockerfile,
  renderDockerignore,
  renderDockerCompose,
  renderCiWorkflow,
} from "./deploy.js";
export { buildFrontendFiles } from "./frontend.js";
