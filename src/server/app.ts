import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { Table, TableConfig, getTableName } from "drizzle-orm";
import { errorHandler, notFoundHandler } from "@/middleware/error";
import { observabilityMiddleware, type ObservabilityConfig } from "@/middleware/observability";
import { useResource } from "@/resource/hook";
import { useFileResource, type FileResourceConfig, type FileTableSchema } from "@/storage";
import { hasGlobalStorage, getGlobalStorage } from "@/storage/types";
import type { UserContext } from "@/resource/types";
import type { ResourceConfigInput } from "@/resource/column-ref";
import { createHealthEndpoints, type HealthConfig } from "@/health";
import { createAdminUI, createAdminRequestLogger, createAdminBypassPredicate, setResourceMountPath, type AdminUIConfig } from "@/ui";
import { setAdminBypassPredicate } from "@/server/admin-bypass";
import {
  setImpersonationPredicate,
  setImpersonationUserResolver,
  createImpersonationMiddleware,
} from "@/server/impersonation";
import { listActiveSubscriptions, disconnectSubscription } from "@/resource/subscription";
import { changelog } from "@/resource/changelog";
import { createCovaraRouter, type CovaraRouterConfig } from "@/openapi/schema";
import { createSecurityHeaders, type SecurityHeadersOptions } from "@/middleware/securityHeaders";
import { onShutdown } from "@/server/lifecycle";
import { closeAllHandlers } from "@/resource/subscription";
import { installLiveSupport, type LiveSupport, type PageComponent } from "@/htmx/server";

let sseDrainHookRegistered = false;

export interface CovaraAuthSetup {
  router: Hono;
  middleware: MiddlewareHandler;
  path?: string;
}

export interface CovaraOptions {
  basePath?: string;
  cors?: boolean | Parameters<typeof cors>[0];
  auth?: CovaraAuthSetup;
  middleware?: MiddlewareHandler[];
  observability?: boolean | ObservabilityConfig;
  health?: boolean | HealthConfig;
  adminUI?: boolean | AdminUIConfig;
  openapi?: boolean | CovaraRouterConfig;
  securityHeaders?: boolean | SecurityHeadersOptions;
  // When a local-disk storage adapter with a public `baseUrl` is configured
  // (via initializeStorage before createCovara), auto-mount static serving for
  // it so you never wire serveStatic by hand. Default true; set false to opt out.
  serveLocalStorage?: boolean;
}

export class CovaraApp extends Hono {
  private readonly resourceBasePath: string;
  private liveSupport?: LiveSupport;

  private get live(): LiveSupport {
    if (!this.liveSupport) {
      this.liveSupport = installLiveSupport(this);
    }
    return this.liveSupport;
  }

  constructor(options: CovaraOptions = {}) {
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

    // Feed the admin dashboard's request/error logs from real traffic so it
    // works out of the box (the admin UI's own routes are skipped).
    if (options.adminUI) {
      this.use("*", createAdminRequestLogger());
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
      const userAdmin = options.adminUI === true ? {} : options.adminUI;
      // Auto-wire the admin UI's live data sources (active subscriptions +
      // changelog) so the dashboard works out of the box; explicit user config
      // still takes precedence.
      const adminConfig: AdminUIConfig = {
        getActiveSubscriptions: () => listActiveSubscriptions(),
        disconnectSubscription: (id) => disconnectSubscription(id),
        changelog: {
          getCurrentSequence: () => changelog.getCurrentSequence(),
          getEntries: (fromSeq, limit) => changelog.getEntriesInRange(fromSeq, limit),
        },
        ...userAdmin,
      };
      const adminPredicate = createAdminBypassPredicate(adminConfig.security ?? {});
      setAdminBypassPredicate(adminPredicate);
      setImpersonationPredicate(adminPredicate);
      if (adminConfig.userManager) {
        const userManager = adminConfig.userManager;
        setImpersonationUserResolver(async (userId) => {
          const u = await userManager.getUser(userId);
          if (!u) return null;
          return {
            id: String(u.id),
            email: u.email ?? null,
            name: u.name ?? null,
            image: u.image ?? null,
            emailVerified: u.emailVerified ?? null,
            sessionId: "impersonation",
            sessionExpiresAt: new Date(0),
            metadata: u.metadata ?? undefined,
          } satisfies UserContext;
        });
      }
      this.use("*", createImpersonationMiddleware());
      this.route("/__covara", createAdminUI(adminConfig));
    }

    if (options.openapi !== false) {
      this.route(
        "/__covara",
        createCovaraRouter(
          options.openapi === true || options.openapi === undefined
            ? {}
            : options.openapi
        )
      );
    }

    if (options.serveLocalStorage !== false) {
      this.mountLocalStorageServing();
    }
  }

  // Auto-mount static serving for a local-disk storage adapter that exposes a
  // public `baseUrl`, so apps don't configure serveStatic by hand. Registered
  // during construction (before user routes) so a greedy SPA catch-all can't
  // shadow it. serveStatic is Node-only and lazily imported on first request;
  // the route is only mounted when a local adapter with a baseUrl is present
  // (detected structurally to keep this file free of Node-only imports).
  private mountLocalStorageServing(): void {
    if (!hasGlobalStorage()) return;
    const storage = getGlobalStorage() as {
      getStaticServeConfig?: () => { basePath: string; baseUrl: string } | null;
    };
    const cfg = storage.getStaticServeConfig?.();
    if (!cfg) return;

    const prefix = new RegExp(`^${cfg.baseUrl}`);
    let middleware: MiddlewareHandler | null = null;
    let loading: Promise<MiddlewareHandler> | null = null;
    const load = (): Promise<MiddlewareHandler> => {
      if (!loading) {
        loading = import("@hono/node-server/serve-static").then(({ serveStatic }) => {
          middleware = serveStatic({
            root: cfg.basePath,
            rewriteRequestPath: (p: string) => p.replace(prefix, ""),
          }) as MiddlewareHandler;
          return middleware;
        });
      }
      return loading;
    };

    this.use(`${cfg.baseUrl}/*`, async (c, next) => {
      const mw = middleware ?? (await load());
      return mw(c, next);
    });
  }

  resource<TConfig extends TableConfig>(
    schema: Table<TConfig>,
    config: ResourceConfigInput<TConfig, Table<TConfig>>
  ): this;
  resource<TConfig extends TableConfig>(
    path: string,
    schema: Table<TConfig>,
    config: ResourceConfigInput<TConfig, Table<TConfig>>
  ): this;
  resource<TConfig extends TableConfig>(
    pathOrSchema: string | Table<TConfig>,
    schemaOrConfig: Table<TConfig> | ResourceConfigInput<TConfig, Table<TConfig>>,
    maybeConfig?: ResourceConfigInput<TConfig, Table<TConfig>>
  ): this {
    let path: string;
    let schema: Table<TConfig>;
    let config: ResourceConfigInput<TConfig, Table<TConfig>>;

    if (typeof pathOrSchema === "string") {
      path = pathOrSchema.startsWith("/") ? pathOrSchema : `/${pathOrSchema}`;
      schema = schemaOrConfig as Table<TConfig>;
      config = maybeConfig!;
    } else {
      schema = pathOrSchema;
      path = `/${getTableName(schema)}`;
      config = schemaOrConfig as ResourceConfigInput<TConfig, Table<TConfig>>;
    }

    const mountPath = `${this.resourceBasePath}${path}`;
    this.route(mountPath, useResource(schema, config));
    // Register the mount path eagerly so OpenAPI and the admin API explorer
    // show the real path before the resource receives its first request
    // (useResource alone only captures it lazily).
    setResourceMountPath(getTableName(schema), mountPath);
    // Make this resource reachable from htmx <Live> pages.
    this.live.registerResource(getTableName(schema), {
      mountPath,
      idField: (config.id as unknown as { name: string }).name,
    });
    return this;
  }

  fileResource<TConfig extends TableConfig>(
    table: Table<TConfig> & FileTableSchema,
    config: FileResourceConfig<TConfig>
  ): this;
  fileResource<TConfig extends TableConfig>(
    path: string,
    table: Table<TConfig> & FileTableSchema,
    config: FileResourceConfig<TConfig>
  ): this;
  fileResource<TConfig extends TableConfig>(
    pathOrTable: string | (Table<TConfig> & FileTableSchema),
    tableOrConfig: (Table<TConfig> & FileTableSchema) | FileResourceConfig<TConfig>,
    maybeConfig?: FileResourceConfig<TConfig>
  ): this {
    let path: string;
    let table: Table<TConfig> & FileTableSchema;
    let config: FileResourceConfig<TConfig>;

    if (typeof pathOrTable === "string") {
      path = pathOrTable.startsWith("/") ? pathOrTable : `/${pathOrTable}`;
      table = tableOrConfig as Table<TConfig> & FileTableSchema;
      config = maybeConfig!;
    } else {
      table = pathOrTable;
      path = `/${getTableName(table)}`;
      config = tableOrConfig as FileResourceConfig<TConfig>;
    }

    const mountPath = `${this.resourceBasePath}${path}`;
    this.route(mountPath, useFileResource(table, config));
    setResourceMountPath(getTableName(table), mountPath);
    return this;
  }

  // Register a server-rendered htmx page. The single JSX component is the spec:
  // its <Live> regions drive full SSR plus auto-generated list/create/update/
  // delete/subscribe endpoints under /__covara/live. See covara/htmx.
  page(path: string, component: PageComponent): this {
    this.live.registerPage(path.startsWith("/") ? path : `/${path}`, component);
    return this;
  }
}

const normalizeBasePath = (path: string): string => {
  if (path === "/" || path === "") return "";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
};

export const createCovara = (options: CovaraOptions = {}): CovaraApp =>
  new CovaraApp(options);
