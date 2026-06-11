import { html, escapeHtml, formatJson } from '../utils';
import { card, badge, button, input, select, alert, emptyState, toolbar, tableHead } from '../components';

export interface SchemaInfo {
  name: string;
  columns: Array<{
    name: string;
    type: string;
    isPrimary: boolean;
    isNullable: boolean;
    isGenerated: boolean;
  }>;
  primaryKey: string;
}

export interface DataExplorerPageData {
  resources: string[];
  mode: string;
  readOnly: boolean;
}

export const dataExplorerPage = (data: DataExplorerPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Data Explorer</h1>
    <p class="page-desc">Browse and edit resource data with admin bypass</p>
  </div>

  ${alert('\u26A0 Admin bypass active - All scopes bypassed, actions are logged', 'warning')}

  <div style="margin-top: 16px;">
    ${toolbar(html`
      ${select({
        name: 'resource',
        placeholder: 'Select resource...',
        options: data.resources.map(r => ({ value: r, label: r })),
        class: 'resource-select',
      })}
      ${input({
        name: 'filter',
        placeholder: 'Filter: status=="active"',
        mono: true,
        class: 'filter-input',
      })}
      ${select({
        name: 'limit',
        value: '50',
        options: [
          { value: '20', label: '20' },
          { value: '50', label: '50' },
          { value: '100', label: '100' },
        ],
      })}
      ${button('Search', {
        variant: 'primary',
        class: 'search-btn',
      })}
      <span id="search-indicator" class="htmx-indicator loading"></span>
      ${!data.readOnly ? button('+ New Record', {
        variant: 'secondary',
        hxGet: '/__concave/ui/data/new',
        hxTarget: '#modal-container',
      }) : ''}
    `)}
  </div>

  <div id="data-table" style="margin-top: 16px;">
    ${card({}, emptyState('\u2637', 'Select a resource', 'Choose a resource from the dropdown to explore data'))}
  </div>

  <div id="modal-container"></div>

  <script>
    // Strip leading slashes from resource path
    function normalizeResource(r) {
      return r.replace(/^\\/+/, '');
    }

    // Handle resource selection
    document.querySelector('.resource-select')?.addEventListener('change', function(e) {
      const resource = normalizeResource(e.target.value);
      if (!resource) return;

      const filter = document.querySelector('.filter-input')?.value || '';
      const limit = document.querySelector('[name="limit"]')?.value || '50';

      htmx.ajax('GET', '/__concave/ui/data/' + encodeURIComponent(resource) + '/table?limit=' + limit + (filter ? '&filter=' + encodeURIComponent(filter) : ''), {
        target: '#data-table',
        swap: 'innerHTML'
      });
    });

    // Handle search button
    document.querySelector('.search-btn')?.addEventListener('click', function(e) {
      e.preventDefault();
      const resource = normalizeResource(document.querySelector('.resource-select')?.value || '');
      if (!resource) {
        showToast('Please select a resource first', 'error');
        return;
      }

      const filter = document.querySelector('.filter-input')?.value || '';
      const limit = document.querySelector('[name="limit"]')?.value || '50';

      htmx.ajax('GET', '/__concave/ui/data/' + encodeURIComponent(resource) + '/table?limit=' + limit + (filter ? '&filter=' + encodeURIComponent(filter) : ''), {
        target: '#data-table',
        swap: 'innerHTML'
      });
    });

    // Handle enter key in filter input
    document.querySelector('.filter-input')?.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        document.querySelector('.search-btn')?.click();
      }
    });
  </script>
`;

export interface DataTableData {
  resource: string;
  schema: SchemaInfo;
  items: Record<string, unknown>[];
  totalCount?: number;
  hasMore: boolean;
  nextCursor?: string;
  filter?: string;
  orderBy?: string;
  limit: number;
  readOnly: boolean;
}

export const dataTable = (data: DataTableData): string => {
  const sortKey = data.orderBy?.split(':')[0];
  const sortDir = data.orderBy?.split(':')[1] as 'asc' | 'desc' | undefined;
  const resource = encodeURIComponent(data.resource.replace(/^\/+/, ''));

  return card({
    title: escapeHtml(data.resource),
    headerRight: html`
      <div style="display: flex; gap: 8px; align-items: center;">
        ${badge(data.items.length + ' loaded', 'neutral')}
        ${data.totalCount !== undefined ? badge(data.totalCount + ' total', 'info') : ''}
        ${data.orderBy ? badge('Sort: ' + data.orderBy, 'neutral') : ''}
      </div>
    `,
    flush: true,
  }, html`
    ${data.items.length > 0 ? html`
      <div style="overflow-x: auto;">
        <table class="table table-mono table-sortable">
          ${tableHead({
            columns: data.schema.columns.map(c => ({
              key: c.name,
              label: c.name,
              sortable: true,
            })).concat(data.readOnly ? [] : [{ key: '_actions', label: 'Actions', sortable: false }]),
            sortKey,
            sortDir,
            sortUrl: '/__concave/ui/data/' + resource + '/table?limit=' + data.limit + (data.filter ? '&filter=' + encodeURIComponent(data.filter) : ''),
          })}
          <tbody>
            ${data.items.map((item) => html`
              <tr hx-get="/__concave/ui/data/${resource}/row/${encodeURIComponent(String(item[data.schema.primaryKey]))}"
                  hx-target="#detail-panel"
                  hx-swap="innerHTML"
                  style="cursor: pointer;">
                ${data.schema.columns.map(c => html`
                  <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${typeof item[c.name] === 'object' ? escapeHtml(JSON.stringify(item[c.name])) : escapeHtml(String(item[c.name] ?? ''))}
                  </td>
                `).join('')}
                ${!data.readOnly ? html`
                  <td onclick="event.stopPropagation();">
                    <div style="display: flex; gap: 4px;">
                      ${button('Edit', {
                        size: 'sm',
                        hxGet: '/__concave/ui/data/' + resource + '/edit/' + encodeURIComponent(String(item[data.schema.primaryKey])),
                        hxTarget: '#modal-container',
                      })}
                      ${button('Delete', {
                        size: 'sm',
                        variant: 'ghost',
                        class: 'btn-danger',
                        hxDelete: '/__concave/api/explorer/data/' + resource + '/' + encodeURIComponent(String(item[data.schema.primaryKey])),
                        hxConfirm: 'Delete this record?',
                        hxTarget: 'closest tr',
                        hxSwap: 'outerHTML',
                      })}
                    </div>
                  </td>
                ` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${data.hasMore ? html`
        <div style="padding: 12px; text-align: center; border-top: 1px solid var(--border);">
          ${button('Load More', {
            hxGet: '/__concave/ui/data/' + resource + '/table?limit=' + data.limit + '&cursor=' + encodeURIComponent(data.nextCursor || '') + (data.filter ? '&filter=' + encodeURIComponent(data.filter) : '') + (data.orderBy ? '&orderBy=' + encodeURIComponent(data.orderBy) : ''),
            hxTarget: 'closest table tbody',
            hxSwap: 'beforeend',
          })}
        </div>
      ` : ''}
    ` : emptyState('\u2637', 'No records found', data.filter ? 'Try adjusting your filter' : 'This resource has no data')}

    <div id="detail-panel" style="margin-top: 16px;"></div>

    <style>
      .btn-danger { color: var(--error); }
      .btn-danger:hover { background: var(--error-bg); }
    </style>
  `);
};

export interface RecordDetailData {
  resource: string;
  item: Record<string, unknown>;
}

export const recordDetail = (data: RecordDetailData): string => card({
  title: 'Record Details',
  headerRight: button('\u2715', {
    size: 'sm',
    variant: 'ghost',
    hxGet: '/__concave/ui/empty',
    hxTarget: '#detail-panel',
    hxSwap: 'innerHTML',
  }),
}, html`
  <div class="code">${escapeHtml(formatJson(data.item))}</div>
`);

export interface RecordFormData {
  resource: string;
  schema: SchemaInfo;
  item?: Record<string, unknown>;
  isEdit: boolean;
}

export const recordForm = (data: RecordFormData): string => {
  const resource = encodeURIComponent(data.resource.replace(/^\/+/, ''));
  return html`
  <div class="modal-backdrop" onclick="this.remove()">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <span class="modal-title">${data.isEdit ? 'Edit Record' : 'Create Record'}</span>
        ${button('\u00D7', { size: 'sm', variant: 'ghost', class: 'modal-close' })}
      </div>
      <form hx-${data.isEdit ? 'patch' : 'post'}="/__concave/api/explorer/data/${resource}${data.isEdit && data.item ? '/' + encodeURIComponent(String(data.item[data.schema.primaryKey])) : ''}"
            hx-target="#data-table"
            hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) { document.querySelector('.modal-backdrop')?.remove(); showToast('Record ${data.isEdit ? 'updated' : 'created'}'); }">
        <div class="modal-body">
          ${data.schema.columns.map(col => html`
            <div class="form-group">
              <label class="form-label">
                ${escapeHtml(col.name)}
                ${col.isPrimary ? badge('PK', 'info') : ''}
                ${col.isGenerated ? badge('Generated', 'neutral') : ''}
              </label>
              <input
                class="input input-mono form-input"
                name="${escapeHtml(col.name)}"
                value="${escapeHtml(String(data.item?.[col.name] ?? ''))}"
                ${col.isGenerated || (data.isEdit && col.isPrimary) ? 'disabled' : ''}
              />
            </div>
          `).join('')}
        </div>
        <div class="modal-footer">
          ${button('Cancel', { variant: 'secondary', class: 'modal-close' })}
          ${button(data.isEdit ? 'Save' : 'Create', { variant: 'primary', type: 'submit' })}
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
};

export interface ResourceSelectorData {
  resources: string[];
  readOnly: boolean;
}

export const resourceSelector = (data: ResourceSelectorData): string => html`
  <div style="display: flex; flex-direction: column; gap: 8px;">
    ${data.resources.map(r => html`
      <div class="list-item" style="cursor: pointer;"
           hx-get="/__concave/ui/data/${encodeURIComponent(r.replace(/^\/+/, ''))}/table"
           hx-target="#data-table"
           hx-swap="innerHTML">
        <span class="code-inline">${escapeHtml(r)}</span>
      </div>
    `).join('')}
  </div>
`;
