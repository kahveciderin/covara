import { html, escapeHtml, classNames } from '../utils';

export interface CardProps {
  title?: string;
  headerRight?: string;
  bodyClass?: string;
  flush?: boolean;
}

export const card = (props: CardProps, body: string): string => html`
  <div class="card">
    ${props.title ? html`
      <div class="card-header">
        <span class="card-title">${props.title}</span>
        ${props.headerRight || ''}
      </div>
    ` : ''}
    <div class="${classNames(props.flush ? 'card-body-flush' : 'card-body', props.bodyClass)}">
      ${body}
    </div>
  </div>
`;

export const statCard = (
  label: string,
  value: string | number,
  variant: BadgeVariant = 'neutral',
  opts: { icon?: string; href?: string; sub?: string } = {}
): string => {
  const inner = html`
    <div class="stat-label">${opts.icon ? html`<span class="nav-icon" style="opacity:.7">${opts.icon}</span>` : ''}${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(value)}</div>
    ${opts.sub ? html`<div class="stat-sub">${escapeHtml(opts.sub)}</div>` : ''}
  `;
  if (opts.href) {
    return html`<a class="stat-card stat-${variant}" href="${opts.href}" hx-get="${opts.href}" hx-target="#content" hx-push-url="true" hx-swap="innerHTML" style="text-decoration:none;color:inherit;display:block">${inner}</a>`;
  }
  return html`<div class="stat-card stat-${variant}">${inner}</div>`;
};

export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export const badge = (text: string | number, variant: BadgeVariant = 'neutral'): string => html`
  <span class="badge badge-${variant}">${escapeHtml(text)}</span>
`;

export const methodBadge = (method: string): string => {
  const m = method.toUpperCase();
  return html`<span class="badge badge-method badge-${m.toLowerCase()}">${m}</span>`;
};

export const statusBadge = (status: number): string => {
  const variant: BadgeVariant = status < 400 ? 'success' : 'error';
  return badge(status, variant);
};

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  class?: string;
  hxGet?: string;
  hxPost?: string;
  hxPut?: string;
  hxDelete?: string;
  hxTarget?: string;
  hxSwap?: string;
  hxConfirm?: string;
  hxIndicator?: string;
  hxInclude?: string;
}

export const button = (text: string, props: ButtonProps = {}): string => {
  const classes = classNames(
    'btn',
    `btn-${props.variant || 'secondary'}`,
    props.size === 'sm' && 'btn-sm',
    props.class
  );

  const attrs: string[] = [];
  if (props.disabled) attrs.push('disabled');
  if (props.type) attrs.push(`type="${props.type}"`);
  if (props.hxGet) attrs.push(`hx-get="${escapeHtml(props.hxGet)}"`);
  if (props.hxPost) attrs.push(`hx-post="${escapeHtml(props.hxPost)}"`);
  if (props.hxPut) attrs.push(`hx-put="${escapeHtml(props.hxPut)}"`);
  if (props.hxDelete) attrs.push(`hx-delete="${escapeHtml(props.hxDelete)}"`);
  if (props.hxTarget) attrs.push(`hx-target="${escapeHtml(props.hxTarget)}"`);
  if (props.hxSwap) attrs.push(`hx-swap="${escapeHtml(props.hxSwap)}"`);
  if (props.hxConfirm) attrs.push(`hx-confirm="${escapeHtml(props.hxConfirm)}"`);
  if (props.hxIndicator) attrs.push(`hx-indicator="${escapeHtml(props.hxIndicator)}"`);
  if (props.hxInclude) attrs.push(`hx-include="${escapeHtml(props.hxInclude)}"`);

  return html`<button class="${classes}" ${attrs.join(' ')}>${escapeHtml(text)}</button>`;
};

export interface InputProps {
  type?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  mono?: boolean;
}

export const input = (props: InputProps = {}): string => {
  const classes = classNames('input', props.mono && 'input-mono', props.class);
  const attrs: string[] = [];
  if (props.type) attrs.push(`type="${props.type}"`);
  if (props.name) attrs.push(`name="${escapeHtml(props.name)}"`);
  if (props.value !== undefined) attrs.push(`value="${escapeHtml(props.value)}"`);
  if (props.placeholder) attrs.push(`placeholder="${escapeHtml(props.placeholder)}"`);
  if (props.disabled) attrs.push('disabled');

  return html`<input class="${classes}" ${attrs.join(' ')} />`;
};

export interface SelectProps {
  name?: string;
  value?: string;
  disabled?: boolean;
  class?: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export const select = (props: SelectProps): string => {
  const classes = classNames('input', 'select', props.class);
  const attrs: string[] = [];
  if (props.name) attrs.push(`name="${escapeHtml(props.name)}"`);
  if (props.disabled) attrs.push('disabled');

  return html`
    <select class="${classes}" ${attrs.join(' ')}>
      ${props.placeholder ? html`<option value="">${escapeHtml(props.placeholder)}</option>` : ''}
      ${props.options.map(opt => html`
        <option value="${escapeHtml(opt.value)}" ${props.value === opt.value ? 'selected' : ''}>
          ${escapeHtml(opt.label)}
        </option>
      `).join('')}
    </select>
  `;
};

export interface TableColumn {
  key: string;
  label: string;
  sortable?: boolean;
  class?: string;
}

export interface TableProps {
  columns: TableColumn[];
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  mono?: boolean;
  sortUrl?: string;
}

export const tableHead = (props: TableProps): string => {
  return html`
    <thead>
      <tr>
        ${props.columns.map(col => {
          const isSorted = props.sortKey === col.key;
          const nextDir = isSorted && props.sortDir === 'asc' ? 'desc' : 'asc';
          const sortIcon = isSorted ? (props.sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';

          if (col.sortable && props.sortUrl) {
            return html`
              <th class="${col.class || ''}"
                  hx-get="${props.sortUrl}?orderBy=${col.key}:${nextDir}"
                  hx-target="closest table"
                  hx-swap="outerHTML"
                  style="cursor: pointer;">
                ${escapeHtml(col.label)}${sortIcon}
              </th>
            `;
          }
          return html`<th class="${col.class || ''}">${escapeHtml(col.label)}</th>`;
        }).join('')}
      </tr>
    </thead>
  `;
};

export const emptyState = (icon: string, title: string, description?: string): string => html`
  <div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${escapeHtml(title)}</div>
    ${description ? html`<div class="empty-desc">${escapeHtml(description)}</div>` : ''}
  </div>
`;

export const alert = (message: string, variant: 'info' | 'warning' | 'error' | 'success' = 'info'): string => html`
  <div class="alert alert-${variant}">
    ${escapeHtml(message)}
  </div>
`;

export const codeBlock = (content: string): string => html`
  <div class="code">${escapeHtml(content)}</div>
`;

export const envBadge = (mode: string): string => {
  const labels: Record<string, string> = {
    development: 'DEV',
    staging: 'STAGING',
    production: 'PROD',
  };
  const classes: Record<string, string> = {
    development: 'env-dev',
    staging: 'env-staging',
    production: 'env-prod',
  };
  return html`<span class="env-badge ${classes[mode] || 'env-prod'}">${labels[mode] || mode}</span>`;
};

export const loading = (): string => html`<span class="loading htmx-indicator"></span>`;

export const toolbar = (content: string): string => html`
  <div class="toolbar" style="margin-top: 16px;">${content}</div>
`;

export const grid = (items: string[], columns: 2 | 3 | 4 | 5 = 5): string => html`
  <div class="grid grid-${columns}">
    ${items.join('')}
  </div>
`;
