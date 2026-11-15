'use client';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitMath } from '@/lib/math';

/** Renders text with $inline$ and $$display$$ LaTeX. Bad LaTeX shows as red source text, never crashes. */
export function Rich({ text }: { text: string }) {
  return (
    <span className="rich">
      {splitMath(text).map((s, i) =>
        s.type === 'text' ? (
          <span key={i}>{s.value}</span>
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(s.value, { throwOnError: false, displayMode: s.type === 'display' }) }} />
        ),
      )}
    </span>
  );
}
