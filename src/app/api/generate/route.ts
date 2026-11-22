import { z } from 'zod';
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/ai/client';
import { generateCards, SOURCE_MAX } from '@/lib/ai/generate';
import { fail, handleError, readBody } from '@/lib/ai/http';

export const runtime = 'nodejs';

const Body = z.object({
  source: z.string().max(SOURCE_MAX + 1000),
  subject: z.string().max(60).default(''),
  examBoard: z.string().max(40).default(''),
  difficulty: z.enum(['auto', 'easy', 'medium', 'hard']).default('auto'),
  detail: z.enum(['auto', 'concise', 'detailed']).default('auto'),
  count: z.union([z.literal('auto'), z.number().int().min(3).max(30)]).default('auto'),
});

export async function POST(req: Request) {
  const raw = await readBody(req);
  if (raw instanceof Response) return raw;
  const body = Body.safeParse(raw);
  if (!body.success) return fail('invalid_input', 'Check the text, card count and options.');
  try {
    const { source, ...opts } = body.data;
    return NextResponse.json(await generateCards(source, opts, loadConfig()));
  } catch (e) { return handleError(e); }
}
