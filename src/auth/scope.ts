import { ScopeConfig, ScopeFunction, CompiledScope, UserContext } from "@/resource/types";
import { allScope } from "./rsql";
import { UnauthorizedError, ForbiddenError } from "@/resource/error";

export type Operation = "read" | "create" | "update" | "delete" | "subscribe";

export class ScopeResolver {
  constructor(
    private config: ScopeConfig,
    private resourceName: string
  ) {}

  isPublic(operation: Operation): boolean {
    if (!this.config.public) return false;

    // Boolean form stays read/subscribe-only (writes require auth) for safety and
    // back-compat. The object form opts each operation in explicitly, including
    // create/update/delete for fully-public resources.
    if (typeof this.config.public === "boolean") {
      return this.config.public && (operation === "read" || operation === "subscribe");
    }

    return this.config.public[operation] === true;
  }

  private getScopeFunction(operation: Operation): ScopeFunction | undefined {
    switch (operation) {
      case "read":
        return this.config.read ?? this.config.scope;
      case "create":
        return this.config.create ?? this.config.scope;
      case "update":
        return this.config.update ?? this.config.scope;
      case "delete":
        return this.config.delete ?? this.config.scope;
      case "subscribe":
        return this.config.subscribe ?? this.config.read ?? this.config.scope;
    }
  }

  async resolve(operation: Operation, user: UserContext | null): Promise<CompiledScope> {
    if (this.isPublic(operation)) {
      return allScope();
    }

    if (!user) {
      throw new UnauthorizedError(
        `Authentication required for ${operation} on ${this.resourceName}`
      );
    }

    const scopeFn = this.getScopeFunction(operation);
    if (!scopeFn) {
      return allScope();
    }

    const scope = await scopeFn(user);
    return scope;
  }

  async canPerform(operation: Operation, user: UserContext | null): Promise<boolean> {
    try {
      const scope = await this.resolve(operation, user);
      return !scope.isEmpty();
    } catch {
      return false;
    }
  }

  async requirePermission(operation: Operation, user: UserContext | null): Promise<CompiledScope> {
    const scope = await this.resolve(operation, user);

    if (scope.isEmpty()) {
      throw new ForbiddenError(
        `Not authorized to ${operation} on ${this.resourceName}`
      );
    }

    return scope;
  }
}

export const createScopeResolver = (
  config: ScopeConfig | undefined,
  resourceName: string
): ScopeResolver => {
  return new ScopeResolver(config ?? {}, resourceName);
};

export const combineScopes = (
  userScope: CompiledScope,
  additionalFilter?: string
): string => {
  if (!additionalFilter || additionalFilter.trim() === "") {
    return userScope.toString();
  }

  if (userScope.isEmpty()) {
    return additionalFilter;
  }

  const scopeStr = userScope.toString();
  if (scopeStr === "*") {
    return additionalFilter;
  }

  return `(${scopeStr});(${additionalFilter})`;
};

export const checkObjectAccess = async (
  resolver: ScopeResolver,
  operation: Operation,
  user: UserContext | null,
  object: Record<string, unknown>,
  filterCompile: (expr: string) => { execute: (obj: unknown) => boolean }
): Promise<boolean> => {
  try {
    const scope = await resolver.resolve(operation, user);

    if (scope.toString() === "*") {
      return true;
    }

    if (scope.isEmpty()) {
      return false;
    }

    const compiled = filterCompile(scope.toString());
    return compiled.execute(object);
  } catch {
    return false;
  }
};

export const scopePatterns = {
  ownerOnly: (ownerField = "userId"): ScopeConfig => ({
    scope: async (user) => {
      const { eq } = await import("./rsql");
      return eq(ownerField, user.id);
    },
  }),

  publicReadOwnerWrite: (ownerField = "userId"): ScopeConfig => ({
    public: { read: true, subscribe: true },
    create: async (user) => {
      const { eq } = await import("./rsql");
      return eq(ownerField, user.id);
    },
    update: async (user) => {
      const { eq } = await import("./rsql");
      return eq(ownerField, user.id);
    },
    delete: async (user) => {
      const { eq } = await import("./rsql");
      return eq(ownerField, user.id);
    },
  }),

  ownerOrAdmin: (
    ownerField = "userId",
    isAdmin: (user: UserContext) => boolean
  ): ScopeConfig => ({
    scope: async (user) => {
      const { eq, allScope } = await import("./rsql");
      if (isAdmin(user)) {
        return allScope();
      }
      return eq(ownerField, user.id);
    },
  }),

  orgBased: (orgField = "organizationId"): ScopeConfig => ({
    scope: async (user) => {
      const { eq } = await import("./rsql");
      const orgId = user.metadata?.organizationId;
      if (!orgId) {
        const { emptyScope } = await import("./rsql");
        return emptyScope();
      }
      return eq(orgField, orgId);
    },
  }),

  authenticatedFullAccess: (): ScopeConfig => ({
    scope: async () => {
      const { allScope } = await import("./rsql");
      return allScope();
    },
  }),

  fullyPublic: (): ScopeConfig => ({
    public: {
      read: true,
      subscribe: true,
    },
    create: async () => {
      const { allScope } = await import("./rsql");
      return allScope();
    },
    update: async () => {
      const { allScope } = await import("./rsql");
      return allScope();
    },
    delete: async () => {
      const { allScope } = await import("./rsql");
      return allScope();
    },
  }),
};
