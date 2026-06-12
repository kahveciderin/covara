export const escapeHtml = (str: string | number | boolean | null | undefined): string => {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

export const escapeAttr = (str: string | number | boolean | null | undefined): string => {
  return escapeHtml(str);
};

export const classNames = (...classes: (string | false | null | undefined)[]): string => {
  return classes.filter(Boolean).join(' ');
};

export const formatDate = (date: Date | string | number): string => {
  const d = new Date(date);
  return d.toLocaleString();
};

export const formatRelativeTime = (date: Date | string | number | null | undefined): string => {
  if (date == null) return '-';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '-';
  const now = Date.now();
  const diff = now - d.getTime();

  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const formatJson = (obj: unknown, indent = 2): string => {
  try {
    return JSON.stringify(obj, null, indent);
  } catch {
    return String(obj);
  }
};

export type HtmlPrimitive = string | number | boolean | null | undefined;
export type HtmlContent = HtmlPrimitive | HtmlPrimitive[] | string[];

export const html = (strings: TemplateStringsArray, ...values: HtmlContent[]): string => {
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const value = values[i];
      if (Array.isArray(value)) {
        result += (value as HtmlPrimitive[]).flat(10).filter(v => v !== null && v !== undefined && v !== false).join('');
      } else if (value !== null && value !== undefined && value !== false) {
        result += String(value);
      }
    }
  }
  return result;
};

export const raw = (str: string): string => str;

export const safe = (str: string | number | boolean | null | undefined): string => escapeHtml(str);
