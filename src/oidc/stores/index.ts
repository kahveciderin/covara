import {
  AuthorizationCode,
  AuthorizationCodeStore,
  ClientStore,
  ConsentStore,
  InteractionData,
  InteractionStore,
  OIDCClient,
  OIDCProviderStores,
  RefreshTokenData,
  RefreshTokenStore,
  StateStore,
  StoreConfig,
  UserConsent,
} from "../types";
import { KVAdapter } from "@/kv/types";
import { getGlobalKV, hasGlobalKV } from "@/kv";

const PREFIX = "oidc";

export class InMemoryClientStore implements ClientStore {
  private clients = new Map<string, OIDCClient>();

  constructor(clients: OIDCClient[] = []) {
    for (const client of clients) {
      this.clients.set(client.id, client);
    }
  }

  async get(clientId: string): Promise<OIDCClient | null> {
    return this.clients.get(clientId) ?? null;
  }

  async getAll(): Promise<OIDCClient[]> {
    return Array.from(this.clients.values());
  }

  async set(client: OIDCClient): Promise<void> {
    this.clients.set(client.id, client);
  }

  async delete(clientId: string): Promise<void> {
    this.clients.delete(clientId);
  }
}

export class InMemoryAuthorizationCodeStore implements AuthorizationCodeStore {
  private codes = new Map<string, AuthorizationCode>();

  async set(code: AuthorizationCode): Promise<void> {
    this.codes.set(code.code, code);
    setTimeout(() => this.codes.delete(code.code), code.expiresAt - Date.now());
  }

  async get(code: string): Promise<AuthorizationCode | null> {
    const data = this.codes.get(code);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      this.codes.delete(code);
      return null;
    }
    return data;
  }

  async delete(code: string): Promise<void> {
    this.codes.delete(code);
  }
}

export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private tokens = new Map<string, RefreshTokenData>();
  private userIndex = new Map<string, Set<string>>();

  async set(data: RefreshTokenData): Promise<void> {
    this.tokens.set(data.token, data);

    const userTokens = this.userIndex.get(data.userId) ?? new Set();
    userTokens.add(data.token);
    this.userIndex.set(data.userId, userTokens);
  }

  async get(token: string): Promise<RefreshTokenData | null> {
    const data = this.tokens.get(token);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      await this.delete(token);
      return null;
    }
    return data;
  }

  async delete(token: string): Promise<void> {
    const data = this.tokens.get(token);
    if (data) {
      const userTokens = this.userIndex.get(data.userId);
      userTokens?.delete(token);
    }
    this.tokens.delete(token);
  }

  async deleteByUserId(userId: string): Promise<void> {
    const userTokens = this.userIndex.get(userId);
    if (userTokens) {
      for (const token of userTokens) {
        this.tokens.delete(token);
      }
      this.userIndex.delete(userId);
    }
  }
}

export class InMemoryConsentStore implements ConsentStore {
  private consents = new Map<string, UserConsent>();

  private key(userId: string, clientId: string): string {
    return `${userId}:${clientId}`;
  }

  async get(userId: string, clientId: string): Promise<UserConsent | null> {
    const consent = this.consents.get(this.key(userId, clientId));
    if (!consent) return null;
    if (consent.expiresAt && Date.now() > consent.expiresAt) {
      await this.delete(userId, clientId);
      return null;
    }
    return consent;
  }

  async set(consent: UserConsent): Promise<void> {
    this.consents.set(this.key(consent.userId, consent.clientId), consent);
  }

  async delete(userId: string, clientId: string): Promise<void> {
    this.consents.delete(this.key(userId, clientId));
  }

  async deleteByUserId(userId: string): Promise<void> {
    for (const [key] of this.consents) {
      if (key.startsWith(`${userId}:`)) {
        this.consents.delete(key);
      }
    }
  }
}

export class InMemoryInteractionStore implements InteractionStore {
  private interactions = new Map<string, InteractionData>();

  async set(id: string, data: InteractionData): Promise<void> {
    this.interactions.set(id, data);
    setTimeout(
      () => this.interactions.delete(id),
      data.expiresAt - Date.now()
    );
  }

  async get(id: string): Promise<InteractionData | null> {
    const data = this.interactions.get(id);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      this.interactions.delete(id);
      return null;
    }
    return data;
  }

  async delete(id: string): Promise<void> {
    this.interactions.delete(id);
  }
}

export class InMemoryStateStore implements StateStore {
  private states = new Map<
    string,
    { provider: string; nonce: string; codeVerifier: string; returnTo?: string }
  >();

  async set(
    state: string,
    data: { provider: string; nonce: string; codeVerifier: string; returnTo?: string }
  ): Promise<void> {
    this.states.set(state, data);
    setTimeout(() => this.states.delete(state), 10 * 60 * 1000);
  }

  async get(state: string): Promise<{
    provider: string;
    nonce: string;
    codeVerifier: string;
    returnTo?: string;
  } | null> {
    return this.states.get(state) ?? null;
  }

  async delete(state: string): Promise<void> {
    this.states.delete(state);
  }
}

export class KVClientStore implements ClientStore {
  constructor(
    private kv: KVAdapter,
    private prefix: string = PREFIX
  ) {}

  private key(clientId: string): string {
    return `${this.prefix}:clients:${clientId}`;
  }

  async get(clientId: string): Promise<OIDCClient | null> {
    const data = await this.kv.get(this.key(clientId));
    return data ? JSON.parse(data) : null;
  }

  async getAll(): Promise<OIDCClient[]> {
    const keys = await this.kv.keys(`${this.prefix}:clients:*`);
    const clients: OIDCClient[] = [];
    for (const key of keys) {
      const data = await this.kv.get(key);
      if (data) clients.push(JSON.parse(data));
    }
    return clients;
  }

  async set(client: OIDCClient): Promise<void> {
    await this.kv.set(this.key(client.id), JSON.stringify(client));
  }

  async delete(clientId: string): Promise<void> {
    await this.kv.del(this.key(clientId));
  }
}

export class KVAuthorizationCodeStore implements AuthorizationCodeStore {
  constructor(
    private kv: KVAdapter,
    private prefix: string = PREFIX
  ) {}

  private key(code: string): string {
    return `${this.prefix}:authcodes:${code}`;
  }

  async set(code: AuthorizationCode): Promise<void> {
    const ttl = Math.ceil((code.expiresAt - Date.now()) / 1000);
    await this.kv.set(this.key(code.code), JSON.stringify(code), { ex: ttl });
  }

  async get(code: string): Promise<AuthorizationCode | null> {
    const data = await this.kv.get(this.key(code));
    return data ? JSON.parse(data) : null;
  }

  async delete(code: string): Promise<void> {
    await this.kv.del(this.key(code));
  }
}

export class KVRefreshTokenStore implements RefreshTokenStore {
  constructor(
    private kv: KVAdapter,
    private prefix: string = PREFIX
  ) {}

  private key(token: string): string {
    return `${this.prefix}:refresh:${token}`;
  }

  private userKey(userId: string): string {
    return `${this.prefix}:refresh:user:${userId}`;
  }

  async set(data: RefreshTokenData): Promise<void> {
    const ttl = Math.ceil((data.expiresAt - Date.now()) / 1000);
    await this.kv.set(this.key(data.token), JSON.stringify(data), { ex: ttl });
    await this.kv.sadd(this.userKey(data.userId), data.token);
  }

  async get(token: string): Promise<RefreshTokenData | null> {
    const data = await this.kv.get(this.key(token));
    return data ? JSON.parse(data) : null;
  }

  async delete(token: string): Promise<void> {
    const data = await this.get(token);
    if (data) {
      await this.kv.srem(this.userKey(data.userId), token);
    }
    await this.kv.del(this.key(token));
  }

  async deleteByUserId(userId: string): Promise<void> {
    const tokens = await this.kv.smembers(this.userKey(userId));
    for (const token of tokens) {
      await this.kv.del(this.key(token));
    }
    await this.kv.del(this.userKey(userId));
  }
}

export class KVConsentStore implements ConsentStore {
  constructor(
    private kv: KVAdapter,
    private prefix: string = PREFIX
  ) {}

  private key(userId: string, clientId: string): string {
    return `${this.prefix}:consent:${userId}:${clientId}`;
  }

  async get(userId: string, clientId: string): Promise<UserConsent | null> {
    const data = await this.kv.get(this.key(userId, clientId));
    return data ? JSON.parse(data) : null;
  }

  async set(consent: UserConsent): Promise<void> {
    const options: { ex?: number } = {};
    if (consent.expiresAt) {
      options.ex = Math.ceil((consent.expiresAt - Date.now()) / 1000);
    }
    await this.kv.set(
      this.key(consent.userId, consent.clientId),
      JSON.stringify(consent),
      options
    );
  }

  async delete(userId: string, clientId: string): Promise<void> {
    await this.kv.del(this.key(userId, clientId));
  }

  async deleteByUserId(userId: string): Promise<void> {
    const keys = await this.kv.keys(`${this.prefix}:consent:${userId}:*`);
    for (const key of keys) {
      await this.kv.del(key);
    }
  }
}

export class KVInteractionStore implements InteractionStore {
  constructor(
    private kv: KVAdapter,
    private prefix: string = PREFIX
  ) {}

  private key(id: string): string {
    return `${this.prefix}:interaction:${id}`;
  }

  async set(id: string, data: InteractionData): Promise<void> {
    const ttl = Math.ceil((data.expiresAt - Date.now()) / 1000);
    await this.kv.set(this.key(id), JSON.stringify(data), { ex: ttl });
  }

  async get(id: string): Promise<InteractionData | null> {
    const data = await this.kv.get(this.key(id));
    return data ? JSON.parse(data) : null;
  }

  async delete(id: string): Promise<void> {
    await this.kv.del(this.key(id));
  }
}

export class KVStateStore implements StateStore {
  constructor(
    private kv: KVAdapter,
    private prefix: string = PREFIX
  ) {}

  private key(state: string): string {
    return `${this.prefix}:state:${state}`;
  }

  async set(
    state: string,
    data: { provider: string; nonce: string; codeVerifier: string; returnTo?: string }
  ): Promise<void> {
    await this.kv.set(this.key(state), JSON.stringify(data), { ex: 600 });
  }

  async get(state: string): Promise<{
    provider: string;
    nonce: string;
    codeVerifier: string;
    returnTo?: string;
  } | null> {
    const data = await this.kv.get(this.key(state));
    return data ? JSON.parse(data) : null;
  }

  async delete(state: string): Promise<void> {
    await this.kv.del(this.key(state));
  }
}

const buildKVStores = (
  kv: KVAdapter,
  prefix: string,
  clients: OIDCClient[]
): OIDCProviderStores => {
  const clientStore = new KVClientStore(kv, prefix);
  for (const client of clients) {
    void clientStore.set(client);
  }
  return {
    clients: clientStore,
    authorizationCodes: new KVAuthorizationCodeStore(kv, prefix),
    refreshTokens: new KVRefreshTokenStore(kv, prefix),
    consent: new KVConsentStore(kv, prefix),
    interactions: new KVInteractionStore(kv, prefix),
    state: new KVStateStore(kv, prefix),
  };
};

export const createStores = (
  config: StoreConfig | undefined,
  clients: OIDCClient[]
): OIDCProviderStores => {
  const prefix = config?.prefix ?? PREFIX;

  if (config?.kv) {
    return buildKVStores(config.kv, prefix, clients);
  }

  const forcedMemory = config?.type === "memory";

  if (!forcedMemory && hasGlobalKV()) {
    return buildKVStores(getGlobalKV(), prefix, clients);
  }

  const clientStore = new InMemoryClientStore(clients);
  return {
    clients: clientStore,
    authorizationCodes: new InMemoryAuthorizationCodeStore(),
    refreshTokens: new InMemoryRefreshTokenStore(),
    consent: new InMemoryConsentStore(),
    interactions: new InMemoryInteractionStore(),
    state: new InMemoryStateStore(),
  };
};
