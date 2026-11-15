export type Segment = { type: 'text' | 'inline' | 'display'; value: string };

/** Split text into plain text and $inline$ / $$display$$ maths segments. */
export function splitMath(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { type: 'display', value: m[1] } : { type: 'inline', value: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}
