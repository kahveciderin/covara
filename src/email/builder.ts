export interface EmailTheme {
  brandColor?: string;
  textColor?: string;
  mutedColor?: string;
  backgroundColor?: string;
  bodyColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  width?: number;
  logoUrl?: string;
  logoAlt?: string;
}

const DEFAULT_THEME: Required<Omit<EmailTheme, "logoUrl" | "logoAlt">> = {
  brandColor: "#4f46e5",
  textColor: "#111827",
  mutedColor: "#6b7280",
  backgroundColor: "#f3f4f6",
  bodyColor: "#ffffff",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  borderRadius: "8px",
  width: 600,
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type Block =
  | { kind: "heading"; text: string; level: 1 | 2 | 3 }
  | { kind: "text"; text: string }
  | { kind: "button"; label: string; url: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "divider" }
  | { kind: "spacer"; size: number }
  | { kind: "image"; url: string; alt: string }
  | { kind: "code"; text: string }
  | { kind: "footer"; text: string }
  | { kind: "raw"; html: string; text: string };

export interface BuiltEmail {
  html: string;
  text: string;
}

// Fluent builder that renders a responsive, email-client-safe HTML document
// (inline styles, table layout) plus a plaintext fallback, from a sequence of
// semantic blocks. Theme controls branding without touching markup.
export class EmailBuilder {
  private blocks: Block[] = [];
  private theme: Required<Omit<EmailTheme, "logoUrl" | "logoAlt">> & Pick<EmailTheme, "logoUrl" | "logoAlt">;
  private previewText?: string;

  constructor(theme: EmailTheme = {}) {
    this.theme = { ...DEFAULT_THEME, ...theme };
  }

  preview(text: string): this {
    this.previewText = text;
    return this;
  }

  heading(text: string, level: 1 | 2 | 3 = 1): this {
    this.blocks.push({ kind: "heading", text, level });
    return this;
  }

  text(text: string): this {
    this.blocks.push({ kind: "text", text });
    return this;
  }

  button(label: string, url: string): this {
    this.blocks.push({ kind: "button", label, url });
    return this;
  }

  link(label: string, url: string): this {
    this.blocks.push({ kind: "link", label, url });
    return this;
  }

  divider(): this {
    this.blocks.push({ kind: "divider" });
    return this;
  }

  spacer(size = 16): this {
    this.blocks.push({ kind: "spacer", size });
    return this;
  }

  image(url: string, alt = ""): this {
    this.blocks.push({ kind: "image", url, alt });
    return this;
  }

  code(text: string): this {
    this.blocks.push({ kind: "code", text });
    return this;
  }

  footer(text: string): this {
    this.blocks.push({ kind: "footer", text });
    return this;
  }

  raw(html: string, text: string): this {
    this.blocks.push({ kind: "raw", html, text });
    return this;
  }

  private renderBlockHtml(block: Block): string {
    const t = this.theme;
    switch (block.kind) {
      case "heading": {
        const size = block.level === 1 ? 24 : block.level === 2 ? 20 : 16;
        return `<h${block.level} style="margin:0 0 16px;font-size:${size}px;line-height:1.3;color:${t.textColor};font-weight:700;">${escapeHtml(block.text)}</h${block.level}>`;
      }
      case "text":
        return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${t.textColor};">${escapeHtml(block.text)}</p>`;
      case "button":
        return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:${t.borderRadius};background:${t.brandColor};"><a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:${t.borderRadius};">${escapeHtml(block.label)}</a></td></tr></table>`;
      case "link":
        return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;"><a href="${escapeHtml(block.url)}" style="color:${t.brandColor};text-decoration:underline;">${escapeHtml(block.label)}</a></p>`;
      case "divider":
        return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />`;
      case "spacer":
        return `<div style="height:${block.size}px;line-height:${block.size}px;">&nbsp;</div>`;
      case "image":
        return `<img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt)}" style="max-width:100%;height:auto;margin:0 0 16px;border-radius:${t.borderRadius};" />`;
      case "code":
        return `<p style="margin:0 0 16px;padding:12px 16px;background:#f3f4f6;border-radius:${t.borderRadius};font-family:monospace;font-size:18px;letter-spacing:2px;color:${t.textColor};text-align:center;">${escapeHtml(block.text)}</p>`;
      case "footer":
        return `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:${t.mutedColor};">${escapeHtml(block.text)}</p>`;
      case "raw":
        return block.html;
    }
  }

  private renderBlockText(block: Block): string {
    switch (block.kind) {
      case "heading":
        return `${block.text}\n${"=".repeat(Math.min(block.text.length, 40))}`;
      case "text":
        return block.text;
      case "button":
      case "link":
        return `${block.label}: ${block.url}`;
      case "divider":
        return "----------------------------------------";
      case "spacer":
        return "";
      case "image":
        return block.alt ? `[${block.alt}]` : "";
      case "code":
        return block.text;
      case "footer":
        return block.text;
      case "raw":
        return block.text;
    }
  }

  build(): BuiltEmail {
    const t = this.theme;
    const logo = t.logoUrl
      ? `<img src="${escapeHtml(t.logoUrl)}" alt="${escapeHtml(t.logoAlt ?? "")}" style="max-height:40px;margin:0 0 24px;" />`
      : "";
    const preview = this.previewText
      ? `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(this.previewText)}</div>`
      : "";
    const body = this.blocks.map((b) => this.renderBlockHtml(b)).join("\n");

    const html = `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:${t.backgroundColor};">
${preview}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.backgroundColor};padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="${t.width}" cellpadding="0" cellspacing="0" style="max-width:${t.width}px;width:100%;background:${t.bodyColor};border-radius:${t.borderRadius};padding:32px;font-family:${t.fontFamily};">
<tr><td>
${logo}
${body}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    const text = this.blocks
      .map((b) => this.renderBlockText(b))
      .filter((line) => line !== "")
      .join("\n\n");

    return { html, text };
  }
}

export const createEmail = (theme?: EmailTheme): EmailBuilder => new EmailBuilder(theme);
