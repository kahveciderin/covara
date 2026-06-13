export const escapeHtml = (
  value: string | number | boolean | null | undefined
): string => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

export const escapeAttr = (
  value: string | number | boolean | null | undefined
): string => escapeHtml(value);
