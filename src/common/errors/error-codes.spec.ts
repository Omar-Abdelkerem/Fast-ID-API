import * as fs from 'fs';
import * as path from 'path';
import { ERROR_STATUS_MAP } from './error-codes';

function extractContractErrorCodes(contractMarkdown: string): Record<string, number> {
  // Ignore §12 (deferred items like NATIONAL_ID_VERIFICATION_FAILED) and # Changelog prose.
  const section12Index = contractMarkdown.indexOf('# 12. Open questions and deferred items');
  const activeContract =
    section12Index === -1 ? contractMarkdown : contractMarkdown.slice(0, section12Index);

  const found = new Map<string, number>();
  const conflicts: string[] = [];

  const record = (statusStr: string, code: string) => {
    const status = Number.parseInt(statusStr, 10);
    const existing = found.get(code);
    if (existing !== undefined && existing !== status) {
      conflicts.push(`${code}: saw ${existing} and ${status}`);
      return;
    }
    found.set(code, status);
  };

  // Pattern 1: Markdown table rows -> | 400 | `VALIDATION_ERROR` | ...
  const tableRowRegex = /\|\s*(4\d\d|5\d\d)\s*\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/g;
  for (const match of activeContract.matchAll(tableRowRegex)) {
    record(match[1], match[2]);
  }

  // Pattern 2: Inline backtick status + code -> `404 APPLICATION_NOT_FOUND`
  const inlineCodeRegex = /`(4\d\d|5\d\d)\s+([A-Z][A-Z0-9_]+)`/g;
  for (const match of activeContract.matchAll(inlineCodeRegex)) {
    record(match[1], match[2]);
  }

  // Pattern 3: Status outside backticks followed by code -> 404 `SERVICE_NOT_FOUND`
  const mixedInlineRegex = /\b(4\d\d|5\d\d)\s+`([A-Z][A-Z0-9_]+)`/g;
  for (const match of activeContract.matchAll(mixedInlineRegex)) {
    record(match[1], match[2]);
  }

  if (conflicts.length > 0) {
    throw new Error(`Conflicting error code statuses in contract: ${conflicts.join(', ')}`);
  }

  return Object.fromEntries([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe('ERROR_STATUS_MAP vs Fast_ID_API_Contract.md', () => {
  const contractPath = path.resolve(process.cwd(), 'docs', 'Fast_ID_API_Contract.md');

  it('contains all 57 error codes with exact HTTP statuses matching the API contract', () => {
    const contractMarkdown = fs.readFileSync(contractPath, 'utf8');
    const contractCodes = extractContractErrorCodes(contractMarkdown);

    const registrySorted = Object.fromEntries(
      Object.entries(ERROR_STATUS_MAP).sort(([a], [b]) => a.localeCompare(b)),
    );

    expect(Object.keys(registrySorted)).toHaveLength(57);
    expect(registrySorted).toEqual(contractCodes);
  });
});
