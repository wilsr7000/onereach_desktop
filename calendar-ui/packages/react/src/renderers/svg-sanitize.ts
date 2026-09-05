/**
 * Minimal SVG sanitising for string payloads: drops script/foreignObject
 * elements, event-handler attributes, javascript: URLs and external
 * references. React nodes are rendered as given (the consumer wrote them).
 */
export function sanitizeSvg(markup: string): string {
  let out = markup;
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<\s*(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|foreignObject|iframe|object|embed)\b[^>]*\/?>/gi, '');
  out = out.replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s(href|xlink:href|src)\s*=\s*("\s*(javascript|data):[^"]*"|'\s*(javascript|data):[^']*')/gi, '');
  out = out.replace(/\s(href|xlink:href)\s*=\s*("https?:[^"]*"|'https?:[^']*')/gi, '');
  return out;
}

/** The intrinsic aspect ratio from the viewBox (or width/height), defaulting to 1. */
export function svgAspectRatio(markup: string): number {
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(markup);
  if (vb !== null) {
    const w = Number.parseFloat(vb[1] ?? '0');
    const h = Number.parseFloat(vb[2] ?? '0');
    if (w > 0 && h > 0) return w / h;
  }
  const w = /\swidth\s*=\s*["']([\d.]+)/i.exec(markup);
  const h = /\sheight\s*=\s*["']([\d.]+)/i.exec(markup);
  if (w !== null && h !== null) {
    const wn = Number.parseFloat(w[1] ?? '0');
    const hn = Number.parseFloat(h[1] ?? '0');
    if (wn > 0 && hn > 0) return wn / hn;
  }
  return 1;
}
