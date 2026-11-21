/**
 * Sanitizes client original filename for display storage (Contract §4.9).
 */
export function sanitizeOriginalName(rawName: string): string {
  const baseName = rawName.split(/[\\/]/).pop() ?? 'document';
  // Strip ASCII control chars, quotes, and newlines
  const cleaned = baseName
    .replace(/[\u0000-\u001f\u007f"\\]/g, '_')
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : 'document';
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds an inline Content-Disposition header with ASCII fallback and RFC 5987 UTF-8 encoding
 * (Contract §4.10, Design D-26).
 */
export function buildInlineContentDisposition(originalName: string): string {
  const safeName = sanitizeOriginalName(originalName);
  const asciiFallback =
    safeName
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\;]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '') || 'document';

  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
}
