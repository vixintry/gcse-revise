import { NextResponse } from 'next/server';
import { AIError } from './client';
import { makeLimiter } from '../rateLimit';

export const limiter = makeLimiter(30, 10 * 60_000);
const MAX_BODY = 120_000;

const STATUS: Record<string, number> = {
  not_configured: 503, rate_limited: 429, timeout: 504, network: 502, upstream: 502, bad_output: 502, invalid_input: 400,
};

export const fail = (code: string, message: string, status?: number) =>
  NextResponse.json({ error: { code, message } }, { status: status ?? STATUS[code] ?? 500 });

export async function readBody(req: Request): Promise<unknown | Response> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!limiter(ip)) return fail('rate_limited', 'Too many AI requests. Wait a few minutes.');
  const text = await req.text();
  if (text.length > MAX_BODY) return fail('invalid_input', 'Request is too large.', 413);
  try { return JSON.parse(text); } catch { return fail('invalid_input', 'Request body must be JSON.'); }
}

export function handleError(e: unknown) {
  if (e instanceof AIError) return fail(e.code, e.message);
  // Log only the error name: never the student's text or any key.
  console.error('AI route error:', e instanceof Error ? e.name : 'unknown');
  return fail('upstream', 'Something went wrong. Revision still works. Try again later.', 500);
}
