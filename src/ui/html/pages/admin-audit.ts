import { html, escapeHtml, formatJson, formatRelativeTime } from '../utils';
import { card, badge, button, input, emptyState, toolbar } from '../components';

export interface AuditEntry {
  timestamp: number;
  userId: string;
  userEmail: string;
  operation: string;
  resource?: string;
  resourceId?: string;
  reason?: string;
  beforeValue?: Record<string, unknown>;
  afterValue?: Record<string, unknown>;
}

export interface AdminAuditPageData {
  entries: AuditEntry[];
}

export const adminAuditPage = (data: AdminAuditPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Admin Audit Log</h1>
    <p class="page-desc">Track all admin actions with bypass privileges</p>
  </div>

  ${toolbar(html`
    ${input({ name: 'operation', placeholder: 'Filter operation...' })}
    ${input({ name: 'user', placeholder: 'Filter user...' })}
    ${button('Filter', {
      variant: 'primary',
      hxGet: '/__covara/ui/audit/list',
      hxTarget: '#audit-list',
      hxInclude: '[name="operation"],[name="user"]',
    })}
    <div style="flex: 1;"></div>
    ${button('Export JSON', {
      variant: 'secondary',
      hxGet: '/__covara/api/admin-audit/export?format=json',
    })}
    ${button('Export CSV', {
      variant: 'secondary',
      hxGet: '/__covara/api/admin-audit/export?format=csv',
    })}
  `)}

  <div id="audit-list" style="margin-top: 16px;">
    ${auditList(data.entries)}
  </div>
`;

export const auditList = (entries: AuditEntry[]): string => card({
  title: 'Audit Log',
  headerRight: badge(entries.length + ' entries', 'neutral'),
  flush: true,
}, html`
  ${entries.length > 0 ? html`
    <div style="overflow-x: auto;">
      <table class="table table-mono">
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Operation</th>
            <th>Resource</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry, i) => html`
            <tr style="cursor: pointer;"
                hx-get="/__covara/ui/audit/${i}"
                hx-target="#audit-detail"
                hx-swap="innerHTML">
              <td style="white-space: nowrap;">${formatRelativeTime(entry.timestamp)}</td>
              <td>${escapeHtml(entry.userEmail)}</td>
              <td>${operationBadge(entry.operation)}</td>
              <td>
                ${entry.resource ? html`
                  <span class="code-inline">${escapeHtml(entry.resource)}</span>
                  ${entry.resourceId ? html`<span style="color: var(--text-2);">/${escapeHtml(entry.resourceId)}</span>` : ''}
                ` : '-'}
              </td>
              <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; color: var(--text-2);">
                ${escapeHtml(entry.reason || '-')}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : emptyState('\u2611', 'No audit entries', 'Admin actions will appear here')}

  <div id="audit-detail" style="border-top: 1px solid var(--border);"></div>
`);

const operationBadge = (operation: string): string => {
  if (operation.includes('create')) return badge(operation, 'success');
  if (operation.includes('update')) return badge(operation, 'info');
  if (operation.includes('delete')) return badge(operation, 'error');
  return badge(operation, 'neutral');
};

export interface AuditDetailData {
  entry: AuditEntry;
}

export const auditDetail = (data: AuditDetailData): string => html`
  <div style="padding: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h4 style="font-weight: 600;">Entry Details</h4>
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#audit-detail',
        hxSwap: 'innerHTML',
      })}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Info</h5>
        <table class="table" style="font-size: 12px;">
          <tr><td style="color: var(--text-2);">Time</td><td>${escapeHtml(new Date(data.entry.timestamp).toLocaleString())}</td></tr>
          <tr><td style="color: var(--text-2);">User</td><td>${escapeHtml(data.entry.userEmail)} (${escapeHtml(data.entry.userId)})</td></tr>
          <tr><td style="color: var(--text-2);">Operation</td><td>${operationBadge(data.entry.operation)}</td></tr>
          <tr><td style="color: var(--text-2);">Resource</td><td>${escapeHtml(data.entry.resource || '-')}</td></tr>
          <tr><td style="color: var(--text-2);">Resource ID</td><td>${escapeHtml(data.entry.resourceId || '-')}</td></tr>
          <tr><td style="color: var(--text-2);">Reason</td><td>${escapeHtml(data.entry.reason || '-')}</td></tr>
        </table>
      </div>

      <div>
        ${data.entry.beforeValue ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Before</h5>
          <div class="code" style="max-height: 150px; overflow-y: auto; margin-bottom: 16px;">
            ${escapeHtml(formatJson(data.entry.beforeValue))}
          </div>
        ` : ''}

        ${data.entry.afterValue ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">After</h5>
          <div class="code" style="max-height: 150px; overflow-y: auto;">
            ${escapeHtml(formatJson(data.entry.afterValue))}
          </div>
        ` : ''}
      </div>
    </div>
  </div>
`;
