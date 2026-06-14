export type TemplateName = "node" | "cloudflare";
export type DbName = "sqlite" | "postgres";
export type FrontendName = "react" | "none";

export interface ScaffoldOptions {
  name: string;
  template: TemplateName;
  db: DbName;
  // Optional; absent is equivalent to "none" (backend only).
  frontend?: FrontendName;
}

export const TEMPLATES: readonly TemplateName[] = ["node", "cloudflare"];
export const DATABASES: readonly DbName[] = ["sqlite", "postgres"];
export const FRONTENDS: readonly FrontendName[] = ["react", "none"];

const APP_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const validateAppName = (name: string): string | undefined => {
  if (name.length === 0) return "app name is required";
  if (name.length > 100) return "app name must be 100 characters or fewer";
  if (!APP_NAME_PATTERN.test(name)) {
    return "app name must be kebab-case (lowercase letters, digits and hyphens, starting with a letter)";
  }
  return undefined;
};
