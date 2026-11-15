import { describe, expect, it } from 'vitest';
import { createSession, rate, undo, currentCardId, isFinished, type Session } from '@/lib/scheduler/session';
import { ids } from './helpers';

const run = (s: Session, grades: (1 | 2 | 3 | 4)[]) => {
  let commit: number | null = null, cur = s;
  grades.forEach((g, i) => { const r = rate(cur, g, `e${i}`); cur = r.session; commit = r.commit; });
  return { s: cur, commit };
};

describe('session queue', () => {
  it('Again returns the card after 3 other cards', () => {
    const { s } = run(createSession(ids(8), []), [1]);
    expect(s.queue.indexOf('c1')).toBe(3);
  });

  it('repeated Again shows the card more often (gap 3 -> 2 -> 1)', () => {
    let s = createSession(ids(10), []);
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      s = rate(s, 1, `e${i}`).session;
      gaps.push(s.queue.indexOf('c1'));
      // bring c1 back to the front without touching its progress
      s = { ...s, queue: ['c1', ...s.queue.filter((x) => x !== 'c1')] };
    }
    expect(gaps).toEqual([3, 2, 1]);
  });

  it('clean review card rated Good is done and commits Good', () => {
    const { s, commit } = run(createSession(ids(3), []), [3]);
    expect(s.queue).not.toContain('c1');
    expect(s.done).toEqual(['c1']);
    expect(commit).toBe(3);
  });

  it('new card needs two Goods: returns after 10 others, not committed until second', () => {
    const init = createSession(ids(12), ['c1']);
    const a = rate(init, 3, 'e1');
    expect(a.commit).toBeNull();
    expect(a.session.queue.indexOf('c1')).toBe(10);
    const b = rate({ ...a.session, queue: ['c1', ...a.session.queue.filter((x) => x !== 'c1')] }, 3, 'e2');
    expect(b.commit).toBe(3);
    expect(b.session.done).toContain('c1');
  });

  it('commits the WORST grade of the cycle (Again then Good, Good => Again)', () => {
    let s = createSession(['c1'], []);
    const grades: (1 | 3)[] = [1, 3, 3];
    let commit: number | null = null;
    grades.forEach((g, i) => { const r = rate(s, g, `e${i}`); s = r.session; commit = r.commit; });
    expect(commit).toBe(1);
    expect(isFinished(s)).toBe(true);
  });

  it('Hard returns after 5 cards and needs one Good', () => {
    const a = rate(createSession(ids(8), []), 2, 'e1');
    expect(a.session.queue.indexOf('c1')).toBe(5);
    expect(a.commit).toBeNull();
    const b = rate({ ...a.session, queue: ['c1', ...a.session.queue.filter((x) => x !== 'c1')] }, 3, 'e2');
    expect(b.commit).toBe(2);
  });

  it('Easy finishes immediately', () => {
    const r = rate(createSession(ids(4), ['c1']), 4, 'e1');
    expect(r.commit).toBe(4);
    expect(r.session.queue).not.toContain('c1');
  });

  it('small decks: a lone card rated Again comes straight back and the session still terminates', () => {
    let s = createSession(['c1'], []);
    s = rate(s, 1, 'e1').session;
    expect(currentCardId(s)).toBe('c1');
    s = rate(s, 3, 'e2').session;
    s = rate(s, 3, 'e3').session;
    expect(isFinished(s)).toBe(true);
  });

  it('two-card deck: gap is clamped to the queue length', () => {
    const s = rate(createSession(['a', 'b'], []), 1, 'e1').session;
    expect(s.queue).toEqual(['b', 'a']);
  });

  it('undo restores queue, progress and history exactly', () => {
    const init = createSession(ids(6), ['c1']);
    const r = rate(init, 1, 'e1');
    const u = undo(r.session)!;
    expect(u.session.queue).toEqual(init.queue);
    expect(u.session.progress).toEqual({});
    expect(u.session.done).toEqual([]);
    expect(u.step.eventId).toBe('e1');
    expect(undo(u.session)).toBeNull();
  });

  it('undo of a finishing rating reports the commit so storage can be reverted', () => {
    const r = rate(createSession(ids(3), []), 3, 'e1');
    expect(undo(r.session)!.step.commit).toBe(3);
  });

  it('is deterministic', () => {
    const f = () => run(createSession(ids(9), ['c2']), [1, 3, 2, 4, 3]).s;
    expect(f()).toEqual(f());
  });

  it('never mutates the previous session', () => {
    const init = createSession(ids(5), []);
    const copy = JSON.stringify(init);
    rate(init, 1, 'e1');
    expect(JSON.stringify(init)).toBe(copy);
  });
});
