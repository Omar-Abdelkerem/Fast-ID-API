import { maskHolderName, maskNationalId } from './mask';

describe('mask utils', () => {
  it('masks national ID showing first 2 and last 2 digits with 10 asterisks', () => {
    expect(maskNationalId('29901150112345')).toBe('29**********45');
    expect(maskNationalId('29901150112345').length).toBe(14);
  });

  it('masks holder name keeping first word full and initials for remaining words', () => {
    expect(maskHolderName('Ahmed Mohamed Kamal')).toBe('Ahmed M. K.');
    expect(maskHolderName('أحمد محمد علي')).toBe('أحمد م. ع.');
    expect(maskHolderName('Single')).toBe('Single');
  });
});
