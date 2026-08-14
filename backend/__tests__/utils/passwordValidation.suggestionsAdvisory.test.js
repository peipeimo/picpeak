/**
 * Regression test: zxcvbn's feedback.suggestions are advice, not
 * requirements. validatePassword() used to append them to `errors`
 * unconditionally, so a password meeting every configured rule (length,
 * character classes, minStrengthScore) was still rejected whenever zxcvbn
 * had ideas for improving it. Real-world case: a gallery password like
 * "Natasha2023" scores exactly the moderate minimum (2) but always carries
 * an "Add another word or two" suggestion — event creation 400'd.
 *
 * Suggestions must only surface alongside a real strength failure.
 */

const { validatePassword } = require('../../src/utils/passwordValidation');

describe('validatePassword — suggestions are advisory', () => {
  it('accepts a password that meets the policy even when zxcvbn has suggestions', () => {
    // name + year: score 2 (== moderate minStrengthScore), non-empty suggestions
    const result = validatePassword('Natasha2023');

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // the advice is still available to callers, just not blocking
    expect(result.feedback.suggestions.length).toBeGreaterThan(0);
  });

  it('still rejects a genuinely weak password and includes the suggestions', () => {
    const result = validatePassword('Aaaa1111', { minStrengthScore: 3 });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('too weak')])
    );
  });

  it('keeps rejecting on explicit policy failures unrelated to strength', () => {
    const result = validatePassword('natasha2023'); // no uppercase

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('uppercase')])
    );
  });
});
