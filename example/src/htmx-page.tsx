import { Live, type RegionContext } from "covara/htmx";
import { todosTable } from "./db/schema";

// A server-rendered htmx view of the same todos the React SPA uses. It shares
// the cookie session, so logging in through the React app authenticates this
// page too. Only <Live> is special — everything else is plain JSX wired with
// the c.* attribute helpers.
type Todo = { id: string; title: string; completed: boolean };

const Layout = (props: { children?: unknown }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>htmx Todos · Covara</title>
      <style>{`
        body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
        ul { list-style: none; padding: 0; }
        li { display: flex; align-items: center; gap: .5rem; padding: .4rem 0; border-bottom: 1px solid #eee; }
        li.cv-pending { opacity: .5; }
        .done { text-decoration: line-through; color: #888; }
        form.inline { display: inline; }
        button { cursor: pointer; }
        nav a { margin-right: 1rem; }
      `}</style>
    </head>
    <body>
      <nav>
        <a href="/">← React app</a>
        <a href="/__covara/ui">Admin</a>
      </nav>
      <h1>htmx Todos</h1>
      <p>
        Same data as the React app, server-rendered with htmx. Open this page in two tabs
        (or alongside the React app) and watch changes stream live.
      </p>
      {props.children}
    </body>
  </html>
);

export const todoHtmxPage = () => (
  <Layout>
    <Live<Todo>
      resource={todosTable}
      query={{ orderBy: "position", limit: 200 }}
      create={(c: RegionContext) => (
        <form {...c.create()}>
          <input name="title" placeholder="New todo" required autocomplete="off" />
          <button>Add</button>
        </form>
      )}
      container={(rows: unknown, c: RegionContext) => <ul {...c.container()}>{rows}</ul>}
      empty={() => <li>No todos yet — add one above.</li>}
      render={(t: Todo, c: RegionContext) => (
        <li {...c.row(t.id)}>
          <form class="inline" {...c.update(t.id)}>
            <input type="hidden" name="completed" value={t.completed ? "false" : "true"} />
            <button title="toggle">{t.completed ? "☑" : "☐"}</button>
          </form>
          <span class={t.completed ? "done" : ""}>{t.title}</span>
          <button {...c.delete(t.id)} style="margin-left:auto">
            ✕
          </button>
        </li>
      )}
    />
  </Layout>
);
