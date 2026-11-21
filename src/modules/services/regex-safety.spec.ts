import { checkRegexSafety } from './regex-safety';

describe('checkRegexSafety (D-22)', () => {
  it('accepts safe regular expressions including escaped literals', () => {
    expect(checkRegexSafety('^[0-9]{6}$')).toEqual({ safe: true });
    expect(checkRegexSafety('^[A-Z]{2,4}-[0-9]{4}$')).toEqual({ safe: true });
    expect(checkRegexSafety('^foo\\\\1bar$')).toEqual({ safe: true }); // escaped backslash + literal 1
    expect(checkRegexSafety('^[a-z0-9._-]+$')).toEqual({ safe: true });
  });

  it('rejects catastrophic backtracking / ReDoS patterns via safe-regex2', () => {
    expect(checkRegexSafety('(a+)+$').safe).toBe(false);
    expect(checkRegexSafety('([a-zA-Z]+)*$').safe).toBe(false);
  });

  it('rejects numeric and named backreferences', () => {
    expect(checkRegexSafety('([a-z]+)\\1').safe).toBe(false);
    expect(checkRegexSafety('(?<word>[a-z]+)\\k<word>').safe).toBe(false);
  });

  it('rejects positive and negative lookaheads and lookbehinds', () => {
    expect(checkRegexSafety('(?=.*[0-9])[a-z0-9]+').safe).toBe(false);
    expect(checkRegexSafety('(?!admin)[a-z]+').safe).toBe(false);
    expect(checkRegexSafety('(?<=foo)bar').safe).toBe(false);
    expect(checkRegexSafety('(?<!foo)bar').safe).toBe(false);
  });

  it('rejects empty, >200-char, and syntactically invalid regexes', () => {
    expect(checkRegexSafety('').safe).toBe(false);
    expect(checkRegexSafety('a'.repeat(201)).safe).toBe(false);
    expect(checkRegexSafety('[unclosed').safe).toBe(false);
  });
});
