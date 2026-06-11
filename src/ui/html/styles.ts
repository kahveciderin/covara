export const styles = `
:root {
  --bg-0: #ffffff;
  --bg-1: #f7f8fa;
  --bg-2: #eef0f4;
  --bg-3: #e3e6ec;
  --text-0: #0f172a;
  --text-1: #334155;
  --text-2: #64748b;
  --text-3: #94a3b8;
  --border: #e6e8ee;
  --border-strong: #d4d8e0;
  --accent: #4f46e5;
  --accent-hover: #4338ca;
  --accent-contrast: #ffffff;
  --accent-light: #eef0ff;
  --success: #0f9d6f;
  --success-bg: #e7f7f0;
  --warning: #c2740a;
  --warning-bg: #fdf3e3;
  --error: #dc2626;
  --error-bg: #fdecec;
  --info: #4f46e5;
  --info-bg: #eef0ff;
  --radius-sm: 6px;
  --radius: 8px;
  --radius-lg: 12px;
  --shadow-sm: none;
  --shadow: none;
  --shadow-lg: 0 12px 32px -8px rgba(15,23,42,0.18);
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', 'JetBrains Mono', 'Consolas', 'Monaco', monospace;
}

[data-theme="dark"] {
  --bg-0: #0b0e14;
  --bg-1: #11151d;
  --bg-2: #1a2029;
  --bg-3: #232a35;
  --text-0: #f1f5f9;
  --text-1: #cbd5e1;
  --text-2: #94a3b8;
  --text-3: #64748b;
  --border: #232a35;
  --border-strong: #303948;
  --accent: #818cf8;
  --accent-hover: #a5b4fc;
  --accent-contrast: #0b0e14;
  --accent-light: #1e2236;
  --success: #34d399;
  --success-bg: #0e2a22;
  --warning: #fbbf24;
  --warning-bg: #2e2410;
  --error: #f87171;
  --error-bg: #2e1616;
  --info: #818cf8;
  --info-bg: #1e2236;
  --shadow-sm: none;
  --shadow: none;
  --shadow-lg: 0 16px 40px -10px rgba(0,0,0,0.6);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg-0);
  color: var(--text-0);
}

.app {
  display: flex;
  min-height: 100vh;
}

/* Sidebar */
.sidebar {
  width: 220px;
  background: var(--bg-1);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-logo {
  font-weight: 600;
  font-size: 16px;
}

.sidebar-nav {
  flex: 1;
  padding: 8px;
  overflow-y: auto;
}

.nav-section {
  margin-bottom: 16px;
}

.nav-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 8px 12px 4px;
  letter-spacing: 0.5px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius);
  color: var(--text-1);
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s;
}

.nav-item:hover {
  background: var(--bg-2);
}

.nav-item.active {
  background: var(--accent-light);
  color: var(--accent);
}

.nav-icon {
  width: 18px;
  text-align: center;
}

/* Main content */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.header {
  height: 52px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: var(--bg-1);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

/* Page header */
.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 4px;
}

.page-desc {
  color: var(--text-2);
}

/* Cards */
.card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.card-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-title {
  font-weight: 600;
}

.card-body {
  padding: 16px;
}

.card-body-flush {
  padding: 0;
}

/* Grid */
.grid {
  display: grid;
  gap: 16px;
}

.grid-2 { grid-template-columns: repeat(2, 1fr); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
.grid-5 { grid-template-columns: repeat(5, 1fr); }

/* Stats */
.stat-card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
}

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 500;
}

.badge-neutral {
  background: var(--bg-3);
  color: var(--text-1);
}

.badge-success {
  background: var(--success-bg);
  color: var(--success);
}

.badge-warning {
  background: var(--warning-bg);
  color: var(--warning);
}

.badge-error {
  background: var(--error-bg);
  color: var(--error);
}

.badge-info {
  background: var(--info-bg);
  color: var(--info);
}

.badge-method {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 6px;
}

.badge-get { background: var(--success-bg); color: var(--success); }
.badge-post { background: var(--info-bg); color: var(--info); }
.badge-patch { background: var(--warning-bg); color: var(--warning); }
.badge-put { background: #f3e6ff; color: #7b2cbf; }
.badge-delete { background: var(--error-bg); color: var(--error); }

[data-theme="dark"] .badge-put { background: #2d1f3d; color: #b36bff; }

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  text-decoration: none;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-secondary {
  background: var(--bg-2);
  color: var(--text-0);
  border: 1px solid var(--border);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-3);
}

.btn-ghost {
  background: transparent;
  color: var(--text-1);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-2);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-icon {
  width: 32px;
  height: 32px;
  padding: 0;
}

/* Inputs */
.input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  background: var(--bg-0);
  color: var(--text-0);
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--accent);
}

.input-mono {
  font-family: var(--font-mono);
}

.select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L2 4h8z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
}

/* Tables */
.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.table th {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-2);
}

.table tbody tr:hover {
  background: var(--bg-2);
}

.table-mono td {
  font-family: var(--font-mono);
  font-size: 12px;
}

.table-sortable th {
  cursor: pointer;
  user-select: none;
}

.table-sortable th:hover {
  background: var(--bg-3);
}

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* List items */
.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.list-item:last-child {
  border-bottom: none;
}

.list-item:hover {
  background: var(--bg-2);
}

/* Empty state */
.empty-state {
  padding: 40px;
  text-align: center;
  color: var(--text-2);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-1);
}

.empty-desc {
  font-size: 13px;
}

/* Code */
.code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-2);
  padding: 12px;
  border-radius: var(--radius);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.code-inline {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-2);
  padding: 2px 6px;
  border-radius: var(--radius);
}

/* Alerts */
.alert {
  padding: 12px 16px;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert-warning {
  background: var(--warning-bg);
  color: var(--warning);
}

.alert-error {
  background: var(--error-bg);
  color: var(--error);
}

.alert-info {
  background: var(--info-bg);
  color: var(--info);
}

.alert-success {
  background: var(--success-bg);
  color: var(--success);
}

/* Environment badges */
.env-badge {
  padding: 4px 10px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.env-dev {
  background: var(--success-bg);
  color: var(--success);
}

.env-staging {
  background: var(--warning-bg);
  color: var(--warning);
}

.env-prod {
  background: var(--info-bg);
  color: var(--info);
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-0);
  border-radius: var(--radius);
  box-shadow: 0 4px 20px rgba(0,0,0,0.2);
  min-width: 400px;
  max-width: 90vw;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  font-weight: 600;
  font-size: 16px;
}

.modal-body {
  padding: 16px;
  overflow-y: auto;
}

.modal-footer {
  padding: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Form */
.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
}

/* Toast notifications */
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  padding: 12px 16px;
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  animation: slideIn 0.2s ease;
}

.toast-success {
  background: var(--success);
  color: white;
}

.toast-error {
  background: var(--error);
  color: white;
}

@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* Loading */
.loading {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* HTMX loading indicator */
.htmx-request .htmx-indicator {
  display: inline-block;
}

.htmx-indicator {
  display: none;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar {
    display: none;
  }

  .grid-4, .grid-3 {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* ============================================================
   Covara Admin — modern component layer (overrides + additions)
   ============================================================ */

body { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; letter-spacing: -0.006em; }

::selection { background: var(--accent-light); }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 999px; border: 2px solid var(--bg-0); }
*::-webkit-scrollbar-thumb:hover { background: var(--text-3); }

/* Sidebar */
.sidebar { width: 248px; background: var(--bg-1); }
.sidebar-header { padding: 18px 18px; gap: 10px; }
.sidebar-logo { font-size: 17px; letter-spacing: -0.02em; display: flex; align-items: center; gap: 9px; }
.sidebar-logo::before {
  content: ""; width: 20px; height: 20px; border-radius: 6px;
  background: var(--accent); flex-shrink: 0;
}
.sidebar-nav { padding: 10px 10px; }
.nav-section-title { font-size: 10.5px; letter-spacing: 0.7px; color: var(--text-3); padding: 10px 12px 5px; }
.nav-item {
  padding: 8px 11px; border-radius: var(--radius-sm); color: var(--text-1);
  font-weight: 500; font-size: 13.5px; margin: 1px 0; position: relative; transition: all .13s ease;
}
.nav-item:hover { background: var(--bg-2); color: var(--text-0); }
.nav-item.active { background: var(--accent-light); color: var(--accent); font-weight: 600; }
.nav-item.active::before {
  content: ""; position: absolute; left: -10px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 18px; border-radius: 0 3px 3px 0; background: var(--accent);
}
.nav-icon { width: 18px; text-align: center; opacity: .85; font-size: 14px; }

/* Header / topbar */
.header {
  height: 56px; padding: 0 22px; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg-0) 80%, transparent);
  backdrop-filter: saturate(180%) blur(8px); position: sticky; top: 0; z-index: 20;
}
.header-right { display: flex; align-items: center; gap: 8px; }
.content { padding: 26px 28px; max-width: 1440px; }

/* Command palette trigger */
.cmdk-trigger {
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 12px;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text-2); font-size: 13px; cursor: pointer; min-width: 220px; transition: all .13s;
}
.cmdk-trigger:hover { border-color: var(--border-strong); background: var(--bg-2); }
.cmdk-trigger .spacer { flex: 1; }
kbd {
  font-family: var(--font-sans); font-size: 11px; font-weight: 600; color: var(--text-2);
  background: var(--bg-2); border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: 5px; padding: 1px 6px; line-height: 1.5;
}

/* Buttons */
.btn {
  height: 34px; padding: 0 14px; border-radius: var(--radius-sm); font-weight: 550; font-size: 13px;
  border: 1px solid transparent; display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  transition: all .13s ease; white-space: nowrap; line-height: 1;
}
.btn:active { transform: translateY(0.5px); }
.btn-primary { background: var(--accent); color: var(--accent-contrast); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-secondary { background: var(--bg-1); color: var(--text-0); border-color: var(--border-strong); }
.btn-secondary:hover { background: var(--bg-2); }
.btn-ghost { background: transparent; color: var(--text-1); }
.btn-ghost:hover { background: var(--bg-2); color: var(--text-0); }
.btn-icon { width: 34px; padding: 0; justify-content: center; font-size: 15px; }
.btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }
.btn-danger { background: var(--error); color: #fff; }
.btn-danger:hover { filter: brightness(1.06); }
.btn:disabled { opacity: .5; cursor: not-allowed; }

/* Cards */
.card {
  background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
}
.card-header { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.card-title { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
.card-body { padding: 18px; }

/* Stat cards */
.stat-card {
  background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 18px; position: relative; overflow: hidden; transition: background .12s, border-color .12s;
}
.stat-card:hover { background: var(--bg-1); border-color: var(--border-strong); }
.stat-label { font-size: 12px; color: var(--text-2); font-weight: 550; display: flex; align-items: center; gap: 7px; }
.stat-value { font-size: 30px; font-weight: 720; letter-spacing: -0.03em; margin-top: 7px; line-height: 1.05; }
.stat-sub { font-size: 12px; color: var(--text-3); margin-top: 4px; }
.stat-spark { position: absolute; right: 14px; bottom: 12px; opacity: .9; }

/* Page header */
.page-title { font-size: 22px; font-weight: 720; letter-spacing: -0.025em; }
.page-desc { color: var(--text-2); font-size: 13.5px; margin-top: 3px; }
.page-header { margin-bottom: 22px; }

/* Inputs */
.input, .select, .form-input {
  height: 34px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--bg-0); color: var(--text-0); font-size: 13px; font-family: inherit; transition: all .13s; width: 100%;
}
.input:focus, .select:focus, .form-input:focus, textarea:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light);
}
.input-mono { font-family: var(--font-mono); }
.form-label { font-size: 12.5px; font-weight: 600; color: var(--text-1); margin-bottom: 6px; display: block; }
textarea.input { height: auto; padding: 9px 11px; line-height: 1.5; resize: vertical; }

/* Tables */
.table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.table th {
  text-align: left; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .5px;
  color: var(--text-2); padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--bg-1);
  position: sticky; top: 0; z-index: 1; white-space: nowrap;
}
.table td { padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--text-1); vertical-align: middle; }
.table tbody tr { transition: background .1s; }
.table tbody tr:hover { background: var(--bg-1); }
.table tbody tr:last-child td { border-bottom: none; }
.table-mono td { font-family: var(--font-mono); font-size: 12px; }

/* Badges */
.badge {
  display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; line-height: 1; border: 1px solid transparent;
}
.badge-success { background: var(--success-bg); color: var(--success); }
.badge-error, .badge-delete { background: var(--error-bg); color: var(--error); }
.badge-warning, .badge-patch { background: var(--warning-bg); color: var(--warning); }
.badge-info, .badge-get { background: var(--info-bg); color: var(--info); }
.badge-neutral { background: var(--bg-2); color: var(--text-2); }
.badge-post { background: var(--success-bg); color: var(--success); }
.badge-put { background: var(--warning-bg); color: var(--warning); }
.badge-method { font-family: var(--font-mono); }
.badge-dot::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; }

/* Toasts */
.toast-container { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 1000; }
.toast {
  min-width: 260px; max-width: 420px; padding: 12px 14px; border-radius: var(--radius);
  background: var(--bg-0); color: var(--text-0); border: 1px solid var(--border); box-shadow: var(--shadow-lg);
  display: flex; align-items: flex-start; gap: 10px; font-size: 13px; animation: toastIn .22s cubic-bezier(.2,.8,.2,1);
  border-left: 3px solid var(--text-3);
}
.toast-success { border-left-color: var(--success); }
.toast-error { border-left-color: var(--error); }
.toast-info { border-left-color: var(--info); }
@keyframes toastIn { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }

/* Modal / drawer / command palette overlay */
.overlay {
  position: fixed; inset: 0; background: rgba(15,23,42,.45); backdrop-filter: blur(2px);
  z-index: 900; display: flex; opacity: 0; pointer-events: none; transition: opacity .15s;
}
.overlay.open { opacity: 1; pointer-events: auto; }

.drawer {
  margin-left: auto; width: min(560px, 100%); height: 100%; background: var(--bg-0);
  border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); display: flex; flex-direction: column;
  transform: translateX(100%); transition: transform .22s cubic-bezier(.2,.8,.2,1);
}
.overlay.open .drawer { transform: none; }
.drawer-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.drawer-title { font-size: 15px; font-weight: 650; }
.drawer-body { padding: 20px; overflow-y: auto; flex: 1; }
.drawer-footer { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; }

/* Command palette */
.cmdk { margin: 12vh auto auto; width: min(620px, 92%); height: max-content; max-height: 60vh; align-self: flex-start; }
.cmdk-box { background: var(--bg-0); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); overflow: hidden; display: flex; flex-direction: column; }
.cmdk-input { height: 52px; border: none; border-bottom: 1px solid var(--border); border-radius: 0; font-size: 15px; padding: 0 18px; }
.cmdk-input:focus { box-shadow: none; }
.cmdk-list { overflow-y: auto; padding: 8px; max-height: 46vh; }
.cmdk-item { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border-radius: var(--radius-sm); cursor: pointer; color: var(--text-1); font-size: 13.5px; }
.cmdk-item .cmdk-ico { width: 18px; text-align: center; opacity: .7; }
.cmdk-item .cmdk-hint { margin-left: auto; font-size: 11px; color: var(--text-3); }
.cmdk-item.active { background: var(--accent-light); color: var(--accent); }
.cmdk-group { font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .6px; color: var(--text-3); padding: 10px 12px 4px; }

/* Data grid (Data Explorer) */
.dx { display: flex; flex-direction: column; gap: 14px; }
.dx-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dx-resource-select { min-width: 220px; }
.dx-spacer { flex: 1; }
.dx-grid-wrap { border: 1px solid var(--border); border-radius: var(--radius); overflow: auto; background: var(--bg-0); max-height: calc(100vh - 300px); }
.dx-grid { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.dx-grid th { position: sticky; top: 0; z-index: 2; background: var(--bg-1); padding: 9px 13px; text-align: left; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .4px; color: var(--text-2); border-bottom: 1px solid var(--border); white-space: nowrap; cursor: pointer; user-select: none; }
.dx-grid th:hover { color: var(--text-0); }
.dx-grid th .sort { opacity: .4; margin-left: 4px; font-size: 10px; }
.dx-grid th.sorted .sort { opacity: 1; color: var(--accent); }
.dx-grid td { padding: 9px 13px; border-bottom: 1px solid var(--border); color: var(--text-1); max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dx-grid tbody tr { cursor: pointer; transition: background .08s; }
.dx-grid tbody tr:hover { background: var(--bg-1); }
.dx-grid .cell-null { color: var(--text-3); font-style: italic; }
.dx-grid .cell-bool { font-family: var(--font-mono); }
.dx-grid .cell-json { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.dx-grid .pk { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); }
.dx-rowactions { display: flex; gap: 4px; opacity: 0; }
.dx-grid tr:hover .dx-rowactions { opacity: 1; }

/* Filter builder */
.dx-filters { display: flex; flex-direction: column; gap: 8px; padding: 14px; background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius); }
.dx-filter-row { display: flex; gap: 8px; align-items: center; }
.dx-filter-row .input, .dx-filter-row .select { height: 30px; }
.dx-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 10px; background: var(--accent-light); color: var(--accent); border-radius: 999px; font-size: 12px; font-weight: 550; }
.dx-chip button { border: none; background: none; color: inherit; cursor: pointer; font-size: 13px; opacity: .7; }
.dx-chip button:hover { opacity: 1; }

/* Segmented control */
.segmented { display: inline-flex; background: var(--bg-2); border-radius: var(--radius-sm); padding: 2px; gap: 2px; }
.segmented button { border: none; background: none; height: 28px; padding: 0 11px; border-radius: 5px; font-size: 12.5px; font-weight: 550; color: var(--text-2); cursor: pointer; }
.segmented button.active { background: var(--bg-0); color: var(--text-0); box-shadow: var(--shadow-sm); }

/* Switch */
.switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .track { position: absolute; inset: 0; background: var(--bg-3); border-radius: 999px; transition: .15s; }
.switch .track::before { content: ""; position: absolute; height: 14px; width: 14px; left: 3px; top: 3px; background: #fff; border-radius: 999px; transition: .15s; box-shadow: var(--shadow-sm); }
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track::before { transform: translateX(16px); }

/* Skeleton + spinner */
.skeleton { background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-3) 37%, var(--bg-2) 63%); background-size: 400% 100%; animation: shimmer 1.3s infinite; border-radius: 6px; }
@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 999px; animation: spin .7s linear infinite; display: inline-block; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Empty state */
.empty-state { padding: 56px 20px; text-align: center; }
.empty-icon { font-size: 30px; opacity: .35; }
.empty-title { font-weight: 650; margin-top: 10px; font-size: 15px; }
.empty-desc { color: var(--text-2); font-size: 13px; margin-top: 4px; }

/* JSON viewer */
.jsonview { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.jsonview .k { color: var(--accent); }
.jsonview .s { color: var(--success); }
.jsonview .n { color: var(--warning); }
.jsonview .b { color: var(--error); }

/* Pagination footer */
.dx-foot { display: flex; align-items: center; gap: 12px; color: var(--text-2); font-size: 12.5px; }

/* Copy button */
.copy-btn { cursor: pointer; color: var(--text-3); border: none; background: none; font-size: 12px; padding: 2px 5px; border-radius: 5px; }
.copy-btn:hover { color: var(--accent); background: var(--bg-2); }

/* Misc */
.muted { color: var(--text-2); }
.mono { font-family: var(--font-mono); }
.row { display: flex; align-items: center; gap: 10px; }
.tag-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }

/* Data Explorer — advanced features */
.dx-search { min-width: 200px; flex: 1; max-width: 320px; }
.dx-check { width: 36px; text-align: center !important; cursor: default; }
.dx-check input { cursor: pointer; vertical-align: middle; }
.dx-grid tbody tr.selected { background: var(--accent-light) !important; }
.dx-grid.compact th { padding: 5px 11px; }
.dx-grid.compact td { padding: 4px 11px; }
.dx-bulkbar {
  display: flex; align-items: center; gap: 12px; padding: 9px 14px; border-radius: var(--radius);
  background: var(--accent-light); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  font-size: 13px; font-weight: 550;
}

/* Popover menu (columns / views / export) */
.dx-pop-wrap { position: relative; }
.dx-pop {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 40; min-width: 220px; max-height: 360px; overflow-y: auto;
  background: var(--bg-0); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow-lg); padding: 6px;
}
.dx-pop-item { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; color: var(--text-1); }
.dx-pop-item:hover { background: var(--bg-1); }
.dx-pop-sep { height: 1px; background: var(--border); margin: 5px 4px; }
.dx-pop-title { font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .5px; color: var(--text-3); padding: 8px 9px 4px; }

/* Inline cell editing */
.dx-grid td.editing { padding: 2px 6px; }
.dx-cell-edit { width: 100%; height: 28px; border: 1px solid var(--accent); border-radius: 5px; padding: 0 7px; font: inherit; font-family: var(--font-mono); font-size: 12px; background: var(--bg-0); color: var(--text-0); box-shadow: 0 0 0 3px var(--accent-light); }
.dx-editable { position: relative; }
.dx-editable::after { content: "✎"; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); opacity: 0; font-size: 10px; color: var(--text-3); }
.dx-grid tbody tr:hover .dx-editable::after { opacity: .5; }

/* Charts (inline SVG) */
.chart-bars { display: flex; align-items: flex-end; gap: 3px; height: 60px; }
.chart-bar { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; opacity: .85; transition: opacity .1s; }
.chart-bar:hover { opacity: 1; }
.dist-row { display: flex; align-items: center; gap: 10px; margin: 7px 0; font-size: 13px; }
.dist-track { flex: 1; height: 8px; background: var(--bg-2); border-radius: 999px; overflow: hidden; }
.dist-fill { height: 100%; border-radius: 999px; }

/* SVG icons */
svg.ico { display: block; flex-shrink: 0; }
.nav-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; }
.nav-icon svg { width: 17px; height: 17px; }
.cmdk-ico { display: inline-flex; align-items: center; justify-content: center; }
.stat-label svg { width: 15px; height: 15px; }
.cmdk-trigger svg { width: 15px; height: 15px; }
`;
