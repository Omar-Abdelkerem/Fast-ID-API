import { sniffAllowedMimeType } from './magic-bytes';

describe('sniffAllowedMimeType', () => {
  it('detects JPEG, PNG, and PDF from magic bytes', () => {
    expect(sniffAllowedMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(
      sniffAllowedMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
    expect(sniffAllowedMimeType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('returns null for HTML, scripts, plain text, or truncated buffers', () => {
    expect(sniffAllowedMimeType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffAllowedMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffAllowedMimeType(Buffer.alloc(0))).toBeNull();
  });
});
