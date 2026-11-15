import type { CardRec, Evidence, Memory, Misconception, ReviewRec } from '../db';

/**
 * Misconception detection from REAL review history. Pure and deterministic: no AI, no clock.
 * The AI is only asked to explain a pattern this module has already found in the data.
 *
 * A topic is flagged only when ALL of these hold over the last 30 days (first attempts only):
 *   >= 3 different cards were forgotten (rated Again), on >= 2 different days,
 *   with >= 5 reviews in the topic and a forget rate >= 40%.
 * One wrong answer, or a burst of errors in a single sitting, is never enough.
 */
export const RULES = { windowDays: 30, minCards: 3, minDays: 2, minAttempts: 5, minFailRate: 0.4, resolveAttempts: 6, resolveCards: 3, resolveDays: 2, resolveRate: 0.8 };
const DAY = 86_400_000;

export const normTopic = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();
export const miscId = (deckId: string, topic: string): string => `mc:${deckId}:${normTopic(topic)}`;

interface Attempt { ts: number; cardId: string; rating: number }
export interface TopicStats {
  id: string; deckId: string; topic: string;
  attempts: Attempt[]; failed: number; failedCardIds: string[]; failDays: number;
  firstFailure: number; lastFailure: number; rate: number;
}

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function computeStats(
  cards: CardRec[], reviews: ReviewRec[], deckNames: Record<string, string>, now: Date,
  since: Record<string, number> = {},
): Map<string, TopicStats> {
  const byCard = new Map(cards.map((c) => [c.id, c]));
  const out = new Map<string, TopicStats>();
  const from = now.getTime() - RULES.windowDays * DAY;
  for (const r of [...reviews].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))) {
    if (r.attempt !== 1 || r.ts < from || r.ts > now.getTime()) continue;
    const card = byCard.get(r.cardId);
    if (!card) continue;
    const topic = card.topic?.trim() || deckNames[card.deckId] || 'Untitled deck';
    const id = miscId(card.deckId, topic);
    if (since[id] !== undefined && r.ts <= since[id]) continue;
    const s = out.get(id) ?? { id, deckId: card.deckId, topic, attempts: [], failed: 0, failedCardIds: [], failDays: 0, firstFailure: 0, lastFailure: 0, rate: 0 };
    s.attempts.push({ ts: r.ts, cardId: r.cardId, rating: r.rating });
    out.set(id, s);
  }
  for (const s of out.values()) {
    const fails = s.attempts.filter((a) => a.rating === 1);
    s.failed = fails.length;
    s.failedCardIds = [...new Set(fails.map((a) => a.cardId))].sort();
    s.failDays = new Set(fails.map((a) => dayKey(a.ts))).size;
    s.firstFailure = fails[0]?.ts ?? 0;
    s.lastFailure = fails[fails.length - 1]?.ts ?? 0;
    s.rate = s.attempts.length ? s.failed / s.attempts.length : 0;
  }
  return out;
}

export const isRecurring = (s: TopicStats): boolean =>
  s.failedCardIds.length >= RULES.minCards && s.failDays >= RULES.minDays &&
  s.attempts.length >= RULES.minAttempts && s.rate >= RULES.minFailRate;

export function confidenceOf(s: TopicStats): Misconception['confidence'] {
  if (s.failedCardIds.length >= 5 && s.failDays >= 3 && s.rate >= 0.5) return 'high';
  if (s.failedCardIds.length >= 4 || s.failDays >= 3) return 'medium';
  return 'low';
}

const evidenceOf = (s: TopicStats): Evidence => ({
  cardIds: s.failedCardIds, failed: s.failed, attempts: s.attempts.length, failDays: s.failDays,
  firstSeen: s.firstFailure, lastSeen: s.lastFailure,
});

/** Resolved only by later performance: enough clean recalls AFTER the last failure. */
export function meetsResolution(s: TopicStats): boolean {
  const after = s.attempts.filter((a) => a.ts > s.lastFailure);
  if (after.length < RULES.resolveAttempts) return false;
  if (new Set(after.map((a) => a.cardId)).size < RULES.resolveCards) return false;
  if (new Set(after.map((a) => dayKey(a.ts))).size < RULES.resolveDays) return false;
  return after.filter((a) => a.rating >= 3).length / after.length >= RULES.resolveRate;
}

/** Returns only the records that need to be written. Safe to run repeatedly. */
export function reconcile(
  existing: Misconception[], cards: CardRec[], reviews: ReviewRec[], deckNames: Record<string, string>, now: Date,
): Misconception[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const since: Record<string, number> = {};
  for (const m of existing) if (m.status === 'resolved' && m.resolvedAt) since[m.id] = m.resolvedAt;
  const stats = computeStats(cards, reviews, deckNames, now, since);
  const t = now.getTime();
  const changed: Misconception[] = [];

  for (const s of stats.values()) {
    const m = byId.get(s.id);
    if (m?.status === 'dismissed') continue; // the student said this is wrong: respect it
    if (isRecurring(s)) {
      if (!m || m.status === 'resolved') {
        changed.push({
          id: s.id, deckId: s.deckId, topic: s.topic, status: 'suspected', confidence: confidenceOf(s), evidence: evidenceOf(s),
          reopenCount: m ? m.reopenCount + 1 : 0, createdAt: m?.createdAt ?? t, updatedAt: t,
        });
      } else {
        const next = { ...m, confidence: confidenceOf(s), evidence: evidenceOf(s) };
        if (JSON.stringify(next) !== JSON.stringify(m)) changed.push({ ...next, updatedAt: t });
      }
    } else if (m && (m.status === 'suspected' || m.status === 'confirmed') && meetsResolution(s)) {
      changed.push({ ...m, status: 'resolved', resolvedAt: t, updatedAt: t, evidence: { ...m.evidence, lastSeen: s.lastFailure || m.evidence.lastSeen } });
    }
  }
  return changed;
}

// ---------------- learning memory (derived, then user-correctable) ----------------

const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function memoryText(m: Misconception): string | null {
  if (m.status === 'dismissed') return null;
  if (m.status === 'resolved') return `Previously struggled with "${m.topic}" but recalled it consistently afterwards (resolved ${fmt(m.resolvedAt ?? m.updatedAt)}). Do not assume it is still a weakness.`;
  const gap = m.diagnosis?.gap ? ` Suspected gap: ${m.diagnosis.gap}` : '';
  return `Forgot ${m.evidence.failed} of ${m.evidence.attempts} first-time reviews in "${m.topic}" (last ${fmt(m.evidence.lastSeen)}).${gap} This is a pattern in the data, not a certainty.`.slice(0, 300);
}

/** What to write/delete so memories track misconceptions. Never overwrites text the student edited. */
export function deriveMemories(misc: Misconception[], memories: Memory[], now: Date): { put: Memory[]; remove: string[] } {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const put: Memory[] = [], remove: string[] = [];
  for (const m of misc) {
    const id = `mem:${m.id}`, cur = byId.get(id), text = memoryText(m);
    if (text === null) { if (cur && !cur.userEdited) remove.push(id); continue; }
    if (cur?.userEdited) continue;
    if (cur?.text === text) continue;
    put.push({ id, topic: m.topic, text, source: 'auto', createdAt: cur?.createdAt ?? now.getTime(), updatedAt: now.getTime() });
  }
  return { put, remove };
}

/** Up to `limit` notes relevant to a card, newest first. Keeps tutor prompts small. */
export function relevantMemories(memories: Memory[], topic: string | undefined, deckName: string | undefined, limit = 3): string[] {
  const keys = [topic, deckName].filter((x): x is string => !!x).map(normTopic);
  return memories
    .filter((m) => keys.includes(normTopic(m.topic)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((m) => m.text.slice(0, 300));
}
