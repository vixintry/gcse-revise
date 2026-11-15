import { describe, expect, it } from 'vitest';
import { accuracyByDay, countCards, deckAccuracy, estimatedRetention, recommend, upcomingWorkload } from '@/lib/stats';
import type { CardRec, ReviewRec } from '@/lib/db';
import { newFsrsCard, scheduleCard } from '@/lib/scheduler/fsrs';
import { days, T0 } from './helpers';

const rec = (id: string, f = newFsrsCard(T0)): CardRec => ({ id, deckId: 'd', front: 'f', back: 'b', createdAt: 0, updatedAt: 0, fsrs: f, due: f.due.getTime() });
const rev = (id: string, ts: number, rating: 1 | 2 | 3 | 4, attempt = 1): ReviewRec => ({ id, cardId: 'c', deckId: 'd', sessionId: 's', attempt, rating, ts, committed: false });

describe('stats', () => {
  it('counts new / learning / young / mature / due', () => {
    const young = scheduleCard(newFsrsCard(T0), 3, T0);
    let mature = newFsrsCard(T0);
    for (let i = 0; i < 6; i++) mature = scheduleCard(mature, 4, new Date(mature.due.getTime()));
    const c = countCards([rec('n'), rec('y', young), rec('m', mature)], days(0.5));
    expect(c).toMatchObject({ total: 3, new: 1 });
    expect(c.young + c.mature + c.learning).toBe(2);
    expect(c.mature).toBe(1);
  });

  it('workload puts overdue cards in today and future cards on their day', () => {
    const f = scheduleCard(newFsrsCard(days(-30)), 3, days(-30));
    const w = upcomingWorkload([rec('over', f), rec('new')], T0, 7);
    expect(w[0]).toBe(1);
    expect(w.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('accuracy counts only first attempts, and Hard counts as recalled', () => {
    const out = accuracyByDay([rev('a', T0.getTime(), 1), rev('b', T0.getTime(), 2), rev('c', T0.getTime(), 3), rev('d', T0.getTime(), 1, 2)], T0, 3);
    expect(out[2]).toMatchObject({ attempts: 3, passed: 2 });
  });

  it('deck accuracy hides decks with too little data', () => {
    const revs = Array.from({ length: 12 }, (_, i) => rev(`r${i}`, T0.getTime(), i < 6 ? 1 : 3));
    expect(deckAccuracy(revs, 0, 10).get('d')).toEqual({ attempts: 12, rate: 0.5 });
    expect(deckAccuracy(revs.slice(0, 5), 0, 10).size).toBe(0);
  });

  it('retention estimate is null with no reviewed cards', () => {
    expect(estimatedRetention([rec('n')], T0)).toBeNull();
    expect(estimatedRetention([rec('y', scheduleCard(newFsrsCard(T0), 3, T0))], T0)).toBeGreaterThan(0.9);
  });

  it('recommendations follow the data', () => {
    const counts = { total: 10, new: 4, learning: 0, young: 3, mature: 0, due: 3 };
    expect(recommend({ counts, weakDecks: [] })[0]).toMatch(/3 due cards/);
    expect(recommend({ counts: { ...counts, due: 0 }, weakDecks: [{ name: 'Maths', rate: 0.5, attempts: 20 }] }).join(' ')).toMatch(/Maths.*50%/);
    expect(recommend({ counts: { ...counts, total: 0, new: 0, due: 0 }, weakDecks: [] })[0]).toMatch(/Create a deck/);
  });
});
