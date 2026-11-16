# Retain: adaptive GCSE revision (Phases 1-3, local-first)

Local-first flashcard app. Cards, schedules and review history live in your browser's IndexedDB. AI is optional and only runs through server routes that keep your API key off the client.

## Run it
```bash
npm install                  # then commit the generated package-lock.json
cp .env.example .env.local   # optional: add OPENAI_API_KEY for AI features
npm run dev                  # http://localhost:3000
npm test                     # 97 unit/integration tests
npm run typecheck && npm run build
```
Revision, scheduling and card management work with no API key at all.

### Getting an API key
Create one at https://platform.openai.com/api-keys, put it in `.env.local` as `OPENAI_API_KEY`. `OPENAI_MODEL` and `OPENAI_BASE_URL` can point at any OpenAI-compatible chat-completions provider that supports JSON-schema output. Never commit `.env.local`.

## How scheduling works
- **Long term:** `ts-fsrs` (FSRS), fuzz off so it is deterministic, 90% target retention.
- **Within a session** (`src/lib/scheduler/session.ts`, pure, no network/clock):
  - Again: back after 3 other cards, then 2, then 1 if you keep missing it. Needs two good recalls in a row.
  - Hard: back after 5 cards, needs one Good.
  - Good: a clean review card is done for the session. A new or struggled card returns after 10 cards and must be recalled again.
  - Easy: done.
  - When a card leaves the queue ONE grade goes to FSRS: the worst grade of that cycle.
- Every rating is stored as a review event with a client-generated id. Writing the same id twice is a no-op. Undo reverses both the session and the stored schedule.
- This deliberately differs from the "correct = back after ~10 cards" idea in the spec: re-showing a card you got right first time adds little, so only new/struggling cards are re-shown within a session.

## Misconception detection and learning notes
- **Detection is not AI.** `src/lib/learning/misconceptions.ts` looks at your real first-attempt reviews from the last 30 days. A topic (the card's topic label, or its deck name) is flagged only if you forgot >= 3 different cards on >= 2 different days, with >= 5 reviews and a >= 40% forget rate. One wrong answer or one bad sitting never flags anything.
- Each flag carries its evidence and a low/medium/high confidence. You can dismiss it; dismissed patterns are never re-flagged unless you choose "Track again".
- **Resolved** only by later performance: >= 6 reviews after your last miss, across >= 3 cards and >= 2 days, with >= 80% recalled Good/Easy. If you start forgetting the topic again afterwards, it reopens (counting only reviews after the resolution).
- The AI is only asked to explain a pattern already found in your data. If the forgotten cards do not plausibly share one concept it says so, and the app shows that instead of inventing a weakness. Suggested practice cards are always marked unverified.
- **Learning notes** (`/memory`): short notes derived from the evidence ("Forgot 3 of 5 ... a pattern in the data, not a certainty"; resolved ones say not to assume it is still a weakness). You can edit, delete or add notes. Your edits are never overwritten. Deleting an automatic note also dismisses the pattern behind it. The tutor receives at most 3 relevant notes per request, labelled as possibly outdated.
- Cards get a topic label (typed by you, or suggested by the AI during generation). Without topics, the deck name is the grouping, which is coarse.

## AI safety and honesty
- Pasted text is wrapped as untrusted data; the model is told never to follow instructions inside it.
- Every card needs a verbatim `source_quote`. If it is not found in your text the card is flagged "Unverified", never hidden or silently trusted.
- Output is schema-validated; malformed output gets ONE repair attempt, then an error. Cards are never fabricated.
- Retries: max 2, exponential backoff (0.5s, 1s), Retry-After honoured (capped 8s), 45s timeout.
- AI feedback is visibly labelled and never changes your rating.
- Nothing is claimed to match a specification or exam board.

## NOT built (be aware)
- Accounts, Supabase/Postgres, cross-device sync, conflict resolution, row-level security, migrations
- PDF, DOCX, PPTX and image upload / OCR (only pasted text and .txt/.md files)
- Cross-device memory (notes and patterns are stored on this device only)
- Topic grouping is by label or deck, not by semantic similarity between cards
- Service worker / installable offline PWA (data is local, but the page itself needs to be loaded once)
- End-to-end browser tests; Tailwind (plain CSS is used instead); deployment config
- API routes have no authentication, only a per-instance in-memory rate limit. Run locally, do not expose publicly.

## Known notes
- `npm audit` flags a PostCSS advisory bundled inside Next 15 (build-time CSS processing; this app only processes its own CSS). Upgrading to Next 16 fixes it but was not attempted.
- TypeScript is pinned to 6.0.3 because Next 15 does not support TypeScript 7. Dependency versions are pinned exactly in `package.json`.
- The UI has not been exercised in a real browser, and the AI routes have only been tested against mocked responses, never a live API.
