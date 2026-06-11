import { html, escapeHtml, formatDuration, formatRelativeTime } from '../utils';
import { card, statCard, badge, methodBadge, statusBadge, emptyState } from '../components';

export interface DashboardPageData {
  stats: {
    resources: number;
    requests: number;
    errors: number;
    subscriptions: number;
    changelog: number;
  };
  recentRequests: Array<{
    id: string;
    method: string;
    path: string;
    status: number;
    duration: number;
    timestamp: string;
  }>;
  mode: string;
}

export const dashboardPage = (data: DashboardPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Dashboard</h1>
    <p class="page-desc">Overview of your API resources and activity</p>
  </div>

  <div class="grid grid-5">
    ${statCard('Resources', data.stats.resources, 'info')}
    ${statCard('Requests', data.stats.requests, 'success')}
    ${statCard('Errors', data.stats.errors, data.stats.errors > 0 ? 'error' : 'neutral')}
    ${statCard('Subscriptions', data.stats.subscriptions, 'info')}
    ${statCard('Changelog', data.stats.changelog, 'neutral')}
  </div>

  <div style="margin-top: 16px;">
    ${card({ title: 'Recent Requests', headerRight: badge(data.recentRequests.length, 'neutral'), flush: true }, html`
      ${data.recentRequests.length > 0 ? html`
        <div style="max-height: 400px; overflow-y: auto;">
          ${data.recentRequests.map(req => html`
            <div class="list-item" style="cursor: pointer;"
                 hx-get="/__covara/ui/requests/${req.id}"
                 hx-target="#request-detail"
                 hx-swap="innerHTML">
              <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                ${methodBadge(req.method)}
                <span class="code-inline" style="flex: 1; overflow: hidden; text-overflow: ellipsis;">
                  ${escapeHtml(req.path)}
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 12px;">
                ${statusBadge(req.status)}
                <span style="color: ${req.duration > 500 ? 'var(--error)' : req.duration > 100 ? 'var(--warning)' : 'var(--success)'}; font-size: 12px; font-family: var(--font-mono);">
                  ${formatDuration(req.duration)}
                </span>
                <span style="color: var(--text-3); font-size: 12px;">
                  ${formatRelativeTime(req.timestamp)}
                </span>
              </div>
            </div>
          `).join('')}
        </div>
      ` : emptyState('\u2192', 'No requests yet', 'Make some API calls to see them here')}
      <div id="request-detail" style="border-top: 1px solid var(--border);"></div>
    `)}
  </div>
`;
