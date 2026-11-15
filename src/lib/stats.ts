import { retrievability, State } from './scheduler/fsrs';
import type { CardRec, ReviewRec } from './db';

export const DAY = 86_400_000;
export const MATURE_DAYS = 21; // Anki convention: interval >= 21 days

export function countCards(cards: CardRec[], now: Date) {
  let nw = 0, learning = 0, young = 0, mature = 0, due = 0;
  for (const c of cards) {
    const f = c.fsrs;
    if (f.state === State.New) { nw++; continue; }
    if (f.due.getTime() <= now.getTime()) due++;
    if (f.state === State.Learning || f.state === State.Relearning) learning++;
    else if (f.scheduled_days >= MATURE_DAYS) mature++;
    else young++;
  }
  return { total: cards.length, new: nw, learning, young, mature, due };
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Reviews due per day for the next `days` days. Day 0 includes anything overdue. */
export function upcomingWorkload(cards: CardRec[], now: Date, days = 7): number[] {
  const out = new Array<number>(days).fill(0);
  const today = startOfDay(now);
  for (const c of cards) {
    if (c.fsrs.state === State.New) continue;
    const idx = Math.floor((startOfDay(c.fsrs.due) - today) / DAY);
    if (idx < days) out[Math.max(0, idx)]++;
  }
  return out;
}

export interface DayAccuracy { date: string; attempts: number; passed: number }

/** MEASURED: first-time recall in each session; Hard/Good/Easy count as recalled. */
export function accuracyByDay(reviews: ReviewRec[], now: Date, days = 14): DayAccuracy[] {
  const today = startOfDay(now);
  const out: DayAccuracy[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today - i * DAY);
    out.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, attempts: 0, passed: 0 });
  }
  for (const r of reviews) {
    if (r.attempt !== 1) continue;
    const idx = days - 1 - Math.floor((today - startOfDay(new Date(r.ts))) / DAY);
    if (idx < 0 || idx >= days) continue;
    out[idx].attempts++;
    if (r.rating >= 2) out[idx].passed++;
  }
  return out;
}

export function deckAccuracy(reviews: ReviewRec[], since: number, minAttempts = 10): Map<string, { attempts: number; rate: number }> {
  const agg = new Map<string, { n: number; ok: number }>();
  for (const r of reviews) {
    if (r.attempt !== 1 || r.ts < since) continue;
    const a = agg.get(r.deckId) ?? { n: 0, ok: 0 };
    a.n++; if (r.rating >= 2) a.ok++;
    agg.set(r.deckId, a);
  }
  const out = new Map<string, { attempts: number; rate: number }>();
  for (const [k, a] of agg) if (a.n >= minAttempts) out.set(k, { attempts: a.n, rate: a.ok / a.n });
  return out;
}

/** ESTIMATED: mean FSRS recall probability across reviewed cards. A model output, not a measurement. */
export function estimatedRetention(cards: CardRec[], now: Date): number | null {
  const seen = cards.filter((c) => c.fsrs.state !== State.New);
  if (!seen.length) return null;
  return seen.reduce((s, c) => s + retrievability(c.fsrs, now), 0) / seen.length;
}

export function recommend(input: {
  counts: ReturnType<typeof countCards>;
  weakDecks: { name: string; rate: number; attempts: number }[];
}): string[] {
  const { counts, weakDecks } = input;
  const out: string[] = [];
  if (counts.due > 0) out.push(`Clear your ${counts.due} due card${counts.due === 1 ? '' : 's'} first. Overdue cards are the ones you are most likely to have forgotten.`);
  for (const d of weakDecks.slice(0, 2)) out.push(`${d.name}: you recalled ${Math.round(d.rate * 100)}% first time over ${d.attempts} reviews in the last 30 days. Run a weak-cards session.`);
  if (counts.due === 0 && counts.new > 0) out.push(`Nothing due. Learn up to 10 of your ${counts.new} new cards.`);
  if (counts.total === 0) out.push('Create a deck and add cards, or generate them from your notes.');
  if (!out.length) out.push('You are caught up. Come back when cards fall due.');
  return out;
}
