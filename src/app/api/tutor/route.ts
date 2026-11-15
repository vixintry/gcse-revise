import { z } from 'zod';
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/ai/client';
import { tutor } from '@/lib/ai/tutor';
import { fail, handleError, readBody } from '@/lib/ai/http';

export const runtime = 'nodejs';

const Body = z.object({
  mode: z.enum(['hint', 'explain', 'ask', 'check']),
  front: z.string().min(1).max(1000),
  back: z.string().min(1).max(2000),
  subject: z.string().max(60).optional(),
  examBoard: z.string().max(40).optional(),
  userAnswer: z.string().max(1000).optional(),
  question: z.string().max(1000).optional(),
  learningContext: z.array(z.string().max(300)).max(3).optional(),
});

export async function POST(req: Request) {
  const raw = await readBody(req);
  if (raw instanceof Response) return raw;
  const body = Body.safeParse(raw);
  if (!body.success) return fail('invalid_input', 'Invalid request.');
  try { return NextResponse.json(await tutor(body.data, loadConfig())); }
  catch (e) { return handleError(e); }
}
