import { createEmptyCard, fsrs, generatorParameters, State, type Card, type Grade as FsrsGrade } from 'ts-fsrs';

export type Grade = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export { State };
export type { Card };

// Deterministic: fuzz off. Short-term steps are off because the session queue
// (session.ts) handles within-session reinforcement; FSRS handles days+.
const engine = fsrs(
  generatorParameters({ enable_fuzz: false, enable_short_term: false, request_retention: 0.9 }),
);

export function newFsrsCard(now: Date): Card {
  return createEmptyCard(now);
}

export function scheduleCard(card: Card, grade: Grade, now: Date): Card {
  return engine.next(card, now, grade as FsrsGrade).card;
}

/** Probability of recall right now (0..1). New cards have none: returns 0. */
export function retrievability(card: Card, now: Date): number {
  if (card.state === State.New) return 0;
  return engine.get_retrievability(card, now, false);
}
