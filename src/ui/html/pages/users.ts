import { html, escapeHtml, formatRelativeTime } from '../utils';
import { card, badge, button, input, emptyState, toolbar } from '../components';

export interface UserInfo {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  createdAt?: string;
  lastLoginAt?: string;
  roles?: string[];
}

export interface UsersPageData {
  users: UserInfo[];
  totalCount: number;
}

export const usersPage = (data: UsersPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Users</h1>
    <p class="page-desc">Manage user accounts and permissions</p>
  </div>

  ${toolbar(html`
    ${input({ name: 'search', placeholder: 'Search by email or name...' })}
    ${button('Search', {
      variant: 'primary',
      hxGet: '/__covara/ui/users/list',
      hxTarget: '#users-list',
      hxInclude: '[name="search"]',
    })}
    <div style="flex: 1;"></div>
    ${button('+ Create User', {
      variant: 'secondary',
      hxGet: '/__covara/ui/users/new',
      hxTarget: '#modal-container',
    })}
    ${badge(data.totalCount + ' total', 'neutral')}
  `)}

  <div id="modal-container"></div>

  <div id="users-list" style="margin-top: 16px;">
    ${usersList(data.users)}
  </div>
`;

export const usersList = (users: UserInfo[]): string => card({
  title: 'Users',
  headerRight: badge(users.length + ' shown', 'neutral'),
  flush: true,
}, html`
  ${users.length > 0 ? html`
    <div style="overflow-x: auto;">
      <table class="table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Verified</th>
            <th>Roles</th>
            <th>Created</th>
            <th>Last Login</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${users.map(user => html`
            <tr>
              <td>
                <span class="code-inline">${escapeHtml(user.email)}</span>
              </td>
              <td>${escapeHtml(user.name || '-')}</td>
              <td>
                ${user.emailVerified
                  ? badge('\u2713', 'success')
                  : badge('\u2717', 'neutral')}
              </td>
              <td>
                <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                  ${user.roles && user.roles.length > 0
                    ? user.roles.map(role => badge(role, 'info')).join('')
                    : html`<span style="color: var(--text-3);">-</span>`}
                </div>
              </td>
              <td style="color: var(--text-2); font-size: 12px;">
                ${user.createdAt ? formatRelativeTime(user.createdAt) : '-'}
              </td>
              <td style="color: var(--text-2); font-size: 12px;">
                ${user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : '-'}
              </td>
              <td>
                ${button('View', {
                  size: 'sm',
                  variant: 'secondary',
                  hxGet: '/__covara/ui/users/' + user.id,
                  hxTarget: '#user-detail',
                  hxSwap: 'innerHTML',
                })}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : emptyState('\u263A', 'No users found', 'Users will appear here once they sign up')}

  <div id="user-detail" style="border-top: 1px solid var(--border);"></div>
`);

export interface UserDetailData {
  user: UserInfo & {
    metadata?: Record<string, unknown>;
    sessions?: { id: string; createdAt: string; lastActiveAt: string; userAgent?: string }[];
  };
}

export const userForm = (): string => html`
  <div class="modal-backdrop" onclick="this.remove()">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <span class="modal-title">Create User</span>
        ${button('\u00D7', { size: 'sm', variant: 'ghost', class: 'modal-close' })}
      </div>
      <form hx-post="/__covara/api/users"
            hx-target="#users-list"
            hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) { document.querySelector('.modal-backdrop')?.remove(); showToast('User created'); htmx.ajax('GET', '/__covara/ui/users/list', {target: '#users-list'}); }">
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Email *</label>
            <input class="input form-input" name="email" type="email" required />
          </div>
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="input form-input" name="name" />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input class="input form-input" name="password" type="password" placeholder="Leave empty for no password" />
          </div>
        </div>
        <div class="modal-footer">
          ${button('Cancel', { variant: 'secondary', class: 'modal-close' })}
          ${button('Create', { variant: 'primary', type: 'submit' })}
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

export const userDetail = (data: UserDetailData): string => html`
  <div style="padding: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h4 style="font-weight: 600;">User Details</h4>
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#user-detail',
        hxSwap: 'innerHTML',
      })}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Info</h5>
        <table class="table" style="font-size: 12px;">
          <tr><td style="color: var(--text-2);">ID</td><td class="code-inline">${escapeHtml(data.user.id)}</td></tr>
          <tr><td style="color: var(--text-2);">Email</td><td>${escapeHtml(data.user.email)}</td></tr>
          <tr><td style="color: var(--text-2);">Name</td><td>${escapeHtml(data.user.name || '-')}</td></tr>
          <tr><td style="color: var(--text-2);">Verified</td><td>${data.user.emailVerified ? badge('\u2713 Yes', 'success') : badge('\u2717 No', 'neutral')}</td></tr>
          <tr><td style="color: var(--text-2);">Roles</td><td>${data.user.roles?.join(', ') || '-'}</td></tr>
        </table>
      </div>

      <div>
        ${data.user.sessions && data.user.sessions.length > 0 ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Active Sessions (${data.user.sessions.length})</h5>
          <div style="max-height: 200px; overflow-y: auto;">
            ${data.user.sessions.map(session => html`
              <div class="list-item" style="padding: 8px; font-size: 12px;">
                <div style="flex: 1;">
                  <div class="code-inline" style="font-size: 10px; margin-bottom: 4px;">${escapeHtml((session.id ?? '').slice(0, 16))}...</div>
                  <div style="color: var(--text-2);">${escapeHtml(session.userAgent || 'Unknown')}</div>
                </div>
                <div style="text-align: right; color: var(--text-3); font-size: 11px;">
                  <div>Created: ${formatRelativeTime(session.createdAt)}</div>
                  <div>Active: ${formatRelativeTime(session.lastActiveAt)}</div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : html`
          <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Active Sessions</h5>
          <p style="color: var(--text-3); font-size: 12px;">No active sessions</p>
        `}
      </div>
    </div>

    ${data.user.metadata ? html`
      <div style="margin-top: 16px;">
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Metadata</h5>
        <div class="code" style="max-height: 150px; overflow-y: auto;">
          ${escapeHtml(JSON.stringify(data.user.metadata, null, 2))}
        </div>
      </div>
    ` : ''}
  </div>
`;
