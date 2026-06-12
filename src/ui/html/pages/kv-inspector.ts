import { html, escapeHtml, formatJson } from '../utils';
import { card, badge, button, input, alert, emptyState, toolbar } from '../components';

export interface KVInspectorPageData {
  enabled: boolean;
  readOnly: boolean;
  mode: string;
}

export const kvInspectorPage = (data: KVInspectorPageData): string => {
  if (!data.enabled) {
    return html`
      <div class="page-header">
        <h1 class="page-title">KV Inspector</h1>
        <p class="page-desc">Browse and manage key-value store data</p>
      </div>
      ${emptyState('\u26C1', 'KV Inspector Disabled', 'Enable KV inspector in your admin UI configuration')}
    `;
  }

  return html`
    <div class="page-header">
      <h1 class="page-title">KV Inspector</h1>
      <p class="page-desc">Browse and manage key-value store data</p>
    </div>

    ${data.readOnly ? alert('Read-only mode - mutations disabled in ' + data.mode, 'info') : ''}

    ${toolbar(html`
      ${input({
        name: 'pattern',
        placeholder: 'Key pattern: covara:*',
        mono: true,
        class: 'pattern-input',
      })}
      ${button('Search', {
        variant: 'primary',
        hxGet: '/__covara/ui/kv/keys',
        hxTarget: '#kv-content',
        hxInclude: '[name="pattern"]',
      })}
    `)}

    <div id="kv-content" style="margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div id="kv-keys">
        ${card({}, emptyState('\u26C1', 'Search for keys', 'Enter a pattern like "cache:*" to browse keys'))}
      </div>
      <div id="kv-value"></div>
    </div>

    <script>
      document.querySelector('.pattern-input')?.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          htmx.ajax('GET', '/__covara/ui/kv/keys?pattern=' + encodeURIComponent(e.target.value), {
            target: '#kv-content',
            swap: 'innerHTML'
          });
        }
      });
    </script>
  `;
};

export interface KVKeysData {
  keys: string[];
  readOnly: boolean;
}

export const kvKeysList = (data: KVKeysData): string => html`
  <div id="kv-keys">
    ${card({
      title: 'Keys',
      headerRight: badge(data.keys.length + ' keys', 'neutral'),
      flush: true,
    }, html`
      ${data.keys.length > 0 ? html`
        <div style="max-height: 500px; overflow-y: auto;">
          ${data.keys.map(key => html`
            <div class="list-item" style="cursor: pointer;"
                 hx-get="/__covara/ui/kv/value/${encodeURIComponent(key)}"
                 hx-target="#kv-value"
                 hx-swap="innerHTML">
              <span class="code-inline" style="word-break: break-all;">${escapeHtml(key)}</span>
              ${!data.readOnly ? html`
                <div onclick="event.stopPropagation();">
                  ${button('\u2715', {
                    size: 'sm',
                    variant: 'ghost',
                    class: 'btn-danger',
                    hxDelete: '/__covara/api/kv/key/' + encodeURIComponent(key),
                    hxConfirm: 'Delete key: ' + key + '?',
                    hxTarget: 'closest .list-item',
                    hxSwap: 'outerHTML',
                  })}
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      ` : emptyState('\u26C1', 'No keys found', 'Try a different pattern')}

    `)}
  </div>
  <div id="kv-value"></div>
`;

export interface KVValueData {
  key: string;
  type: string;
  value: unknown;
  ttl?: number;
  readOnly: boolean;
}

export const kvValueView = (data: KVValueData): string => card({
  title: escapeHtml(data.key),
  headerRight: html`
    <div style="display: flex; gap: 8px; align-items: center;">
      ${badge(data.type, 'info')}
      ${data.ttl !== undefined && data.ttl >= 0 ? badge('TTL: ' + data.ttl + 's', 'neutral') : ''}
      ${button('\u2715', {
        size: 'sm',
        variant: 'ghost',
        hxGet: '/__covara/ui/empty',
        hxTarget: '#kv-value',
        hxSwap: 'innerHTML',
      })}
    </div>
  `,
}, html`
  <div class="code" style="max-height: 400px; overflow-y: auto;">
    ${escapeHtml(typeof data.value === 'string' ? data.value : formatJson(data.value))}
  </div>

  ${!data.readOnly && data.type === 'string' ? html`
    <div style="margin-top: 16px;">
      <form hx-put="/__covara/api/kv/key/${encodeURIComponent(data.key)}"
            hx-target="#kv-value"
            hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) showToast('Value updated');">
        <div class="form-group">
          <label class="form-label">Edit Value</label>
          <textarea class="input input-mono form-input" name="value" rows="4">${escapeHtml(String(data.value))}</textarea>
        </div>
        <div style="display: flex; gap: 8px;">
          ${button('Save', { variant: 'primary', type: 'submit' })}
        </div>
      </form>
    </div>
  ` : ''}
`);
