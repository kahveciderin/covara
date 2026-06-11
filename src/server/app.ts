import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { Table, TableConfig, getTableName } from "drizzle-orm";
import { errorHandler, notFoundHandler } from "@/middleware/error";
import { observabilityMiddleware, type ObservabilityConfig } from "@/middleware/observability";
import { useResource } from "@/resource/hook";
import type { ResourceConfig } from "@/resource/types";
import { createHealthEndpoints, type HealthConfig } from "@/health";
import { createAdminUI, type AdminUIConfig } from "@/ui";
import { createConcaveRouter, type ConcaveRouterConfig } from "@/openapi/schema";
import { createSecurityHeaders, type SecurityHeadersOptions } from "@/middleware/securityHeaders";
import { onShutdown } from "@/server/lifecycle";
import { closeAllHandlers } from "@/resource/subscription";

let sseDrainHookRegistered = false;

export interface ConcaveAuthSetup {
  router: Hono;
  middleware: MiddlewareHandler;
  path?: string;
}

export interface ConcaveOptions {
  basePath?: string;
  cors?: boolean | Parameters<typeof cors>[0];
  auth?: ConcaveAuthSetup;
  middleware?: MiddlewareHandler[];
  observability?: boolean | ObservabilityConfig;
  health?: boolean | HealthConfig;
  adminUI?: boolean | AdminUIConfig;
  openapi?: boolean | ConcaveRouterConfig;
  securityHeaders?: boolean | SecurityHeadersOptions;
}

export class ConcaveApp extends Hono {
  private readonly resourceBasePath: string;

  constructor(options: ConcaveOptions = {}) {
    super();
    this.resourceBasePath = normalizeBasePath(options.basePath ?? "/api");

    this.onError(errorHandler);
    this.notFound(notFoundHandler);

    if (!sseDrainHookRegistered) {
      sseDrainHookRegistered = true;
      onShutdown(() => {
        closeAllHandlers();
      });
    }

    if (options.cors) {
      this.use("*", cors(options.cors === true ? undefined : options.cors));
    }

    if (options.securityHeaders !== false) {
      this.use(
        "*",
        createSecurityHeaders(
          options.securityHeaders === true || options.securityHeaders === undefined
            ? undefined
            : options.securityHeaders
        )
      );
    }

    if (options.observability) {
      this.use(
        "*",
        observabilityMiddleware(
          options.observability === true ? {} : options.observability
        )
      );
    }

    for (const mw of options.middleware ?? []) {
      this.use("*", mw);
    }

    if (options.auth) {
      const authPath = options.auth.path ?? `${this.resourceBasePath}/auth`;
      this.route(authPath, options.auth.router);
      this.use("*", options.auth.middleware);
    }

    if (options.health !== false) {
      this.route(
        "/",
        createHealthEndpoints(
          options.health === true || options.health === undefined ? {} : options.health
        )
      );
    }

    if (options.adminUI) {
      this.route(
        "/__concave",
        createAdminUI(options.adminUI === true ? {} : options.adminUI)
      );
    }

    if (options.openapi !== false) {
      this.route(
        "/__concave",
        createConcaveRouter(
          options.openapi === true || options.openapi === undefined
            ? {}
            : options.openapi
        )
      );
    }
  }

  resource<TConfig extends TableConfig>(
    schema: Table<TConfig>,
    config: ResourceConfig<TConfig, Table<TConfig>>
  ): this;
  resource<TConfig extends TableConfig>(
    path: string,
    schema: Table<TConfig>,
    config: ResourceConfig<TConfig, Table<TConfig>>
  ): this;
  resource<TConfig extends TableConfig>(
    pathOrSchema: string | Table<TConfig>,
    schemaOrConfig: Table<TConfig> | ResourceConfig<TConfig, Table<TConfig>>,
    maybeConfig?: ResourceConfig<TConfig, Table<TConfig>>
  ): this {
    let path: string;
    let schema: Table<TConfig>;
    let config: ResourceConfig<TConfig, Table<TConfig>>;

    if (typeof pathOrSchema === "string") {
      path = pathOrSchema.startsWith("/") ? pathOrSchema : `/${pathOrSchema}`;
      schema = schemaOrConfig as Table<TConfig>;
      config = maybeConfig!;
    } else {
      schema = pathOrSchema;
      path = `/${getTableName(schema)}`;
      config = schemaOrConfig as ResourceConfig<TConfig, Table<TConfig>>;
    }

    this.route(`${this.resourceBasePath}${path}`, useResource(schema, config));
    return this;
  }
}

const normalizeBasePath = (path: string): string => {
  if (path === "/" || path === "") return "";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
};

export const createConcave = (options: ConcaveOptions = {}): ConcaveApp =>
  new ConcaveApp(options);
