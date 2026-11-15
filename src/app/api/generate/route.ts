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
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  detail: z.enum(['concise', 'detailed']).default('concise'),
  count: z.number().int().min(3).max(30).default(12),
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
