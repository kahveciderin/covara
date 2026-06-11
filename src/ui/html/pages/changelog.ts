import { html, escapeHtml, formatRelativeTime, formatJson } from '../utils';
import { card, badge, button, input, emptyState, toolbar, statCard, grid } from '../components';

export interface ChangelogEntry {
  seq: number;
  resource: string;
  operation: 'create' | 'update' | 'delete';
  recordId: string;
  timestamp: string;
  userId?: string;
  before?: unknown;
  after?: unknown;
}

export interface ChangelogPageData {
  entries: ChangelogEntry[];
  stats: {
    total: number;
    creates: number;
    updates: number;
    deletes: number;
    currentSeq: number;
  };
}

export const changelogPage = (data: ChangelogPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Changelog</h1>
    <p class="page-desc">Track all data mutations for subscriptions</p>
  </div>

  ${grid([
    statCard('Total', data.stats.total, 'neutral'),
    statCard('Creates', data.stats.creates, 'success'),
    statCard('Updates', data.stats.updates, 'info'),
    statCard('Deletes', data.stats.deletes, 'error'),
    statCard('Current Seq', data.stats.currentSeq, 'neutral'),
  ])}

  ${toolbar(html`
    ${input({ name: 'resource', placeholder: 'Filter by resource...' })}
    ${input({ name: 'fromSeq', placeholder: 'From seq...', type: 'number' })}
    ${button('Filter', {
      variant: 'primary',
      hxGet: '/__covara/ui/changelog/list',
      hxTarget: '#changelog-list',
      hxInclude: '[name="resource"],[name="fromSeq"]',
    })}
    ${button('Clear', {
      variant: 'secondary',
      hxGet: '/__covara/ui/changelog/list',
      hxTarget: '#changelog-list',
    })}
    <div style="flex: 1;"></div>
    ${badge('seq: ' + data.stats.currentSeq, 'info')}
  `)}

  <div id="changelog-list" style="margin-top: 16px;">
    ${changelogList(data.entries)}
  </div>
`;

export const changelogList = (entries: ChangelogEntry[]): string => card({
  title: 'Recent Changes',
  headerRight: badge(entries.length + ' entries', 'neutral'),
  flush: true,
}, html`
  ${entries.length > 0 ? html`
    <div style="max-height: 600px; overflow-y: auto;">
      ${entries.map(entry => html`
        <div class="list-item" style="cursor: pointer;"
             hx-get="/__covara/ui/changelog/${entry.seq}"
             hx-target="#changelog-detail"
             hx-swap="innerHTML">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            ${badge('#' + entry.seq, 'neutral')}
            ${operationBadge(entry.operation)}
            <span class="code-inline">${escapeHtml(entry.resource)}</span>
            <span style="color: var(--text-2);">/ ${escapeHtml(entry.recordId)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${entry.userId ? html`
              <span style="color: var(--text-3); font-size: 11px;">${escapeHtml(entry.userId.slice(0, 8))}...</span>
            ` : ''}
            <span style="color: var(--text-3); font-size: 12px;">${formatRelativeTime(entry.timestamp)}</span>
          </div>
        </div>
      `).join('')}
    </div>
  ` : emptyState('\u270E', 'No changelog entries', 'Changes will appear here when data is modified')}

  <div id="changelog-detail" style="border-top: 1px solid var(--border);"></div>
`);

const operationBadge = (operation: string): string => {
  switch (operation) {
    case 'create': return badge('CREATE', 'success');
    case 'update': return badge('UPDATE', 'info');
    case 'delete': return badge('DELETE', 'error');
    default: return badge(operation, 'neutral');
  }
};

export interface ChangelogDetailData {
  entry: ChangelogEntry;
}

export const changelogDetail = (data: ChangelogDetailData): string => html`
  <div style="padding: 16px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <h4 style="font-weight: 600;">Change #${data.entry.seq}</h4>
        ${operationBadge(data.entry.operation)}
      </div>
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#changelog-detail',
        hxSwap: 'innerHTML',
      })}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Info</h5>
        <table class="table" style="font-size: 12px;">
          <tr><td style="color: var(--text-2);">Sequence</td><td>#${data.entry.seq}</td></tr>
          <tr><td style="color: var(--text-2);">Resource</td><td class="code-inline">${escapeHtml(data.entry.resource)}</td></tr>
          <tr><td style="color: var(--text-2);">Record ID</td><td class="code-inline">${escapeHtml(data.entry.recordId)}</td></tr>
          <tr><td style="color: var(--text-2);">Operation</td><td>${operationBadge(data.entry.operation)}</td></tr>
          <tr><td style="color: var(--text-2);">Time</td><td>${escapeHtml(new Date(data.entry.timestamp).toLocaleString())}</td></tr>
          <tr><td style="color: var(--text-2);">User ID</td><td>${data.entry.userId ? html`<span class="code-inline">${escapeHtml(data.entry.userId)}</span>` : '-'}</td></tr>
        </table>
      </div>

      <div>
        ${data.entry.before ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Before</h5>
          <div class="code" style="max-height: 150px; overflow-y: auto; margin-bottom: 16px; background: var(--error-bg);">
            ${escapeHtml(formatJson(data.entry.before))}
          </div>
        ` : ''}

        ${data.entry.after ? html`
          <h5 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">After</h5>
          <div class="code" style="max-height: 150px; overflow-y: auto; background: var(--success-bg);">
            ${escapeHtml(formatJson(data.entry.after))}
          </div>
        ` : ''}

        ${!data.entry.before && !data.entry.after ? html`
          <p style="color: var(--text-3); font-size: 12px;">No data changes recorded</p>
        ` : ''}
      </div>
    </div>
  </div>
`;
