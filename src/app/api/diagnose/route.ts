import { z } from 'zod';
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/ai/client';
import { diagnose } from '@/lib/ai/diagnose';
import { fail, handleError, readBody } from '@/lib/ai/http';

export const runtime = 'nodejs';

const Body = z.object({
  topic: z.string().min(1).max(80),
  subject: z.string().max(60).optional(),
  examBoard: z.string().max(40).optional(),
  failedCards: z.array(z.object({ front: z.string().max(400), back: z.string().max(700) })).min(2).max(8),
  stats: z.object({ failed: z.number().int().min(0), attempts: z.number().int().min(0), failDays: z.number().int().min(0) }),
});

export async function POST(req: Request) {
  const raw = await readBody(req);
  if (raw instanceof Response) return raw;
  const body = Body.safeParse(raw);
  if (!body.success) return fail('invalid_input', 'Invalid request.');
  try { return NextResponse.json(await diagnose(body.data, loadConfig())); }
  catch (e) { return handleError(e); }
}
