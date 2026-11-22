import { application_status, delivery_status, payment_status } from '@prisma/client';

export const UTF8_BOM = '\uFEFF';

export const ADMIN_EXPORT_CSV_HEADERS: readonly string[] = [
  'Application No.',
  'Service',
  'Citizen',
  'National ID',
  'Governorate',
  'Status',
  'Submitted At',
  'Due At',
  'Overdue',
  'Fee (EGP)',
  'Payment',
  'Delivery',
];

const FORMULA_PREFIX_PATTERN = /^[=+\-@\t\r]/;

const CAIRO_DATETIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const CAIRO_COMPACT_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Prevents spreadsheet formula injection (Contract §7.2):
 * cells beginning with '=', '+', '-', '@', '\t', or '\r' are prefixed with a single quote.
 */
export function sanitizeCsvCell(value: string): string {
  if (FORMULA_PREFIX_PATTERN.test(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Applies formula-injection neutralization and RFC 4180 quoting.
 */
export function escapeCsvCell(value: string): string {
  const safe = sanitizeCsvCell(value);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function formatCsvRow(cells: readonly string[]): string {
  return `${cells.map(escapeCsvCell).join(',')}\r\n`;
}

/**
 * Formats a timestamp as `YYYY-MM-DD HH:mm` in Africa/Cairo (Contract §7.2).
 */
export function formatCairoDateTime(date: Date | null): string {
  if (!date) {
    return '';
  }

  const parts = CAIRO_DATETIME_FORMATTER.formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get('year') ?? '0000';
  const month = byType.get('month') ?? '01';
  const day = byType.get('day') ?? '01';
  const hour = byType.get('hour') ?? '00';
  const minute = byType.get('minute') ?? '00';
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * Formats a date as `YYYYMMDD` in Africa/Cairo for export filenames (Contract §7.2).
 */
export function formatCairoCompactDate(date: Date = new Date()): string {
  return CAIRO_COMPACT_DATE_FORMATTER.format(date).replace(/-/g, '');
}

/**
 * Converts piastres to EGP with two decimals (Contract §7.2).
 */
export function formatMoneyEgp(amountPiastres: number): string {
  return (amountPiastres / 100).toFixed(2);
}

const APPLICATION_STATUS_LABELS: Record<application_status, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

const PAYMENT_STATUS_LABELS: Record<payment_status, string> = {
  PAID: 'Paid',
  UNPAID: 'Unpaid',
  NOT_REQUIRED: 'Not required',
};

const DELIVERY_STATUS_LABELS: Record<delivery_status, string> = {
  PENDING_ASSIGNMENT: 'Pending assignment',
  ASSIGNED: 'Assigned',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  FAILED_ATTEMPT: 'Failed attempt',
};

export function formatApplicationStatusLabel(status: application_status): string {
  return APPLICATION_STATUS_LABELS[status];
}

export function formatPaymentStatusLabel(status: payment_status): string {
  return PAYMENT_STATUS_LABELS[status];
}

export function formatDeliveryStatusLabel(status: delivery_status | null): string {
  return status ? DELIVERY_STATUS_LABELS[status] : '';
}
