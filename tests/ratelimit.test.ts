import { expect, it } from 'vitest';
import { makeLimiter } from '@/lib/rateLimit';

it('allows up to the limit per window then blocks, per key', () => {
  let t = 0;
  const allow = makeLimiter(2, 1000, () => t);
  expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
  t = 1500;
  expect(allow('a')).toBe(true);
});
