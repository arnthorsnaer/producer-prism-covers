// The title laid over the artwork. Its position is format-agnostic: u, v say
// where it sits in the frame (0..1 across, 0..1 down) and every format snaps
// that to its own grid, so the type always sits inside one row (or a band of
// rows when zoomed far out) and spans whole columns, its first and last letters
// centred in the outer ones. Tracking is what stretches to make that land.
export type Ink = 'auto' | 'white' | 'gray' | 'black' | `#${string}`
export type Title = { show: boolean; text: string; u: number; v: number; size: number; spacing: number; weight: number; ink: Ink }
export const TITLE: Title = { show: true, text: 'FRAMEWORK', u: 0.5, v: 0.5, size: 0.55, spacing: 0.55, weight: 800, ink: 'auto' }
export const INKS = { white: '#f5f3ef', gray: '#4a4a4a', black: '#161616' } as const
export const FONT = '"Big Shoulders", "Arial Narrow", sans-serif'
export const fontsReady = (weight: number) => document.fonts.load(`${weight} 100px "Big Shoulders"`).catch(() => [])

// The window of land on screen, in world units (same shape as main.tsx's Win).
type Win = { cx: number; cy: number; w: number; h: number }
export type Box = { x: number; y: number; w: number; h: number }
export type TitleLayout = { font: string; pens: { ch: string; x: number }[]; baseline: number; box: Box }

// Smallest cap height, as a share of the frame's short side, before the type
// takes a band of 3 (5, …) rows so it doesn't vanish when zoomed out.
const MIN_CAP = 0.035, MIN_TRACK = 0.08

// Lays the title out on a W×H px frame showing `win`.
export function layoutTitle(ctx: CanvasRenderingContext2D, t: Title, win: Win, W: number, H: number): TitleLayout | null {
  const chars = Array.from(t.text.trim())
  if (!t.show || !chars.length) return null
  const cell = W / win.w, left = win.cx - win.w / 2, top = win.cy + win.h / 2
  // Whole rows and columns fully inside the frame.
  const r0 = Math.ceil(win.cy - win.h / 2), r1 = Math.floor(top), c0 = Math.ceil(left), c1 = Math.floor(left + win.w)
  let span = 1
  while (t.size * cell * span < MIN_CAP * Math.min(W, H) && span + 2 <= r1 - r0) span += 2
  let cap = t.size * cell * span

  // Rows: the band whose middle row holds v, kept inside the frame.
  const half = (span - 1) / 2
  const mid = Math.min(Math.max(Math.floor(top - t.v * win.h), r0 + half), r1 - 1 - half)
  const yc = mid + 0.5

  // Glyph metrics: per-letter advance and ink width; `core` is the distance
  // from the first letter's ink centre to the last's, before tracking.
  const measure = (px: number) => {
    ctx.font = `${t.weight} ${px}px ${FONT}`
    const ms = chars.map((c) => ctx.measureText(c)), adv = ms.map((x) => x.width)
    const inkW = (x: TextMetrics) => x.actualBoundingBoxLeft + x.actualBoundingBoxRight
    const first = ms[0], last = ms[ms.length - 1]
    const ink = adv.slice(0, -1).reduce((s, a) => s + a, 0) + first.actualBoundingBoxLeft + last.actualBoundingBoxRight
    return { adv, ink, core: ink - inkW(first) / 2 - inkW(last) / 2, lead: first.actualBoundingBoxLeft, wf: inkW(first), wl: inkW(last) }
  }
  ctx.font = `${t.weight} 100px ${FONT}`
  const capRatio = ctx.measureText('H').actualBoundingBoxAscent / 100 || 0.7
  let px = cap / capRatio, m = measure(px)
  const gaps = chars.length - 1

  // Columns: the title spans N whole columns and its first and last letters
  // sit centred in the outer two, never on a seam. The block's centre snaps to
  // a column line (even N) or a column centre (odd N).
  const xs = Math.round((left + t.u * win.w) * 2) / 2, odd = xs % 1 !== 0
  const least = gaps ? (odd ? 3 : 2) : (odd ? 1 : 2)
  const parity = (n: number) => { let k = Math.round(n); if ((k % 2 === 1) !== odd) k += n > k ? 1 : -1; return Math.max(least, k) }
  const room = c1 - c0 - 2 // a column of margin each side
  const maxN = (room % 2 === 1) === odd ? room : room - 1
  const trackAt = (n: number) => (gaps ? ((n - 1) * cell - m.core) / gaps : 0)
  let N = gaps ? parity((m.core + t.spacing * px * gaps) / cell + 1) : least
  if (gaps) while (trackAt(N) < MIN_TRACK * px && N + 2 <= maxN) N += 2
  if (N > maxN && maxN >= least) N = maxN
  // Too long for the frame even at minimum tracking: shrink the type.
  if (gaps && trackAt(N) < MIN_TRACK * px) { px *= ((N - 1) * cell) / (m.core + MIN_TRACK * px * gaps); cap = px * capRatio; m = measure(px) }
  const track = trackAt(N)

  // Keep the columns inside the margin, moving whole columns at a time.
  let x0 = xs - N / 2
  x0 = Math.max(x0, c0 + 1); x0 = Math.min(x0, c1 - 1 - N)
  const Lpx = (x0 - left) * cell
  // Ink left edge: first letter centred in the first column (a lone letter in the block).
  const inkL = gaps ? Lpx + cell / 2 - m.wf / 2 : Lpx + (N * cell - m.wf) / 2
  const pens: TitleLayout['pens'] = []
  let x = inkL + m.lead
  chars.forEach((ch, i) => { pens.push({ ch, x }); x += m.adv[i] + track })
  const inkW = gaps ? (N - 1) * cell + m.wf / 2 + m.wl / 2 : m.wf
  const ypx = (top - yc) * cell
  return { font: `${t.weight} ${px}px ${FONT}`, pens, baseline: ypx + cap / 2, box: { x: inkL, y: ypx - cap / 2, w: inkW, h: cap } }
}

// The shadow's colour. Under light text it is black, which separates the
// letters from the land. Under dark text black only reads as gray haze, so it
// is the land under the title, deepened (same hue, much darker) and a little
// stronger to make up for not being black.
export function shadowFor(ink: string, bg: RGB8): { rgb: string; k: number } {
  if (lum(ink) > 0.5) return { rgb: '0, 0, 0', k: 1 }
  return { rgb: bg.map((c) => Math.round(c * 0.3)).join(', '), k: 1.6 }
}
export type RGB8 = [number, number, number]
// Average colour of a sampled patch.
export function meanColor(rgba: Uint8ClampedArray): RGB8 {
  const m: RGB8 = [0, 0, 0], n = rgba.length / 4 || 1
  for (let i = 0; i < rgba.length; i += 4) { m[0] += rgba[i]; m[1] += rgba[i + 1]; m[2] += rgba[i + 2] }
  return m.map((c) => c / n) as RGB8
}

export function drawTitle(ctx: CanvasRenderingContext2D, l: TitleLayout, color: string, bg: RGB8 = [0, 0, 0]) {
  ctx.save()
  ctx.font = l.font; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  // Lift: a wide, faint bed of shadow under the type, then a tight soft one at
  // the letters. Both are sized to the type so the export and the small
  // previews look the same.
  const cap = l.box.h, shade = shadowFor(color, bg)
  const pass = (alpha: number, blur: number, dy: number) => {
    ctx.shadowColor = `rgba(${shade.rgb}, ${alpha * shade.k})`; ctx.shadowBlur = cap * blur; ctx.shadowOffsetY = cap * dy
    for (const p of l.pens) ctx.fillText(p.ch, p.x, l.baseline)
  }
  pass(0.18, 1.1, 0.12)
  pass(0.12, 0.12, 0.03)
  ctx.restore()
}

// Auto ink: white, dark gray or black, whichever reads best against what is
// actually under the title. White is judged against the bright end of the
// background (90th percentile), dark ink against the dark end (10th), so a
// single hot facet or shadow can't spoil it. Dark gray is preferred to black,
// as on the reference cover, whenever it still has comfortable contrast.
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) }
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
export function pickInk(rgba: Uint8ClampedArray, prev?: string): string {
  const ys: number[] = []
  for (let i = 0; i < rgba.length; i += 4) ys.push(0.2126 * lin(rgba[i]) + 0.7152 * lin(rgba[i + 1]) + 0.0722 * lin(rgba[i + 2]))
  if (!ys.length) return prev ?? INKS.white
  ys.sort((a, b) => a - b)
  const lo = ys[Math.floor(ys.length * 0.1)], hi = ys[Math.floor(ys.length * 0.9)]
  const score = (ink: string) => { const y = lum(ink); return y > 0.5 ? contrast(y, hi) : contrast(y, lo) }
  const dark: string = score(INKS.gray) >= 3.5 ? INKS.gray : INKS.black
  let best: string = score(INKS.white) >= score(dark) ? INKS.white : dark
  // A little hysteresis so it doesn't flicker while a slider is dragged.
  if (prev && prev !== best && (prev === INKS.white) !== (best === INKS.white) && score(best) < score(prev) * 1.15) best = prev
  return best
}

export const inkColor = (t: Title, auto: string) => (t.ink === 'auto' ? auto : t.ink in INKS ? INKS[t.ink as keyof typeof INKS] : t.ink)

// Samples the pixels under the title box from any canvas (a WebGL view or the
// stitched export), scaled down to a small patch.
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
export function sampleBox(src: CanvasImageSource, box: Box, sx: number, sy: number): Uint8ClampedArray {
  const w = 64, h = 16
  probe.canvas.width = w; probe.canvas.height = h
  probe.drawImage(src, box.x * sx, box.y * sy, Math.max(1, box.w * sx), Math.max(1, box.h * sy), 0, 0, w, h)
  return probe.getImageData(0, 0, w, h).data
}
