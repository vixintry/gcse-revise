'use client';
import { useEffect, useRef, useState } from 'react';
import { isDuplicate } from '@/lib/ai/validate';
import { SOURCE_MAX } from '@/lib/ai/generate';
import type { Deck } from '@/lib/db';

interface Candidate { front: string; back: string; topic: string; sourceQuote: string; supported: boolean; warnings: string[]; selected: boolean; duplicate: boolean }

export function GeneratePanel({ deck, existingFronts, onAdd }: {
  deck: Deck;
  existingFronts: string[];
  onAdd: (cards: { front: string; back: string; sourceQuote?: string; unverified?: boolean }[]) => Promise<void>;
}) {
  const draftKey = `draft:${deck.id}`;
  const [source, setSource] = useState('');
  const [opts, setOpts] = useState({ count: 12, difficulty: 'medium', detail: 'concise' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const inFlight = useRef(false);

  // Autosave the pasted text so a refresh doesn't lose it
  useEffect(() => { try { setSource(localStorage.getItem(draftKey) ?? ''); } catch { /* ignore */ } }, [draftKey]);
  useEffect(() => { try { source ? localStorage.setItem(draftKey, source) : localStorage.removeItem(draftKey); } catch { /* ignore */ } }, [source, draftKey]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError(null);
    if (!/\.(txt|md)$/i.test(f.name) && !f.type.startsWith('text/')) {
      setError('Only .txt and .md files can be read for now. PDF, Word, PowerPoint and image uploads are not built yet. Paste the text instead.');
      return;
    }
    if (f.size > 200_000) { setError('That file is over 200 KB. Split it into smaller sections.'); return; }
    setSource(await f.text());
  }

  async function generate() {
    if (inFlight.current) return; // block duplicate submissions
    inFlight.current = true; setBusy(true); setError(null); setNotice(null); setResults(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ source, subject: deck.subject, examBoard: deck.examBoard, ...opts }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? `Card generation failed (${res.status}). You can still add cards by hand.`); return; }
      const cards: Candidate[] = (data.cards as Omit<Candidate, 'selected' | 'duplicate'>[]).map((c) => {
        const duplicate = isDuplicate(c.front, existingFronts);
        return { ...c, duplicate, selected: c.supported && !duplicate };
      });
      setResults(cards);
      setRejected((data.rejected as { reason: string }[]).map((r) => r.reason));
      if (data.repaired) setNotice('The first AI response was malformed and was repaired automatically. Check the cards carefully.');
    } catch (e) {
      setError(e instanceof Error && e.name === 'AbortError' ? 'Generation timed out. Try less text.' : 'Could not reach the server. Check your connection. Your text is saved, and revision still works.');
    } finally { clearTimeout(timer); inFlight.current = false; setBusy(false); }
  }

  async function addSelected() {
    const chosen = (results ?? []).filter((c) => c.selected && c.front.trim() && c.back.trim());
    if (!chosen.length) return;
    try {
      await onAdd(chosen.map((c) => ({ front: c.front, back: c.back, topic: c.topic, sourceQuote: c.sourceQuote, unverified: !c.supported })));
      setNotice(`Added ${chosen.length} card${chosen.length === 1 ? '' : 's'} to ${deck.name}.`);
      setResults(null); setSource('');
    } catch { setError('Could not save the cards to this device. Nothing was added. Your preview is still here.'); }
  }

  const patch = (i: number, p: Partial<Candidate>) => setResults((r) => r && r.map((c, j) => (j === i ? { ...c, ...p } : c)));

  return (
    <section className="panel stack">
      <h2>Generate cards from your notes <span className="badge">AI</span></h2>
      <div>
        <label htmlFor="src">Paste your notes ({source.length.toLocaleString()} / {SOURCE_MAX.toLocaleString()} characters)</label>
        <textarea id="src" value={source} onChange={(e) => setSource(e.target.value)} rows={6} placeholder="Paste a section of your notes or textbook…" />
      </div>
      <div className="row">
        <div><label htmlFor="cnt">Cards</label><input id="cnt" type="number" min={3} max={30} value={opts.count} onChange={(e) => setOpts({ ...opts, count: Math.min(30, Math.max(3, Number(e.target.value) || 12)) })} style={{ width: 80 }} /></div>
        <div><label htmlFor="dif">Difficulty</label><select id="dif" value={opts.difficulty} onChange={(e) => setOpts({ ...opts, difficulty: e.target.value })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
        <div><label htmlFor="det">Answer detail</label><select id="det" value={opts.detail} onChange={(e) => setOpts({ ...opts, detail: e.target.value })}><option value="concise">Concise</option><option value="detailed">Detailed</option></select></div>
        <div><label htmlFor="file">Or load a .txt / .md file</label><input id="file" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={onFile} /></div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={generate} disabled={busy || source.trim().length < 40}>{busy ? 'Generating…' : 'Generate cards'}</button>
        <span className="small muted">Cards are checked against your text before you see them. Nothing is saved until you approve it.</span>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}
      {notice && <div className="banner warn" role="status">{notice}</div>}

      {results && (
        <div className="stack">
          <div className="row between">
            <b>{results.length} card{results.length === 1 ? '' : 's'} to review</b>
            <button className="btn primary" onClick={addSelected} disabled={!results.some((c) => c.selected)}>Add {results.filter((c) => c.selected).length} selected</button>
          </div>
          {results.length === 0 && <p className="muted">No usable cards came back. Try a longer or more factual passage.</p>}
          <ul className="list">
            {results.map((c, i) => (
              <li key={i} className="stack">
                <div className="row between">
                  <label className="row" style={{ margin: 0, color: 'inherit' }}><input type="checkbox" style={{ width: 'auto' }} checked={c.selected} onChange={(e) => patch(i, { selected: e.target.checked })} /> Keep</label>
                  <span className="row">
                    {!c.supported && <span className="badge warn">Unverified: quote not found in your text</span>}
                    {c.duplicate && <span className="badge warn">Similar card already in this deck</span>}
                  </span>
                </div>
                <input aria-label="Question" value={c.front} onChange={(e) => patch(i, { front: e.target.value })} />
                <textarea aria-label="Answer" rows={2} value={c.back} onChange={(e) => patch(i, { back: e.target.value })} />
                {c.sourceQuote && <div className="small muted">Source: “{c.sourceQuote}”</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {rejected.length > 0 && (
        <details><summary className="small muted">{rejected.length} generated card{rejected.length === 1 ? ' was' : 's were'} rejected by validation</summary>
          <ul className="small muted">{rejected.map((r, i) => <li key={i}>{r}</li>)}</ul></details>
      )}
    </section>
  );
}
