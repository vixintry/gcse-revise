export type AIErrorCode = 'not_configured' | 'timeout' | 'rate_limited' | 'network' | 'upstream' | 'bad_output' | 'invalid_input';

export class AIError extends Error {
  constructor(public code: AIErrorCode, message: string, public retryable = false) {
    super(message);
    this.name = 'AIError';
  }
}

export interface AIConfig { apiKey?: string; model: string; baseUrl: string; timeoutMs: number; maxRetries: number }
export interface Deps { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }
export const realDeps: Deps = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export function loadConfig(env: Record<string, string | undefined> = process.env): AIConfig {
  return {
    apiKey: env.OPENAI_API_KEY || undefined,
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    timeoutMs: 45_000,
    maxRetries: 2,
  };
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatResult { content: string; finishReason: string }

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;

/** One chat-completions call with bounded exponential backoff on transient failures. */
export async function chat(
  req: { messages: ChatMessage[]; responseFormat?: unknown; temperature?: number },
  config: AIConfig,
  deps: Deps = realDeps,
): Promise<ChatResult> {
  if (!config.apiKey) throw new AIError('not_configured', 'AI is not configured. Add OPENAI_API_KEY to .env.local. Revision still works without it.');
  let last: AIError = new AIError('upstream', 'Unknown AI error');

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    let waitMs = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
    try {
      const res = await deps.fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.2,
          ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
        }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
        const choice = data.choices?.[0];
        if (!choice?.message?.content) throw new AIError('bad_output', 'The AI returned an empty response');
        return { content: choice.message.content, finishReason: choice.finish_reason ?? 'stop' };
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(ra * 1000, BACKOFF_CAP_MS);
        last = new AIError('rate_limited', 'The AI service is rate limiting requests. Try again shortly.', true);
      } else if (res.status >= 500) {
        last = new AIError('upstream', `The AI service had a problem (${res.status}).`, true);
      } else {
        throw new AIError('upstream', `The AI request was rejected (${res.status}). Check your API key and model name.`);
      }
    } catch (e) {
      if (e instanceof AIError) { if (!e.retryable) throw e; last = e; }
      else if (e instanceof Error && e.name === 'AbortError') last = new AIError('timeout', 'The AI took too long to respond.', true);
      else last = new AIError('network', 'Could not reach the AI service.', true);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < config.maxRetries) await deps.sleep(waitMs);
  }
  throw last;
}
