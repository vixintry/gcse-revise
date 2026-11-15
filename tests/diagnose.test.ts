import { describe, expect, it, vi } from 'vitest';
import { diagnose, type DiagnoseInput } from '@/lib/ai/diagnose';
import { tutor } from '@/lib/ai/tutor';
import type { AIConfig, Deps } from '@/lib/ai/client';

const config: AIConfig = { apiKey: 'k', model: 'm', baseUrl: 'http://x/v1', timeoutMs: 50, maxRetries: 1 };
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
const mock = (...r: Response[]) => {
  const q = [...r];
  const fetchMock = vi.fn(async () => q.shift() ?? new Response('{}', { status: 500 }));
  return { fetchMock, d: { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} } as Deps };
};
const input: DiagnoseInput = {
  topic: 'water balance', subject: 'Biology',
  failedCards: [{ front: 'What does ADH do?', back: 'Makes the kidney reabsorb more water' }, { front: 'Why does urine become concentrated when dehydrated?', back: 'More ADH is released' }, { front: 'What is osmosis?', back: 'Movement of water across a partially permeable membrane' }],
  stats: { failed: 3, attempts: 6, failDays: 2 },
};
const good = {
  gap: 'May not see ADH as part of a negative feedback loop that restores water balance',
  explanation: 'When blood is too concentrated, ADH is released and the kidneys reabsorb water.',
  diagnostic_question: 'What happens to ADH release when you drink a lot of water?',
  diagnostic_answer: 'Less ADH is released so more water is lost in urine',
  targeted_cards: [
    { front: 'What happens to ADH release after drinking a lot of water?', back: 'It decreases', source_quote: 'More ADH is released', topic: '' },
    { front: 'Why is ADH release an example of negative feedback?', back: 'It reverses a change in water level', source_quote: 'made up quote not in cards', topic: 'negative feedback' },
  ],
};

describe('diagnose', () => {
  it('returns the explanation, a diagnostic question and cards that need review', async () => {
    const { d } = mock(ok(JSON.stringify(good)));
    const r = await diagnose(input, config, d);
    expect(r.sharedGap).toBe(true);
    expect(r.question).toMatch(/drink a lot of water/);
    expect(r.cards).toHaveLength(2);
    expect(r.cards[0].topic).toBe('water balance');
    expect(r.cards[0].supported).toBe(true);
    expect(r.cards[1].supported).toBe(false);
  });

  it('when the AI finds no shared concept it says so instead of inventing a weakness', async () => {
    const { d } = mock(ok(JSON.stringify({ ...good, gap: '', targeted_cards: [] })));
    const r = await diagnose(input, config, d);
    expect(r.sharedGap).toBe(false);
    expect(r.cards).toEqual([]);
  });

  it('puts the forgotten cards in data tags and tells the model not to invent weaknesses', async () => {
    const { d, fetchMock } = mock(ok(JSON.stringify(good)));
    await diagnose(input, config, d);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toMatch(/<cards>[\s\S]*What does ADH do[\s\S]*<\/cards>/);
    expect(body.messages[0].content).toMatch(/Never invent a weakness/);
  });

  it('repairs invalid output once, then fails honestly', async () => {
    const a = mock(ok('not json'), ok(JSON.stringify(good)));
    expect((await diagnose(input, config, a.d)).sharedGap).toBe(true);
    expect(a.fetchMock).toHaveBeenCalledTimes(2);
    const b = mock(ok('nope'), ok('{"gap": 1}'));
    await expect(diagnose(input, config, b.d)).rejects.toMatchObject({ code: 'bad_output' });
  });

  it('needs an API key and at least two forgotten cards, and makes no request otherwise', async () => {
    const { d, fetchMock } = mock();
    await expect(diagnose(input, { ...config, apiKey: undefined }, d)).rejects.toMatchObject({ code: 'not_configured' });
    await expect(diagnose({ ...input, failedCards: [input.failedCards[0]] }, config, d)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tutor uses saved learning notes', () => {
  const card = { front: 'What does ADH do?', back: 'Makes the kidney reabsorb water' };
  it('includes at most 3 notes, labelled as possibly outdated', async () => {
    const { d, fetchMock } = mock(ok('hint'));
    await tutor({ mode: 'hint', ...card, learningContext: ['n1', 'n2', 'n3', 'n4'] }, config, d);
    const sys = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[0].content as string;
    expect(sys).toMatch(/may be outdated or wrong/);
    expect(sys).toMatch(/- n3/);
    expect(sys).not.toMatch(/n4/);
  });
  it('adds nothing when there are no notes', async () => {
    const { d, fetchMock } = mock(ok('hint'));
    await tutor({ mode: 'hint', ...card }, config, d);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[0].content).not.toMatch(/revision history/);
  });
});
