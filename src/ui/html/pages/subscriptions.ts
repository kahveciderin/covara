import { html, escapeHtml, formatRelativeTime } from '../utils';
import { card, badge, button, emptyState, statCard, grid } from '../components';

export interface SubscriptionInfo {
  id: string;
  resource: string;
  filter?: string;
  userId?: string;
  userEmail?: string;
  connectedAt: string;
  lastEventAt?: string;
  eventCount: number;
  lastSeq?: number;
}

export interface SubscriptionsPageData {
  subscriptions: SubscriptionInfo[];
  stats: {
    active: number;
    totalEvents: number;
    byResource: Record<string, number>;
  };
}

export const subscriptionsPage = (data: SubscriptionsPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Subscriptions</h1>
    <p class="page-desc">Active SSE subscriptions and their status</p>
  </div>

  ${grid([
    statCard('Active', data.stats.active, 'success'),
    statCard('Total Events', data.stats.totalEvents, 'info'),
    ...Object.entries(data.stats.byResource).slice(0, 3).map(([resource, count]) =>
      statCard(resource, count, 'neutral')
    ),
  ])}

  <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
    ${button('Refresh', {
      variant: 'secondary',
      hxGet: '/__covara/ui/subscriptions/list',
      hxTarget: '#subscriptions-list',
    })}
  </div>

  <div id="subscriptions-list" style="margin-top: 16px;">
    ${subscriptionsList(data.subscriptions)}
  </div>
`;

export const subscriptionsList = (subscriptions: SubscriptionInfo[]): string => card({
  title: 'Active Subscriptions',
  headerRight: badge(subscriptions.length + ' active', 'success'),
  flush: true,
}, html`
  ${subscriptions.length > 0 ? html`
    <div style="overflow-x: auto;">
      <table class="table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Filter</th>
            <th>User</th>
            <th>Connected</th>
            <th>Events</th>
            <th>Last Event</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${subscriptions.map(sub => html`
            <tr>
              <td>
                <span class="code-inline">${escapeHtml(sub.resource)}</span>
              </td>
              <td style="max-width: 200px;">
                ${sub.filter
                  ? html`<span class="code-inline" style="font-size: 11px; word-break: break-all;">${escapeHtml(sub.filter)}</span>`
                  : html`<span style="color: var(--text-3);">-</span>`}
              </td>
              <td>
                ${sub.userEmail
                  ? html`<span style="font-size: 12px;">${escapeHtml(sub.userEmail)}</span>`
                  : sub.userId
                    ? html`<span class="code-inline" style="font-size: 10px;">${escapeHtml(sub.userId.slice(0, 12))}...</span>`
                    : html`<span style="color: var(--text-3);">Anonymous</span>`}
              </td>
              <td style="color: var(--text-2); font-size: 12px; white-space: nowrap;">
                ${sub.connectedAt ? formatRelativeTime(sub.connectedAt) : '-'}
              </td>
              <td>
                ${badge(String(sub.eventCount ?? 0), 'info')}
              </td>
              <td style="color: var(--text-2); font-size: 12px; white-space: nowrap;">
                ${sub.lastEventAt ? formatRelativeTime(sub.lastEventAt) : '-'}
              </td>
              <td>
                ${button('Disconnect', {
                  size: 'sm',
                  variant: 'secondary',
                  class: 'btn-danger',
                  hxDelete: '/__covara/api/subscriptions/' + sub.id,
                  hxConfirm: 'Disconnect this subscription?',
                  hxTarget: 'closest tr',
                  hxSwap: 'outerHTML',
                })}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : emptyState('\u26A1', 'No active subscriptions', 'Subscriptions will appear when clients connect')}
`);

export interface SubscriptionEventsData {
  subscription: SubscriptionInfo;
  events: {
    seq: number;
    type: string;
    timestamp: string;
    data?: unknown;
  }[];
}

export const subscriptionEvents = (data: SubscriptionEventsData): string => card({
  title: 'Recent Events',
  headerRight: html`
    <div style="display: flex; gap: 8px; align-items: center;">
      ${badge(data.events.length + ' events', 'neutral')}
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#subscription-events',
        hxSwap: 'innerHTML',
      })}
    </div>
  `,
  flush: true,
}, html`
  ${data.events.length > 0 ? html`
    <div style="max-height: 300px; overflow-y: auto;">
      ${data.events.map(event => html`
        <div class="list-item" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
            ${eventTypeBadge(event.type)}
            <span style="color: var(--text-2); font-size: 11px;">seq: ${event.seq}</span>
            <span style="flex: 1;"></span>
            <span style="color: var(--text-3); font-size: 11px;">${formatRelativeTime(event.timestamp)}</span>
          </div>
          ${event.data ? html`
            <div class="code" style="font-size: 10px; width: 100%; max-height: 80px; overflow-y: auto;">
              ${escapeHtml(JSON.stringify(event.data, null, 2))}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  ` : html`<p style="color: var(--text-3); text-align: center; padding: 20px;">No events yet</p>`}
`);

const eventTypeBadge = (type: string): string => {
  switch (type) {
    case 'existing': return badge('existing', 'neutral');
    case 'added': return badge('added', 'success');
    case 'changed': return badge('changed', 'info');
    case 'removed': return badge('removed', 'error');
    case 'invalidate': return badge('invalidate', 'warning');
    default: return badge(type, 'neutral');
  }
};
