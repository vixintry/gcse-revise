import type { Card } from 'ts-fsrs';
import { newFsrsCard, scheduleCard, type Grade } from '@/lib/scheduler/fsrs';
import type { QueueCard } from '@/lib/scheduler/session';

export const T0 = new Date('2026-11-14T10:00:00Z');
export const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

export function newCard(id: string, deckId = 'd1', createdAt = 0): QueueCard {
  return { id, deckId, createdAt, fsrs: newFsrsCard(T0) };
}
/** A card that was reviewed `agoDays` ago with the given grades. */
export function reviewed(id: string, deckId: string, agoDays: number, grades: Grade[] = [3]): QueueCard {
  let f: Card = newFsrsCard(days(-agoDays));
  grades.forEach((g, i) => { f = scheduleCard(f, g, days(-agoDays + i * 0.01)); });
  return { id, deckId, createdAt: 0, fsrs: f };
}
export const ids = (n: number, p = 'c') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
