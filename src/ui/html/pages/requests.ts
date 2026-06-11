import { html, escapeHtml, formatDuration, formatRelativeTime } from '../utils';
import { card, badge, methodBadge, statusBadge, button, input, select, emptyState, toolbar } from '../components';

export interface RequestInfo {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: string;
  error?: string;
}

export interface RequestsPageData {
  requests: RequestInfo[];
}

export const requestsPage = (data: RequestsPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Requests</h1>
    <p class="page-desc">Recent API requests and their performance</p>
  </div>

  ${toolbar(html`
    ${select({
      name: 'method',
      placeholder: 'All Methods',
      options: [
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' },
        { value: 'PATCH', label: 'PATCH' },
        { value: 'PUT', label: 'PUT' },
        { value: 'DELETE', label: 'DELETE' },
      ],
    })}
    ${select({
      name: 'status',
      placeholder: 'All Status',
      options: [
        { value: 'success', label: 'Success (2xx/3xx)' },
        { value: 'error', label: 'Error (4xx/5xx)' },
      ],
    })}
    ${input({ name: 'path', placeholder: 'Filter by path...' })}
    ${button('Filter', {
      variant: 'primary',
      hxGet: '/__covara/ui/requests/list',
      hxTarget: '#request-list',
      hxInclude: '[name="method"],[name="status"],[name="path"]',
    })}
    ${button('Clear', {
      variant: 'secondary',
      hxGet: '/__covara/ui/requests/list',
      hxTarget: '#request-list',
    })}
  `)}

  <div id="request-list" style="margin-top: 16px;">
    ${requestList(data.requests)}
  </div>
`;

export const requestList = (requests: RequestInfo[]): string => card({
  title: 'Recent Requests',
  headerRight: badge(requests.length + ' requests', 'neutral'),
  flush: true,
}, html`
  ${requests.length > 0 ? html`
    <div style="max-height: 600px; overflow-y: auto;">
      ${requests.map(req => html`
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
`);

export interface RequestDetailData {
  request: RequestInfo & {
    headers?: Record<string, string>;
    body?: unknown;
    response?: unknown;
  };
}

export const requestDetail = (data: RequestDetailData): string => html`
  <div style="padding: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h4 style="font-weight: 600;">Request Details</h4>
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#request-detail',
        hxSwap: 'innerHTML',
      })}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Request</h5>
        <div class="code">${escapeHtml(data.request.method + ' ' + data.request.path)}</div>
        ${data.request.headers ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin: 12px 0 8px;">Headers</h5>
          <div class="code">${escapeHtml(JSON.stringify(data.request.headers, null, 2))}</div>
        ` : ''}
        ${data.request.body ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin: 12px 0 8px;">Body</h5>
          <div class="code">${escapeHtml(JSON.stringify(data.request.body, null, 2))}</div>
        ` : ''}
      </div>
      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Response</h5>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          ${statusBadge(data.request.status)}
          <span style="font-size: 12px; color: var(--text-2);">${formatDuration(data.request.duration)}</span>
        </div>
        ${data.request.response ? html`
          <div class="code" style="max-height: 300px; overflow-y: auto;">
            ${escapeHtml(JSON.stringify(data.request.response, null, 2))}
          </div>
        ` : ''}
        ${data.request.error ? html`
          <div class="alert alert-error" style="margin-top: 8px;">
            ${escapeHtml(data.request.error)}
          </div>
        ` : ''}
      </div>
    </div>
  </div>
`;
