/**
 * Bodies the model composes default to HTML, so lists, bold and paragraphs
 * render in the recipient's mail client. A body written as plain text is
 * converted: escaped, blank lines become paragraphs, single newlines <br>.
 * html: false keeps a text/plain body as written.
 */
const HTML_TAG = /<\/?(p|br|div|span|ul|ol|li|b|strong|i|em|u|a|h[1-6]|table|tr|td|th|blockquote|pre|code|hr)\b[^>]*>/i;

export const htmlSchema = {
  type: "boolean",
  description: "Body format. Default true: HTML, so use <p>, <ul>/<ol>/<li>, <b> etc.; a plain-text body is converted (blank lines become paragraphs). false sends text/plain as written.",
} as const;

export function plainTextToHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\r?\n[ \t]*\r?\n/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");
}

export function composeBody(body: string, html: unknown): { body: string; html: boolean } {
  if (html === false) return { body, html: false };
  return { body: HTML_TAG.test(body) ? body : plainTextToHtml(body), html: true };
}
