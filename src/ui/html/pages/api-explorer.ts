import { html, escapeHtml, formatJson } from '../utils';
import { card, badge, button, methodBadge, statusBadge, emptyState } from '../components';

export interface EndpointInfo {
  method: string;
  path: string;
  description?: string;
  parameters?: {
    name: string;
    in: 'path' | 'query' | 'body';
    type: string;
    required?: boolean;
    description?: string;
  }[];
  requestBody?: {
    contentType: string;
    schema?: unknown;
  };
  responses?: Record<string, { description: string; schema?: unknown }>;
}

export interface ApiExplorerPageData {
  endpoints: EndpointInfo[];
  baseUrl: string;
}

export const apiExplorerPage = (data: ApiExplorerPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">API Explorer</h1>
    <p class="page-desc">Explore and test API endpoints</p>
  </div>

  <div style="display: grid; grid-template-columns: 300px 1fr; gap: 16px;">
    <div>
      ${endpointsList(data.endpoints)}
    </div>
    <div id="endpoint-detail">
      ${emptyState('\u2190', 'Select an endpoint', 'Choose an endpoint from the list to view details and test')}
    </div>
  </div>
`;

const endpointsList = (endpoints: EndpointInfo[]): string => card({
  title: 'Endpoints',
  headerRight: badge(endpoints.length + ' endpoints', 'neutral'),
  flush: true,
}, html`
  <div style="max-height: calc(100vh - 250px); overflow-y: auto;">
    ${endpoints.length > 0 ? html`
      ${endpoints.map((endpoint, i) => html`
        <div class="list-item" style="cursor: pointer; padding: 10px 12px;"
             hx-get="/__concave/ui/api-explorer/endpoint/${i}"
             hx-target="#endpoint-detail"
             hx-swap="innerHTML">
          <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
            ${methodBadge(endpoint.method)}
            <span class="code-inline" style="font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis;">
              ${escapeHtml(endpoint.path)}
            </span>
          </div>
        </div>
      `).join('')}
    ` : html`<p style="color: var(--text-3); text-align: center; padding: 20px;">No endpoints found</p>`}
  </div>
`);

export interface EndpointDetailData {
  endpoint: EndpointInfo;
  baseUrl: string;
}

export const endpointDetail = (data: EndpointDetailData): string => card({
  title: html`
    <div style="display: flex; align-items: center; gap: 8px;">
      ${methodBadge(data.endpoint.method)}
      <span class="code-inline">${escapeHtml(data.endpoint.path)}</span>
    </div>
  `,
}, html`
  ${data.endpoint.description ? html`
    <p style="color: var(--text-2); margin-bottom: 16px;">${escapeHtml(data.endpoint.description)}</p>
  ` : ''}

  <form id="api-test-form" hx-post="/__concave/ui/api-explorer/execute"
        hx-target="#api-response" hx-swap="innerHTML">
    <input type="hidden" name="method" value="${data.endpoint.method}">
    <input type="hidden" name="path" value="${data.endpoint.path}">

    ${data.endpoint.parameters && data.endpoint.parameters.length > 0 ? html`
      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Parameters</h4>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${data.endpoint.parameters.map(param => html`
            <div style="display: flex; align-items: center; gap: 8px;">
              <label style="min-width: 120px; font-size: 12px;">
                ${escapeHtml(param.name)}
                ${param.required ? html`<span style="color: var(--error);">*</span>` : ''}
              </label>
              <input type="text" class="input input-mono form-input" style="flex: 1;"
                     name="param_${param.name}"
                     placeholder="${escapeHtml(param.type)}${param.description ? ' - ' + param.description : ''}">
              ${badge(param.in, 'neutral')}
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${data.endpoint.requestBody ? html`
      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">
          Request Body
          ${badge(data.endpoint.requestBody.contentType, 'neutral')}
        </h4>
        <textarea class="input input-mono form-input" name="body" rows="6"
                  placeholder='{"key": "value"}'></textarea>
        ${data.endpoint.requestBody.schema ? html`
          <details style="margin-top: 8px;">
            <summary style="cursor: pointer; font-size: 11px; color: var(--text-2);">View schema</summary>
            <div class="code" style="margin-top: 8px; font-size: 10px;">
              ${escapeHtml(formatJson(data.endpoint.requestBody.schema))}
            </div>
          </details>
        ` : ''}
      </div>
    ` : ''}

    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      ${button('Send Request', { variant: 'primary', type: 'submit' })}
      ${button('Reset', { variant: 'secondary', type: 'reset' })}
    </div>
  </form>

  ${data.endpoint.responses ? html`
    <details>
      <summary style="cursor: pointer; font-size: 12px; color: var(--text-2); margin-bottom: 8px;">
        Response Schemas
      </summary>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        ${Object.entries(data.endpoint.responses).map(([status, response]) => html`
          <div style="border: 1px solid var(--border); border-radius: 6px; padding: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              ${statusBadge(parseInt(status))}
              <span style="font-size: 12px; color: var(--text-2);">${escapeHtml(response.description)}</span>
            </div>
            ${response.schema ? html`
              <div class="code" style="font-size: 10px;">
                ${escapeHtml(formatJson(response.schema))}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </details>
  ` : ''}

  <div id="api-response" style="margin-top: 16px;"></div>
`);

export interface ApiResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  duration: number;
  error?: string;
}

export const apiResponse = (data: ApiResponseData): string => card({
  title: 'Response',
  headerRight: html`
    <div style="display: flex; align-items: center; gap: 8px;">
      ${statusBadge(data.status)}
      ${badge(data.duration + 'ms', 'neutral')}
    </div>
  `,
}, html`
  ${data.error ? html`
    <div class="alert alert-error">${escapeHtml(data.error)}</div>
  ` : ''}

  <details style="margin-bottom: 12px;">
    <summary style="cursor: pointer; font-size: 12px; color: var(--text-2);">Headers</summary>
    <div class="code" style="margin-top: 8px; font-size: 11px;">
      ${Object.entries(data.headers).map(([key, value]) =>
        escapeHtml(key) + ': ' + escapeHtml(value)
      ).join('\n')}
    </div>
  </details>

  <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Body</h4>
  <div class="code" style="max-height: 400px; overflow-y: auto;">
    ${escapeHtml(typeof data.body === 'string' ? data.body : formatJson(data.body))}
  </div>
`);
