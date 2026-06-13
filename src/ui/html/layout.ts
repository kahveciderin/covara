import { html, escapeHtml } from "./utils";
import { styles } from "./styles";
import { envBadge } from "./components";
import { icon } from "./icons";

export interface NavItem {
  id: string;
  icon: string;
  label: string;
  href: string;
  isExternal?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const navigation: NavSection[] = [
  {
    title: "Overview",
    items: [
      {
        id: "dashboard",
        icon: "dashboard",
        label: "Dashboard",
        href: "/__covara/ui",
      },
      {
        id: "resources",
        icon: "resources",
        label: "Resources",
        href: "/__covara/ui/resources",
      },
      {
        id: "requests",
        icon: "requests",
        label: "Requests",
        href: "/__covara/ui/requests",
      },
      {
        id: "errors",
        icon: "errors",
        label: "Errors",
        href: "/__covara/ui/errors",
      },
    ],
  },
  {
    title: "Data",
    items: [
      {
        id: "data-explorer",
        icon: "data",
        label: "Data Explorer",
        href: "/__covara/ui/data-explorer",
      },
      {
        id: "admin-audit",
        icon: "audit",
        label: "Admin Audit",
        href: "/__covara/ui/admin-audit",
      },
    ],
  },
  {
    title: "Tools",
    items: [
      {
        id: "filter-tester",
        icon: "filter",
        label: "Filter Tester",
        href: "/__covara/ui/filter-tester",
      },
      {
        id: "subscriptions",
        icon: "subscriptions",
        label: "Subscriptions",
        href: "/__covara/ui/subscriptions",
      },
      {
        id: "changelog",
        icon: "changelog",
        label: "Changelog",
        href: "/__covara/ui/changelog",
      },
      {
        id: "api-explorer",
        icon: "api",
        label: "API Explorer",
        href: "/__covara/ui/api-explorer",
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        id: "users",
        icon: "users",
        label: "Users",
        href: "/__covara/ui/users",
      },
      {
        id: "sessions",
        icon: "sessions",
        label: "Sessions",
        href: "/__covara/ui/sessions",
      },
      {
        id: "tasks",
        icon: "tasks",
        label: "Task Queue",
        href: "/__covara/ui/tasks",
      },
      {
        id: "kv-inspector",
        icon: "kv",
        label: "KV Inspector",
        href: "/__covara/ui/kv-inspector",
      },
    ],
  },
  {
    title: "Help",
    items: [
      {
        id: "docs",
        icon: "docs",
        label: "Documentation",
        href: "https://kahveciderin.github.io/covara/",
        isExternal: true,
      },
    ],
  },
];

export interface LayoutProps {
  title: string;
  activePage: string;
  mode: string;
}

export const layout = (props: LayoutProps, content: string): string => html`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(props.title)} - Covara Admin</title>
      <link rel="icon" type="image/svg+xml" href="/__covara/logo.svg" />
      <script src="/__covara/ui/htmx.js"></script>
      <style>
        ${styles}
      </style>
      <script>
        window.__COVARA__ = {
          basePath: "/__covara",
          nav: ${JSON.stringify(
            navigation.map((s) => ({
              title: s.title,
              items: s.items.map((i) => ({
                icon: icon(i.icon),
                label: i.label,
                href: i.href,
              })),
            }))
          )},
        };
      </script>
      <script src="/__covara/ui/covara-runtime.js" defer></script>
      <script>
        // Theme handling
        const theme = localStorage.getItem("covara-theme") || "light";
        document.documentElement.setAttribute("data-theme", theme);

        function toggleTheme() {
          const current = document.documentElement.getAttribute("data-theme");
          const next = current === "light" ? "dark" : "light";
          document.documentElement.setAttribute("data-theme", next);
          localStorage.setItem("covara-theme", next);
          document.getElementById("theme-toggle").textContent =
            next === "light" ? "☽" : "☀";
        }

        // Toast notifications
        function showToast(message, type = "success") {
          const container = document.getElementById("toast-container");
          const toast = document.createElement("div");
          toast.className = "toast toast-" + type;
          toast.textContent = message;
          container.appendChild(toast);
          setTimeout(() => toast.remove(), 3000);
        }

        // Listen for HTMX events
        document.addEventListener("htmx:afterRequest", function (evt) {
          const xhr = evt.detail.xhr;
          if (xhr.status >= 400) {
            try {
              const data = JSON.parse(xhr.responseText);
              showToast(data.detail || data.title || "Request failed", "error");
            } catch {
              showToast("Request failed", "error");
            }
          }
        });

        document.addEventListener("htmx:sendError", function () {
          showToast("Network error", "error");
        });

        // Update sidebar active state after navigation
        document.addEventListener("htmx:pushedIntoHistory", function (evt) {
          updateActiveNav();
        });

        document.addEventListener("htmx:afterSwap", function (evt) {
          // Also update on swap in case pushUrl triggered
          updateActiveNav();
        });

        function updateActiveNav() {
          const path = window.location.pathname;
          document.querySelectorAll(".nav-item").forEach((item) => {
            item.classList.remove("active");
            const href = item.getAttribute("href");
            // Exact match for dashboard, prefix match for others
            if (
              href === path ||
              (href !== "/__covara/ui" && path.startsWith(href))
            ) {
              item.classList.add("active");
            }
          });
        }
      </script>
    </head>
    <body>
      <div class="app">
        <aside class="sidebar">
          <div class="sidebar-header">
            <span class="sidebar-logo">
              <img
                class="sidebar-logo-img"
                src="/__covara/logo.svg"
                alt="Covara"
                width="24"
                height="24"
              />
              Covara
            </span>
            ${envBadge(props.mode)}
          </div>
          <nav class="sidebar-nav">
            ${navigation
              .map(
                (section) => html`
                  <div class="nav-section">
                    <div class="nav-section-title">
                      ${escapeHtml(section.title)}
                    </div>
                    ${section.items
                      .map(
                        (item) => 
                        item.isExternal ? html`
                        <a class="nav-item" href="${item.href}" target="_blank" rel="noopener">
                          <span class="nav-icon">${icon(item.icon)}</span>
                          <span>${escapeHtml(item.label)}</span>
                          <span class="external-link-icon">${icon("external-link")}</span>
                        </a>
                        ` : html`
                          <a
                            class="nav-item ${props.activePage === item.id
                              ? "active"
                              : ""}"
                            href="${item.href}"
                            hx-get="${item.href}"
                            hx-target="#content"
                            hx-push-url="true"
                            hx-swap="innerHTML"
                          >
                            <span class="nav-icon">${icon(item.icon)}</span>
                            <span>${escapeHtml(item.label)}</span>
                          </a>
                        `
                      )
                      .join("")}
                  </div>
                `
              )
              .join("")}
          </nav>
        </aside>

        <main class="main">
          <header class="header">
            <div class="header-left">
              <button
                class="cmdk-trigger"
                onclick="window.Covara && Covara.openPalette()"
              >
                <span class="row">${icon("search")}</span>
                <span>Search or jump to…</span>
                <span class="spacer"></span>
                <kbd>⌘K</kbd>
              </button>
            </div>
            <div class="header-right">
              <div
                id="impersonation-badge"
                hidden
                style="align-items:center;gap:8px;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;background:#7c2d12;color:#fed7aa;border:1px solid #c2410c;"
              ></div>
              <button
                id="theme-toggle"
                class="btn btn-ghost btn-icon"
                onclick="toggleTheme()"
              >
                <script>
                  document.write(
                    localStorage.getItem("covara-theme") === "dark" ? "☀" : "☽"
                  );
                </script>
              </button>
            </div>
          </header>

          <div class="content" id="content">${content}</div>
        </main>
      </div>

      <div id="toast-container" class="toast-container"></div>
    </body>
  </html>
`;

export const pageFragment = (content: string): string => content;
