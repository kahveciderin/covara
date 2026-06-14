import type { ScaffoldOptions } from "../options.js";

export const renderDockerfile = (): string => {
  return `# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN corepack enable && \\
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\
    else npm install; fi
COPY . .
RUN npm run build

FROM node:22-slim AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN corepack enable && \\
    if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile; \\
    elif [ -f yarn.lock ]; then yarn install --production --frozen-lockfile; \\
    else npm install --omit=dev; fi

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN groupadd --system --gid 1001 covara && \\
    useradd --system --uid 1001 --gid covara covara
COPY --chown=covara:covara package.json ./
COPY --from=deps --chown=covara:covara /app/node_modules ./node_modules
COPY --from=build --chown=covara:covara /app/dist ./dist
USER covara
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
`;
};

export const renderDockerignore = (): string =>
  `node_modules
dist
public
.git
.gitignore
.env
.env.*
!.env.example
*.db
*.db-journal
npm-debug.log*
.DS_Store
Dockerfile
.dockerignore
docker-compose.yml
`;

export const renderDockerCompose = (options: ScaffoldOptions): string => {
  const dbName = options.name.replace(/-/g, "_");
  const appEnv: string[] = [
    `      PORT: "3000"`,
    `      REDIS_URL: "redis://redis:6379"`,
  ];
  if (options.db === "sqlite") {
    appEnv.push(`      DB_FILE_NAME: "file:/data/dev.db"`);
  } else {
    appEnv.push(
      `      DATABASE_URL: "postgres://covara:covara@postgres:5432/${dbName}"`
    );
  }

  const appVolumes =
    options.db === "sqlite" ? `    volumes:\n      - app-data:/data\n` : "";

  const dependsOn =
    options.db === "sqlite"
      ? `    depends_on:
      redis:
        condition: service_started
`
      : `    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
`;

  const postgresService =
    options.db === "postgres"
      ? `
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: covara
      POSTGRES_PASSWORD: covara
      POSTGRES_DB: ${dbName}
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U covara -d ${dbName}"]
      interval: 5s
      timeout: 5s
      retries: 5
`
      : "";

  const volumes: string[] = ["  redis-data:"];
  if (options.db === "sqlite") volumes.unshift("  app-data:");
  if (options.db === "postgres") volumes.push("  postgres-data:");

  return `services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
${appEnv.join("\n")}
${appVolumes}${dependsOn}
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
${postgresService}
volumes:
${volumes.join("\n")}
`;
};

export const renderCiWorkflow = (): string => `name: CI

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Install dependencies
        run: npm install
      - name: Lint
        run: npm run lint --if-present
      - name: Test
        run: npm test --if-present
      - name: Build
        run: npm run build --if-present
`;
