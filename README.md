# Retain: adaptive GCSE revision

Local-first flashcard app with spaced repetition, AI card generation, knowledge-gap detection and optional cloud sync. Cards, schedules and review history always live in your browser first (IndexedDB), so it works offline. Cloud sync and AI are both optional.

## Run it
```bash
npm install                  # then commit the generated package-lock.json
cp .env.example .env.local   # optional: AI key and cloud sync settings
npm run dev                  # http://localhost:3000
npm test                     # 174 unit/integration tests
npm run typecheck && npm run build
```
Revision, scheduling and card management work with no keys at all. (Windows: use `copy` instead of `cp`.)

## AI setup (optional)
Put a key in `.env.local`: `OPENAI_API_KEY`, plus `OPENAI_MODEL` and `OPENAI_BASE_URL` for any OpenAI-compatible provider that supports JSON-schema output. A free example that works: Google Gemini via `OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/` with a key from Google AI Studio and a fast model such as `gemini-flash-lite-latest`. Never commit `.env.local`.

## Cloud sync setup (optional)
1. Create a free project at supabase.com. Pick a region near you.
2. In the project, open **SQL Editor -> New query**, paste the whole of `supabase/migrations/0001_cloud_sync.sql`, and run it. You should then see 5 tables in the Table Editor.
3. Open **Project Settings -> API** (or the **API Keys** tile on the project home). Copy the project URL and the **public** key (called "publishable" or "anon"). Never use the secret / service_role key.
4. Put them in `.env.local` as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, then restart `npm run dev`.
5. Click the badge in the top bar, create an account (or sign in), and the badge turns to "In the cloud". Sign in on another device or browser to get the same data.

If sign-up says to confirm your email, click the link in the email, then sign in. To skip that step, turn off "Confirm email" in the Supabase Auth settings.

### How sync works
- **Local first.** The app never waits for the cloud. Every change is saved on the device and flagged as "not in the cloud yet"; a background sync uploads it and downloads other devices' changes. The top-bar badge always says which state you are in.
- **Offline.** Changes queue up and upload when you are back online, retrying after 5s, 15s, 1min, then every 5min.
- **Conflicts.** Reviews are immutable events: they are only ever added (or removed by undo), never merged away, so review history is never lost. A card's text and its schedule merge separately, each from whichever device changed it last. If a card is deleted on one device and edited later on another, the edit wins.
- **Safety.** The database only lets you read and write your own rows (Row Level Security, tested on a real Postgres engine in `tests/sql.test.ts`). A device that is behind cannot overwrite newer data.
- **One account per browser.** A browser that has synced with one account refuses to sync with another (so data cannot leak between accounts on a shared computer).
- **Limits.** If you review the same card on two devices before they sync, the later schedule wins (both reviews stay in your history). Free Supabase projects pause after about a week of inactivity (data is kept; they can be restored). The login token is kept in the browser's local storage. There is no cloud backup beyond what your Supabase plan provides.

## How scheduling works
- **Long term:** `ts-fsrs` (FSRS), fuzz off so it is deterministic, 90% target retention.
- **Within a session** (`src/lib/scheduler/session.ts`, pure, no network/clock):
  - Again: back after 3 other cards, then 2, then 1 if you keep missing it. Needs two good recalls in a row.
  - Hard: back after 5 cards, needs one Good.
  - Good: a clean review card is done for the session. A new or struggled card returns after 10 cards and must be recalled again.
  - Easy: done.
  - When a card leaves the queue ONE grade goes to FSRS: the worst grade of that cycle.
- Every rating is stored as a review event with a client-generated id. Writing the same id twice is a no-op. Undo reverses both the session and the stored schedule.

## Generating cards
Paste notes (or load a .txt/.md file) and choose the number of cards, difficulty and answer detail, or leave each on **Auto** and the AI decides based on your notes (auto count is capped at 40). Every card needs a verbatim source quote; if it is not found in your text the card is flagged "Unverified". Nothing is saved until you approve it.

## Misconception detection and learning notes
- **Detection is not AI.** A topic (card topic label, or deck name) is flagged only if you forgot >= 3 different cards on >= 2 different days in the last 30 days, with >= 5 reviews and a >= 40% forget rate. One wrong answer never flags anything.
- Each flag carries evidence and a low/medium/high confidence. Dismissed patterns are never re-flagged unless you choose "Track again".
- **Resolved** only by later performance: >= 6 reviews after your last miss, across >= 3 cards and >= 2 days, with >= 80% recalled Good/Easy. If you start forgetting again, it reopens.
- The AI only explains a pattern already found in your data, and says so when the forgotten cards share no concept. Suggested practice cards are marked unverified.
- **Learning notes** (`/memory`): short notes derived from the evidence. You can edit, delete or add notes; your edits are never overwritten. The tutor receives at most 3 relevant notes per request, labelled as possibly outdated.

## AI safety and honesty
- Pasted text is wrapped as untrusted data; the model is told never to follow instructions inside it.
- Output is schema-validated; malformed output gets ONE repair attempt, then an error. Cards are never fabricated.
- Retries: max 2, exponential backoff, Retry-After honoured, 45s timeout.
- AI feedback is visibly labelled and never changes your rating.
- Nothing is claimed to match a specification or exam board.

## NOT built (be aware)
- PDF, DOCX, PPTX and image upload / OCR (only pasted text and .txt/.md files)
- Importing lessons from Oak National Academy (needs a free API key from them; not started)
- Topic grouping is by label or deck, not by semantic similarity between cards
- Installable offline app (PWA / service worker): data is local, but the page itself needs to be loaded once
- End-to-end browser tests; Tailwind (plain CSS is used instead); deployment config
- The AI routes have no authentication, only a per-instance in-memory rate limit. Run locally; do not expose publicly.

## Known notes
- The sync code is tested against a simulated cloud, a mocked Supabase API and a real Postgres engine, and was checked by hand against a real Supabase project, but not by automated tests against one.
- `npm audit` flags a PostCSS advisory bundled inside Next 15 (build-time CSS processing; this app only processes its own CSS). Upgrading to Next 16 would fix it but was not attempted.
- TypeScript is pinned to 6.0.3 because Next 15 does not support TypeScript 7. Dependency versions are pinned exactly in `package.json`.
- The UI has had only light manual testing in one browser.
