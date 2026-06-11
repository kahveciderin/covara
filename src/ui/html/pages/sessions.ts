import { html, escapeHtml, formatRelativeTime } from '../utils';
import { card, badge, button, emptyState, select } from '../components';

export interface SessionInfo {
  id: string;
  userId: string;
  userEmail?: string;
  createdAt: string;
  expiresAt: string;
  lastActiveAt?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface SessionsPageData {
  sessions: SessionInfo[];
  totalCount: number;
}

export const sessionsPage = (data: SessionsPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Sessions</h1>
    <p class="page-desc">Active user sessions and their details</p>
  </div>

  <div style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
    <div style="display: flex; gap: 8px; align-items: center;">
      ${badge(data.totalCount + ' active sessions', 'info')}
    </div>
    <div style="display: flex; gap: 8px;">
      ${button('+ Mint Session', {
        variant: 'secondary',
        hxGet: '/__covara/ui/sessions/new',
        hxTarget: '#modal-container',
      })}
      ${button('Refresh', {
        variant: 'secondary',
        hxGet: '/__covara/ui/sessions/list',
        hxTarget: '#sessions-list',
      })}
    </div>
  </div>

  <div id="modal-container"></div>

  <div id="sessions-list">
    ${sessionsList(data.sessions)}
  </div>
`;

export const sessionsList = (sessions: SessionInfo[]): string => card({
  title: 'Active Sessions',
  headerRight: badge(sessions.length + ' sessions', 'neutral'),
  flush: true,
}, html`
  ${sessions.length > 0 ? html`
    <div style="overflow-x: auto;">
      <table class="table">
        <thead>
          <tr>
            <th>Session ID</th>
            <th>User</th>
            <th>Created</th>
            <th>Expires</th>
            <th>Last Active</th>
            <th>IP</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map(session => html`
            <tr>
              <td>
                <span class="code-inline" style="font-size: 11px;">
                  ${escapeHtml(session.id.slice(0, 16))}...
                </span>
              </td>
              <td>
                ${session.userEmail
                  ? html`<span style="font-size: 13px;">${escapeHtml(session.userEmail)}</span>`
                  : html`<span class="code-inline" style="font-size: 11px;">${escapeHtml(session.userId.slice(0, 12))}...</span>`}
              </td>
              <td style="color: var(--text-2); font-size: 12px; white-space: nowrap;">
                ${formatRelativeTime(session.createdAt)}
              </td>
              <td style="font-size: 12px; white-space: nowrap;">
                ${isExpiringSoon(session.expiresAt)
                  ? badge(formatRelativeTime(session.expiresAt), 'warning')
                  : html`<span style="color: var(--text-2);">${formatRelativeTime(session.expiresAt)}</span>`}
              </td>
              <td style="color: var(--text-2); font-size: 12px; white-space: nowrap;">
                ${session.lastActiveAt ? formatRelativeTime(session.lastActiveAt) : '-'}
              </td>
              <td style="font-size: 12px;">
                ${session.ipAddress
                  ? html`<span class="code-inline">${escapeHtml(session.ipAddress)}</span>`
                  : '-'}
              </td>
              <td>
                ${button('Revoke', {
                  size: 'sm',
                  variant: 'secondary',
                  class: 'btn-danger',
                  hxDelete: '/__covara/api/sessions/' + session.id,
                  hxConfirm: 'Revoke this session? The user will be logged out.',
                  hxTarget: 'closest tr',
                  hxSwap: 'outerHTML',
                })}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <style>.btn-danger { color: var(--error); } .btn-danger:hover { background: var(--error-bg); }</style>
  ` : emptyState('\u26A1', 'No active sessions', 'Sessions will appear here when users log in')}
`);

const isExpiringSoon = (expiresAt: string): boolean => {
  const expiry = new Date(expiresAt).getTime();
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  return expiry - now < oneHour && expiry > now;
};

export interface SessionFormData {
  users: { id: string; email: string }[];
}

export const sessionForm = (data: SessionFormData): string => html`
  <div class="modal-backdrop" onclick="this.remove()">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <span class="modal-title">Mint Session</span>
        ${button('\u00D7', { size: 'sm', variant: 'ghost', class: 'modal-close' })}
      </div>
      <form hx-post="/__covara/api/sessions"
            hx-target="#sessions-list"
            hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) { document.querySelector('.modal-backdrop')?.remove(); showToast('Session created'); htmx.ajax('GET', '/__covara/ui/sessions/list', {target: '#sessions-list'}); }">
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">User *</label>
            ${data.users.length > 0 ? select({
              name: 'userId',
              options: data.users.map(u => ({ value: u.id, label: u.email })),
              placeholder: 'Select a user...',
            }) : html`
              <input class="input form-input" name="userId" placeholder="Enter user ID" required />
              <p style="font-size: 11px; color: var(--text-3); margin-top: 4px;">No user manager configured. Enter user ID manually.</p>
            `}
          </div>
          <div class="form-group">
            <label class="form-label">Expires In</label>
            ${select({
              name: 'expiresIn',
              value: '86400',
              options: [
                { value: '3600', label: '1 hour' },
                { value: '86400', label: '1 day' },
                { value: '604800', label: '7 days' },
                { value: '2592000', label: '30 days' },
              ],
            })}
          </div>
        </div>
        <div class="modal-footer">
          ${button('Cancel', { variant: 'secondary', class: 'modal-close' })}
          ${button('Mint Session', { variant: 'primary', type: 'submit' })}
        </div>
      </form>
    </div>
  </div>

  <script>
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => document.querySelector('.modal-backdrop')?.remove());
    });
  </script>
`;
