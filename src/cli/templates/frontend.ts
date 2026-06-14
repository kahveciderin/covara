import type { ScaffoldOptions } from "../options.js";

// The dev API/admin origin the standalone `vite` server proxies to. In the node
// template the single-process dev server embeds Vite (no proxy needed), but this
// keeps `vite` usable on its own; cloudflare dev runs `wrangler dev` on :8787.
const proxyTarget = (options: ScaffoldOptions): string =>
  options.template === "cloudflare"
    ? "http://localhost:8787"
    : "http://localhost:3000";

export const renderViteConfig = (options: ScaffoldOptions): string =>
  `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The node template embeds this Vite server in-process during \`covara dev\`
// (HMR + API on one origin, no proxy). The proxy below only applies if you run
// \`vite\` standalone.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "${proxyTarget(options)}",
      "/__covara": "${proxyTarget(options)}",
    },
  },
});
`;

export const FRONTEND_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
`;

export const renderFrontendIndexHtml = (options: ScaffoldOptions): string =>
  `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${options.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

export const FRONTEND_MAIN = `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

export const FRONTEND_APP = `import { useState } from "react";
import { getOrCreateClient } from "covara/client";
import { useLiveList } from "covara/client/react";

// A live, real-time view of the scaffolded \`todos\` resource. \`useLiveList\`
// opens an SSE subscription, so inserts/updates/deletes (from this tab or any
// other client) stream in automatically.
//
// This uses the generic typed hook with a hand-written Todo interface so it
// compiles on the first run with no codegen. Run \`npm run types\` against the
// dev server to generate \`src/generated/api-types.ts\` and switch to the fully
// typed client (createTypedClient) when you want end-to-end inferred types.
interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
});

export function App() {
  const { items, statusLabel, mutate } = useLiveList<Todo>("/api/todos", {
    orderBy: "createdAt",
  });
  const [title, setTitle] = useState("");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    mutate.create({ title: value, completed: false });
    setTitle("");
  };

  return (
    <main className="app">
      <header className="app__header">
        <h1>Todos</h1>
        <span className="app__status">{statusLabel}</span>
      </header>

      <form className="app__add" onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
        />
        <button type="submit">Add</button>
      </form>

      <ul className="app__list">
        {items.map((todo) => (
          <li key={todo.id} className="todo">
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() =>
                  mutate.update(todo.id, { completed: !todo.completed })
                }
              />
              <span className={todo.completed ? "todo--done" : ""}>
                {todo.title}
              </span>
            </label>
            <button onClick={() => mutate.delete(todo.id)}>✕</button>
          </li>
        ))}
        {items.length === 0 && <li className="todo todo--empty">No todos yet</li>}
      </ul>
    </main>
  );
}
`;

export const FRONTEND_STYLES = `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
}
body {
  margin: 0;
  background: #f6f7f9;
}
.app {
  max-width: 32rem;
  margin: 3rem auto;
  padding: 0 1rem;
}
.app__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.app__status {
  font-size: 0.8rem;
  opacity: 0.6;
}
.app__add {
  display: flex;
  gap: 0.5rem;
  margin: 1rem 0;
}
.app__add input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 6px;
}
.app__add button {
  padding: 0.5rem 1rem;
  border: 0;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  cursor: pointer;
}
.app__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.todo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.8rem;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.todo label {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.todo--done {
  text-decoration: line-through;
  opacity: 0.5;
}
.todo--empty {
  justify-content: center;
  opacity: 0.5;
}
.todo button {
  border: 0;
  background: transparent;
  cursor: pointer;
  opacity: 0.5;
}
.todo button:hover {
  opacity: 1;
}
`;

// A committed placeholder so the project type-checks before the first codegen.
// \`covara dev\` (and \`npm run types\`) regenerate this from the running server.
export const FRONTEND_API_TYPES_STUB = `// AUTO-GENERATED PLACEHOLDER — regenerated by \`covara dev\` / \`npm run types\`.
// Until then this stub lets the project type-check. The starter App.tsx uses the
// generic client and does not import from here; switch to createTypedClient once
// real types are generated.
export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}
`;

export const renderFrontendGitignore = (): string => `node_modules/
dist/
*.local
`;

export const buildFrontendFiles = (
  options: ScaffoldOptions
): Record<string, string> => ({
  "frontend/vite.config.ts": renderViteConfig(options),
  "frontend/tsconfig.json": FRONTEND_TSCONFIG,
  "frontend/index.html": renderFrontendIndexHtml(options),
  "frontend/src/main.tsx": FRONTEND_MAIN,
  "frontend/src/App.tsx": FRONTEND_APP,
  "frontend/src/styles.css": FRONTEND_STYLES,
  "frontend/src/generated/api-types.ts": FRONTEND_API_TYPES_STUB,
});
