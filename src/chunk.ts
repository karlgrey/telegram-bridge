/** Zerlegt Text in Telegram-taugliche Stücke (Limit 4096). */
export function chunkMessage(text: string, limit = 4096): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.3) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.3) cut = limit;
    out.push(rest.slice(0, cut).replace(/\n+$/, ''));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
