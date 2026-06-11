import { html, escapeHtml } from './utils';
import { styles } from './styles';
import { envBadge } from './components';

export interface NavItem {
  id: string;
  icon: string;
  label: string;
  href: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const navigation: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { id: 'dashboard', icon: '\u25A6', label: 'Dashboard', href: '/__covara/ui' },
      { id: 'resources', icon: '\u25A3', label: 'Resources', href: '/__covara/ui/resources' },
      { id: 'requests', icon: '\u2192', label: 'Requests', href: '/__covara/ui/requests' },
      { id: 'errors', icon: '\u26A0', label: 'Errors', href: '/__covara/ui/errors' },
    ],
  },
  {
    title: 'Data',
    items: [
      { id: 'data-explorer', icon: '\u2637', label: 'Data Explorer', href: '/__covara/ui/data-explorer' },
      { id: 'admin-audit', icon: '\u2611', label: 'Admin Audit', href: '/__covara/ui/admin-audit' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { id: 'filter-tester', icon: '\u29D6', label: 'Filter Tester', href: '/__covara/ui/filter-tester' },
      { id: 'subscriptions', icon: '\u21C4', label: 'Subscriptions', href: '/__covara/ui/subscriptions' },
      { id: 'changelog', icon: '\u2630', label: 'Changelog', href: '/__covara/ui/changelog' },
      { id: 'api-explorer', icon: '\u2318', label: 'API Explorer', href: '/__covara/ui/api-explorer' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'users', icon: '\u263A', label: 'Users', href: '/__covara/ui/users' },
      { id: 'sessions', icon: '\u26BF', label: 'Sessions', href: '/__covara/ui/sessions' },
      { id: 'tasks', icon: '\u231B', label: 'Task Queue', href: '/__covara/ui/tasks' },
      { id: 'kv-inspector', icon: '\u26C1', label: 'KV Inspector', href: '/__covara/ui/kv-inspector' },
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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(props.title)} - Covara Admin</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <style>${styles}</style>
  <script>
    // Theme handling
    const theme = localStorage.getItem('covara-theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('covara-theme', next);
      document.getElementById('theme-toggle').textContent = next === 'light' ? '\u263D' : '\u2600';
    }

    // Toast notifications
    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    // Listen for HTMX events
    document.addEventListener('htmx:afterRequest', function(evt) {
      const xhr = evt.detail.xhr;
      if (xhr.status >= 400) {
        try {
          const data = JSON.parse(xhr.responseText);
          showToast(data.detail || data.title || 'Request failed', 'error');
        } catch {
          showToast('Request failed', 'error');
        }
      }
    });

    document.addEventListener('htmx:sendError', function() {
      showToast('Network error', 'error');
    });

    // Update sidebar active state after navigation
    document.addEventListener('htmx:pushedIntoHistory', function(evt) {
      updateActiveNav();
    });

    document.addEventListener('htmx:afterSwap', function(evt) {
      // Also update on swap in case pushUrl triggered
      updateActiveNav();
    });

    function updateActiveNav() {
      const path = window.location.pathname;
      document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        const href = item.getAttribute('href');
        // Exact match for dashboard, prefix match for others
        if (href === path || (href !== '/__covara/ui' && path.startsWith(href))) {
          item.classList.add('active');
        }
      });
    }
  </script>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-logo">Covara</span>
        ${envBadge(props.mode)}
      </div>
      <nav class="sidebar-nav">
        ${navigation.map(section => html`
          <div class="nav-section">
            <div class="nav-section-title">${escapeHtml(section.title)}</div>
            ${section.items.map(item => html`
              <a class="nav-item ${props.activePage === item.id ? 'active' : ''}"
                 href="${item.href}"
                 hx-get="${item.href}"
                 hx-target="#content"
                 hx-push-url="true"
                 hx-swap="innerHTML">
                <span class="nav-icon">${item.icon}</span>
                <span>${escapeHtml(item.label)}</span>
              </a>
            `).join('')}
          </div>
        `).join('')}
      </nav>
    </aside>

    <main class="main">
      <header class="header">
        <div class="header-left">
          <span style="color: var(--text-2);">Admin Dashboard</span>
        </div>
        <div class="header-right">
          <button id="theme-toggle" class="btn btn-ghost btn-icon" onclick="toggleTheme()">
            <script>document.write(localStorage.getItem('covara-theme') === 'dark' ? '\u2600' : '\u263D')</script>
          </button>
        </div>
      </header>

      <div class="content" id="content">
        ${content}
      </div>
    </main>
  </div>

  <div id="toast-container" class="toast-container"></div>
</body>
</html>
`;

export const pageFragment = (content: string): string => content;
