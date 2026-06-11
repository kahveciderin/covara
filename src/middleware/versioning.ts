import type { MiddlewareHandler } from "hono";

export const CONCAVE_VERSION = "1.0.0";

export interface DeprecationWarning {
  feature?: string;
  message: string;
  replacement?: string;
  sunsetDate?: Date;
  affectedPaths?: string[];
  affectedFields?: string[];
}

export interface VersioningConfig {
  currentVersion?: string;
  headerName?: string;
  deprecationWarnings?: DeprecationWarning[];
  deprecations?: DeprecationWarning[];
  minSupportedVersion?: string;
}

const DEFAULT_CONFIG: Required<Omit<VersioningConfig, "deprecationWarnings" | "deprecations" | "minSupportedVersion">> = {
  currentVersion: CONCAVE_VERSION,
  headerName: "X-Concave-Version",
};

export const versioningMiddleware = (config: VersioningConfig = {}): MiddlewareHandler => {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { currentVersion, headerName } = mergedConfig;
  const deprecationWarnings = config.deprecationWarnings ?? config.deprecations ?? [];

  return async (c, next) => {
    c.set("apiVersion", currentVersion);
    c.header(headerName, currentVersion);

    if (deprecationWarnings.length > 0) {
      const applicableWarnings = deprecationWarnings.filter((warning) => {
        if (warning.affectedPaths) {
          return warning.affectedPaths.some((path) => c.req.path.startsWith(path));
        }
        return true;
      });

      if (applicableWarnings.length > 0) {
        const warningMessages = applicableWarnings.map((warning) => {
          if (warning.feature) {
            let msg = `${warning.feature}: ${warning.message}`;
            if (warning.replacement) {
              msg += ` Use '${warning.replacement}' instead.`;
            }
            if (warning.sunsetDate) {
              msg += ` Sunset: ${warning.sunsetDate.toISOString().split("T")[0]}`;
            }
            return msg;
          }
          return warning.message;
        });

        c.header("X-Concave-Warn", warningMessages.join("; "));

        const sunsetDate = applicableWarnings
          .map((w) => w.sunsetDate)
          .filter(Boolean)
          .sort((a, b) => (a!.getTime() - b!.getTime()))[0];

        if (sunsetDate) {
          c.header("Deprecation", sunsetDate.toISOString().split("T")[0]);
          c.header("Sunset", sunsetDate.toUTCString());
        } else {
          c.header("Deprecation", "true");
        }
      }
    }

    return next();
  };
};

export interface FieldDeprecation {
  field: string;
  replacement?: string;
  message: string;
  sunsetDate?: Date;
}

export const addFieldDeprecationWarnings = <T extends Record<string, unknown>>(
  items: T[],
  deprecations: FieldDeprecation[]
): (T & { _warnings?: Array<{ type: string; field: string; replacement?: string }> })[] => {
  if (deprecations.length === 0) {
    return items;
  }

  return items.map((item) => {
    const warnings: Array<{ type: string; field: string; replacement?: string }> = [];

    for (const deprecation of deprecations) {
      if (deprecation.field in item) {
        warnings.push({
          type: "deprecation",
          field: deprecation.field,
          replacement: deprecation.replacement,
        });
      }
    }

    if (warnings.length > 0) {
      return { ...item, _warnings: warnings };
    }

    return item;
  });
};

export interface VersionWarning {
  type: string;
  feature?: string;
  field?: string;
  message?: string;
  replacement?: string;
  sunsetDate?: string;
}

export interface VersionedResponse<T> {
  data: T;
  version: string;
  timestamp: string;
  warnings?: VersionWarning[];
}

export const wrapWithVersion = <T>(
  data: T,
  warnings?: VersionWarning[] | DeprecationWarning[]
): VersionedResponse<T> => {
  const response: VersionedResponse<T> = {
    data,
    version: CONCAVE_VERSION,
    timestamp: new Date().toISOString(),
  };

  if (warnings && warnings.length > 0) {
    response.warnings = warnings.map((w) => {
      if ("feature" in w && "sunsetDate" in w) {
        const dep = w as DeprecationWarning;
        return {
          type: "deprecation",
          feature: dep.feature,
          message: dep.message,
          replacement: dep.replacement,
          sunsetDate: dep.sunsetDate?.toISOString().split("T")[0],
        };
      }
      return w as VersionWarning;
    });
  }

  return response;
};

const parseVersion = (version: string): { major: number; minor: number; patch: number; prerelease?: string } | null => {
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2] ?? "0", 10),
    patch: parseInt(match[3] ?? "0", 10),
    prerelease: match[4],
  };
};

const compareVersions = (v1: string, v2: string): number => {
  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);

  if (!parsed1 || !parsed2) return 0;

  if (parsed1.major !== parsed2.major) return parsed1.major - parsed2.major;
  if (parsed1.minor !== parsed2.minor) return parsed1.minor - parsed2.minor;
  if (parsed1.patch !== parsed2.patch) return parsed1.patch - parsed2.patch;

  if (parsed1.prerelease && !parsed2.prerelease) return -1;
  if (!parsed1.prerelease && parsed2.prerelease) return 1;

  return 0;
};

export const checkMinimumVersion = (
  clientVersion: string | undefined,
  minVersion: string
): { supported: boolean; message?: string } => {
  if (!clientVersion) {
    return { supported: true };
  }

  const parsed = parseVersion(clientVersion);
  if (!parsed) {
    return {
      supported: false,
      message: `Invalid version format: ${clientVersion}`,
    };
  }

  const comparison = compareVersions(clientVersion, minVersion);
  if (comparison < 0) {
    return {
      supported: false,
      message: `Client version ${clientVersion} is below minimum supported version ${minVersion}. Please upgrade.`,
    };
  }

  return { supported: true };
};

export const createVersionChecker = (minVersion: string): MiddlewareHandler => {
  return async (c, next) => {
    const clientVersion = c.req.header("x-concave-client-version");
    const result = checkMinimumVersion(clientVersion, minVersion);

    if (!result.supported) {
      return c.json(
        {
          type: "/__concave/problems/unsupported-version",
          title: "Unsupported client version",
          status: 400,
          detail: result.message,
          minVersion,
          clientVersion,
        },
        400
      );
    }

    return next();
  };
};

export const CURSOR_VERSION_HEADER = "X-Concave-Cursor-Version";
export const SCHEMA_VERSION_HEADER = "X-Concave-Schema-Version";

export const schemaVersionMiddleware = (schemaVersion: string | number): MiddlewareHandler => {
  const versionStr = String(schemaVersion);
  return async (c, next) => {
    c.header(SCHEMA_VERSION_HEADER, versionStr);
    return next();
  };
};

export interface SchemaVersionEvent {
  type: "schemaVersion";
  version: number;
  resource: string;
  changes: string[];
}

export const formatSchemaVersionEvent = (
  version: number,
  resource: string,
  changes: string[]
): string => {
  const event: SchemaVersionEvent = {
    type: "schemaVersion",
    version,
    resource,
    changes,
  };

  return `event: schemaVersion\ndata: ${JSON.stringify(event)}\n\n`;
};
