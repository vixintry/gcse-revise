import { describe, expect, it } from 'vitest';
import { buildSession } from '@/lib/scheduler/session';
import { days, newCard, reviewed, T0 } from './helpers';

const opts = { now: days(30), newLimit: 5, maxCards: 50, mode: 'due' as const };

describe('buildSession', () => {
  it('includes only due cards, not future ones', () => {
    const due = reviewed('due', 'd1', 40);
    const future = reviewed('future', 'd1', 0);
    const s = buildSession([due, future], { ...opts, now: days(1) });
    expect(s.queue).toEqual(['due']);
  });

  it('puts the most-forgotten (lowest recall probability) first', () => {
    const slightly = reviewed('slightly', 'd1', 10);
    const very = reviewed('very', 'd1', 25);
    expect(buildSession([slightly, very], { ...opts, now: days(40) }).queue[0]).toBe('very');
  });

  it('respects the new-card limit and oldest-first order', () => {
    const cards = [3, 1, 2, 5, 4, 6, 7].map((n) => newCard(`n${n}`, 'd1', n));
    const s = buildSession(cards, { ...opts, newLimit: 3 });
    expect(s.queue).toEqual(['n1', 'n2', 'n3']);
    expect(s.newIds).toEqual(['n1', 'n2', 'n3']);
  });

  it('spreads new cards through reviews instead of front-loading them', () => {
    const rev = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => reviewed(id, 'd1', 40));
    const s = buildSession([...rev, newCard('n1', 'd1', 1), newCard('n2', 'd1', 2)], opts);
    expect(s.queue.indexOf('n1')).toBe(3);
    expect(s.queue.indexOf('n2')).toBe(7);
  });

  it('interleaves decks round-robin', () => {
    const a = ['a1', 'a2', 'a3'].map((id) => reviewed(id, 'A', 40));
    const b = ['b1', 'b2', 'b3'].map((id) => reviewed(id, 'B', 40));
    const decks = buildSession([...a, ...b], opts).queue.map((id) => id[0]);
    expect(decks.slice(0, 4)).not.toEqual(['a', 'a', 'a', 'b']);
    expect(new Set(decks.slice(0, 2)).size).toBe(2);
  });

  it('weak mode picks lapsed cards even when not due, and no new cards', () => {
    const lapsed = reviewed('lapsed', 'd1', 0, [3, 1]);
    const solid = reviewed('solid', 'd1', 0, [4]);
    const s = buildSession([lapsed, solid, newCard('n', 'd1')], { ...opts, now: T0, mode: 'weak' });
    expect(s.queue).toEqual(['lapsed']);
  });

  it('caps the session length', () => {
    const rev = Array.from({ length: 30 }, (_, i) => reviewed(`r${i}`, 'd1', 40));
    expect(buildSession(rev, { ...opts, maxCards: 10 }).queue).toHaveLength(10);
  });

  it('is deterministic for the same input', () => {
    const cards = ['x', 'y', 'z'].map((id) => reviewed(id, 'd1', 40));
    expect(buildSession(cards, opts)).toEqual(buildSession([...cards].reverse(), opts));
  });

  it('empty deck gives an empty session', () => {
    expect(buildSession([], opts).queue).toEqual([]);
  });
});
