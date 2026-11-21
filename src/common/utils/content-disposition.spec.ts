import { buildInlineContentDisposition, sanitizeOriginalName } from './content-disposition';

describe('content-disposition utils (D-26)', () => {
  it('sanitizes path traversal and control characters', () => {
    expect(sanitizeOriginalName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeOriginalName('my\r\n"file".pdf')).toBe('my___file_.pdf');
  });

  it('builds ASCII fallback and RFC 5987 UTF-8 filename for Arabic names', () => {
    const header = buildInlineContentDisposition('صورة شخصية.png');
    expect(header).toMatch(/^inline; filename="[^"]+"; filename\*=UTF-8''/);
    expect(header).toContain(encodeURIComponent('صورة شخصية.png'));
  });
});
