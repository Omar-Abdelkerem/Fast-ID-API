import {
  ADMIN_EXPORT_CSV_HEADERS,
  escapeCsvCell,
  formatApplicationStatusLabel,
  formatCairoCompactDate,
  formatCairoDateTime,
  formatCsvRow,
  formatDeliveryStatusLabel,
  formatMoneyEgp,
  formatPaymentStatusLabel,
  sanitizeCsvCell,
} from './csv';

describe('csv utilities (Contract §7.2)', () => {
  it('prefixes cells starting with =, +, -, @, tab, or carriage return with a single quote', () => {
    expect(sanitizeCsvCell('=SUM(A1:A5)')).toBe("'=SUM(A1:A5)");
    expect(sanitizeCsvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(sanitizeCsvCell('-2+3')).toBe("'-2+3");
    expect(sanitizeCsvCell('@HYPERLINK("http://evil")')).toBe('\'@HYPERLINK("http://evil")');
    expect(sanitizeCsvCell('\t=1+1')).toBe("'\t=1+1");
    expect(sanitizeCsvCell('\r=1+1')).toBe("'\r=1+1");
  });

  it('leaves normal Latin and Arabic strings untouched', () => {
    expect(sanitizeCsvCell('Ahmed Mohamed')).toBe('Ahmed Mohamed');
    expect(sanitizeCsvCell('أحمد محمد علي')).toBe('أحمد محمد علي');
    expect(sanitizeCsvCell('FID-2026-000001')).toBe('FID-2026-000001');
    expect(sanitizeCsvCell('50.00')).toBe('50.00');
  });

  it('escapes quotes, commas, and newlines per RFC 4180 after formula guarding', () => {
    expect(escapeCsvCell('Hello, "World"')).toBe('"Hello, ""World"""');
    expect(escapeCsvCell('=1+1,2')).toBe('"\'=1+1,2"');
    expect(escapeCsvCell('\r=cmd')).toBe('"\'\r=cmd"');
    expect(formatCsvRow(['A', 'B,C', '=D'])).toBe('A,"B,C",\'=D\r\n');
  });

  it('formats Cairo timestamps in 24-hour YYYY-MM-DD HH:mm format', () => {
    // 2026-01-15T22:05:00Z is 2026-01-16 00:05 in Africa/Cairo (UTC+2 in January)
    const winterDate = new Date('2026-01-15T22:05:00.000Z');
    expect(formatCairoDateTime(winterDate)).toBe('2026-01-16 00:05');
    expect(formatCairoCompactDate(winterDate)).toBe('20260116');
    expect(formatCairoDateTime(null)).toBe('');
  });

  it('formats money and English labels accurately', () => {
    expect(formatMoneyEgp(0)).toBe('0.00');
    expect(formatMoneyEgp(5000)).toBe('50.00');
    expect(formatMoneyEgp(12345)).toBe('123.45');
    expect(formatApplicationStatusLabel('UNDER_REVIEW')).toBe('Under review');
    expect(formatApplicationStatusLabel('OUT_FOR_DELIVERY')).toBe('Out for delivery');
    expect(formatPaymentStatusLabel('NOT_REQUIRED')).toBe('Not required');
    expect(formatDeliveryStatusLabel('PENDING_ASSIGNMENT')).toBe('Pending assignment');
    expect(formatDeliveryStatusLabel(null)).toBe('');
    expect(ADMIN_EXPORT_CSV_HEADERS).toHaveLength(12);
  });
});
