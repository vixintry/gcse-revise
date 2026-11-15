import katex from 'katex';
import { z } from 'zod';
import { splitMath } from '../math';

export const LIMITS = { frontMin: 12, frontMax: 300, backMax: 600, quoteMax: 300 };

const RawCard = z.object({
  front: z.string(),
  back: z.string(),
  source_quote: z.string().default(''),
  topic: z.string().default(''),
});

export interface CandidateCard {
  front: string;
  back: string;
  sourceQuote: string;
  topic: string;
  /** false = the quote could not be found in the user's text. Treat as unverified. */
  supported: boolean;
  warnings: string[];
}
export interface Rejected { reason: string; front?: string }

export const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const tokens = (s: string) => new Set(normalise(s).split(' ').filter((w) => w.length > 2));

export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function isDuplicate(front: string, others: string[], threshold = 0.8): boolean {
  const n = normalise(front);
  return others.some((o) => normalise(o) === n || similarity(o, front) >= threshold);
}

/** Returns an error message if the text contains broken maths, otherwise null. */
export function checkMaths(text: string): string | null {
  let stripped = '';
  for (const seg of splitMath(text)) {
    if (seg.type === 'text') { stripped += seg.value; continue; }
    try { katex.renderToString(seg.value, { throwOnError: true, displayMode: seg.type === 'display' }); }
    catch { return `Could not parse maths: ${seg.value.slice(0, 40)}`; }
  }
  return stripped.includes('$') ? 'Unbalanced $ in text' : null;
}

export function validateCards(rawCards: unknown[], source: string): { cards: CandidateCard[]; rejected: Rejected[] } {
  const cards: CandidateCard[] = [];
  const rejected: Rejected[] = [];
  const normSource = normalise(source);

  for (const raw of rawCards) {
    const parsed = RawCard.safeParse(raw);
    if (!parsed.success) { rejected.push({ reason: 'Missing or invalid fields' }); continue; }
    const front = parsed.data.front.trim();
    const back = parsed.data.back.trim();
    const quote = parsed.data.source_quote.trim();

    if (!front || !back) { rejected.push({ reason: 'Empty question or answer', front }); continue; }
    if (front.length < LIMITS.frontMin || front.split(/\s+/).length < 3) { rejected.push({ reason: 'Question too short to be unambiguous', front }); continue; }
    if (front.length > LIMITS.frontMax) { rejected.push({ reason: 'Question too long', front: front.slice(0, 60) }); continue; }
    if (back.length > LIMITS.backMax) { rejected.push({ reason: 'Answer too long: split into smaller cards', front }); continue; }
    if (/^(true or false|which of the following)/i.test(front)) { rejected.push({ reason: 'Recognition-style question, not active recall', front }); continue; }
    if (normalise(front) === normalise(back)) { rejected.push({ reason: 'Answer repeats the question', front }); continue; }
    const mathErr = checkMaths(front) ?? checkMaths(back);
    if (mathErr) { rejected.push({ reason: mathErr, front }); continue; }
    if (isDuplicate(front, cards.map((c) => c.front))) { rejected.push({ reason: 'Duplicate of another generated card', front }); continue; }

    const warnings: string[] = [];
    const nq = normalise(quote);
    const supported = nq.length >= 8 && normSource.includes(nq);
    if (!supported) warnings.push(quote ? 'Source quote not found in your text. Check this card against your notes.' : 'No source quote given. Check this card against your notes.');
    cards.push({ front, back, topic: parsed.data.topic.trim().slice(0, 60), sourceQuote: quote.slice(0, LIMITS.quoteMax), supported, warnings });
  }
  return { cards, rejected };
}
