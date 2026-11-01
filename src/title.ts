// The title laid over the artwork. Its position is format-agnostic: u, v say
// where it sits in the frame (0..1 across, 0..1 down) and every format snaps
// that to its own grid, so the type always sits inside one row (or a band of
// rows when zoomed far out) and spans whole columns, its first and last letters
// centred in the outer ones. Tracking is what stretches to make that land. When
// a format is too narrow for one line it breaks into two (or three).
export type Ink = 'auto' | 'white' | 'gray' | 'black' | `#${string}`
// docked (subtitle only): sits in the row under the title, on its axis, instead of at u, v.
export type Title = { show: boolean; text: string; u: number; v: number; size: number; spacing: number; weight: number; ink: Ink; docked?: boolean }
export const TITLE: Title = { show: true, text: 'FRAMEWORK', u: 0.5, v: 0.5, size: 0.55, spacing: 0.55, weight: 800, ink: 'auto' }
// The subtitle: off until wanted; docked under the title; its auto ink follows the title's.
export const SUBTITLE: Title = { show: false, text: 'SUBTITLE', u: 0.5, v: 0.62, size: 0.3, spacing: 0.45, weight: 500, ink: 'auto', docked: true }
export const INKS = { white: '#f5f3ef', gray: '#4a4a4a', black: '#161616' } as const
export const FONT = '"Big Shoulders", "Arial Narrow", sans-serif'
export const fontsReady = (weight: number) => document.fonts.load(`${weight} 100px "Big Shoulders"`).catch(() => [])

// The window of land on screen, in world units (same shape as main.tsx's Win).
type Win = { cx: number; cy: number; w: number; h: number }
export type Box = { x: number; y: number; w: number; h: number }
// row / axis: the block's bottom row and centre line in world units (for docking).
export type TitleLayout = { font: string; cap: number; pens: { ch: string; x: number; y: number }[]; box: Box; row: number; axis: number }

// Smallest row, as a share of the frame's short side, before the type takes a
// band of 3 (5, …) rows so it doesn't vanish when zoomed out. It depends on the
// zoom only, so a small subtitle stays small next to its title.
const MIN_ROW = 0.064, MIN_TRACK = 0.08, MAX_LINES = 3
// Break into more lines rather than shrink the type below this share of its size.
const KEEP_SIZE = 0.8

// Splits the title into n lines: between words when it has enough of them
// (balancing line lengths), otherwise mid-word into near-equal chunks
// (FRAMEWORK → FRAME / WORK).
function splitLines(text: string, n: number): string[][] {
  const words = text.split(/\s+/).filter(Boolean)
  if (n === 1) return [Array.from(words.join(' '))]
  if (words.length >= n) {
    let best: string[][] = [], score = Infinity
    const go = (from: number, left: number, acc: string[]) => {
      if (left === 1) { const all = [...acc, words.slice(from).join(' ')]; const m = Math.max(...all.map((l) => l.length)); if (m < score) { score = m; best = all.map((l) => Array.from(l)) } return }
      for (let k = from + 1; k <= words.length - left + 1; k++) go(k, left - 1, [...acc, words.slice(from, k).join(' ')])
    }
    go(0, n, [])
    return best
  }
  const chars = Array.from(words.join(''))
  if (chars.length < n * 2) return []
  const out: string[][] = []
  for (let i = 0, at = 0; i < n; i++) { const k = Math.ceil((chars.length - at) / (n - i)); out.push(chars.slice(at, at + k)); at += k }
  return out
}

// Lays the title out on a W×H px frame showing `win`. Each line sits in its
// own row (or band of rows) and spans whole columns, its first and last
// letters centred in the outer ones. Lines share one centre axis and one size.
export function layoutTitle(ctx: CanvasRenderingContext2D, t: Title, win: Win, W: number, H: number, dock?: { row: number; axis: number }): TitleLayout | null {
  if (!t.show || !t.text.trim()) return null
  const cell = W / win.w, left = win.cx - win.w / 2, top = win.cy + win.h / 2
  // Whole rows and columns fully inside the frame.
  const r0 = Math.ceil(win.cy - win.h / 2), r1 = Math.floor(top), c0 = Math.ceil(left), c1 = Math.floor(left + win.w)
  const rows = Math.max(1, r1 - r0)
  let span = 1
  while (cell * span < MIN_ROW * Math.min(W, H) && span + 2 <= rows) span += 2

  ctx.font = `${t.weight} 100px ${FONT}`
  const capRatio = ctx.measureText('H').actualBoundingBoxAscent / 100 || 0.7
  // Glyph metrics: per-letter advance and ink width; `core` is the distance
  // from the first letter's ink centre to the last's, before tracking.
  const measure = (chars: string[], px: number) => {
    ctx.font = `${t.weight} ${px}px ${FONT}`
    const ms = chars.map((c) => ctx.measureText(c)), adv = ms.map((x) => x.width)
    const inkW = (x: TextMetrics) => x.actualBoundingBoxLeft + x.actualBoundingBoxRight
    const first = ms[0], last = ms[ms.length - 1]
    const ink = adv.slice(0, -1).reduce((s, a) => s + a, 0) + first.actualBoundingBoxLeft + last.actualBoundingBoxRight
    return { chars, adv, gaps: chars.length - 1, core: ink - inkW(first) / 2 - inkW(last) / 2, lead: first.actualBoundingBoxLeft, wf: inkW(first), wl: inkW(last) }
  }

  // Columns: the block's centre snaps to a column line (even N) or a column
  // centre (odd N). A column of margin each side when the frame has room.
  const xs = dock ? dock.axis : Math.round((left + t.u * win.w) * 2) / 2, odd = xs % 1 !== 0
  const avail = c1 - c0 >= 5 ? c1 - c0 - 2 : c1 - c0
  const maxN = Math.max(odd ? 1 : 2, (avail % 2 === 1) === odd ? avail : avail - 1)
  const parity = (n: number, least: number) => { let k = Math.round(n); if ((k % 2 === 1) !== odd) k += n > k ? 1 : -1; return Math.min(maxN, Math.max(least, k)) }

  // Tries n lines: the columns each line wants and how much the type must shrink.
  const attempt = (n: number) => {
    const lines = splitLines(t.text.trim(), n)
    if (lines.length !== n || n * span > rows) return null
    const px0 = (t.size * cell * span) / capRatio
    let scale = 1
    for (const l of lines) {
      const m = measure(l, px0)
      if (!m.gaps) { if (m.wf > maxN * cell) scale = Math.min(scale, (maxN * cell) / m.wf); continue }
      const fit = ((maxN - 1) * cell) / (m.core + MIN_TRACK * px0 * m.gaps)
      scale = Math.min(scale, fit)
    }
    return { lines, scale }
  }
  let pick: { lines: string[][]; scale: number } | null = null
  for (let n = 1; n <= MAX_LINES; n++) {
    const a = attempt(n)
    if (!a) continue
    if (!pick || a.scale > pick.scale) pick = a
    if (a.scale >= KEEP_SIZE) { pick = a; break }
  }
  if (!pick) pick = { lines: [Array.from(t.text.trim())], scale: 1 }
  const px = ((t.size * cell * span) / capRatio) * Math.min(1, pick.scale), cap = px * capRatio
  const ms = pick.lines.map((l) => measure(l, px))

  // One column span for the block: the widest line's natural width. Shorter
  // lines stretch to it unless that would loosen them too far; then they keep
  // their own (narrower) span on the same axis.
  const want = (m: ReturnType<typeof measure>) => (m.gaps ? parity((m.core + t.spacing * px * m.gaps) / cell + 1, odd ? 3 : 2) : parity(1, odd ? 1 : 2))
  const fits = (m: ReturnType<typeof measure>, n: number) => !m.gaps || ((n - 1) * cell - m.core) / m.gaps >= MIN_TRACK * px
  const grow = (m: ReturnType<typeof measure>, n: number) => { while (!fits(m, n) && n + 2 <= maxN) n += 2; return n }
  const N = Math.max(...ms.map((m) => grow(m, want(m))))
  let x0 = xs - N / 2
  x0 = Math.min(Math.max(x0, c1 - c0 >= 5 ? c0 + 1 : c0), (c1 - c0 >= 5 ? c1 - 1 : c1) - N)
  const axis = x0 + N / 2

  // Rows: the block of lines centred on the row holding v, kept inside the frame.
  const n = pick.lines.length, bandRows = n * span
  const want0 = dock ? dock.row - bandRows : Math.floor(top - t.v * win.h) - Math.floor((n - 1) / 2) * span - (span - 1) / 2
  const first = Math.min(Math.max(want0, r0), r1 - bandRows)
  // `first` is the bottom row of the block; lines run top to bottom.
  const pens: TitleLayout['pens'] = []
  let bx0 = Infinity, bx1 = -Infinity
  ms.forEach((m, i) => {
    const loose = m.gaps && ((N - 1) * cell - m.core) / m.gaps > t.spacing * px * 2.2
    const own = loose ? grow(m, want(m)) : N
    const L = (axis - own / 2 - left) * cell
    const track = m.gaps ? ((own - 1) * cell - m.core) / m.gaps : 0
    const inkL = m.gaps ? L + cell / 2 - m.wf / 2 : L + (own * cell - m.wf) / 2
    const yc = first + bandRows - i * span - span / 2
    const baseline = (top - yc) * cell + cap / 2
    let x = inkL + m.lead
    m.chars.forEach((ch, k) => { pens.push({ ch, x, y: baseline }); x += m.adv[k] + track })
    bx0 = Math.min(bx0, inkL); bx1 = Math.max(bx1, m.gaps ? inkL + (own - 1) * cell + m.wf / 2 + m.wl / 2 : inkL + m.wf)
  })
  const yTop = (top - (first + bandRows - span / 2)) * cell - cap / 2, yBot = (top - (first + span / 2)) * cell + cap / 2
  return { font: `${t.weight} ${px}px ${FONT}`, cap, pens, box: { x: bx0, y: yTop, w: bx1 - bx0, h: yBot - yTop }, row: first, axis }
}

// Title and subtitle together; a docked subtitle takes the row under the title.
export type Texts = { title: TitleLayout | null; sub: TitleLayout | null }
export function layoutTexts(ctx: CanvasRenderingContext2D, t: Title, s: Title, win: Win, W: number, H: number): Texts {
  const title = layoutTitle(ctx, t, win, W, H)
  return { title, sub: layoutTitle(ctx, s, win, W, H, s.docked && title ? { row: title.row, axis: title.axis } : undefined) }
}
// The patch the auto ink is judged on: under the title, or the subtitle alone.
export const inkBox = (l: Texts) => (l.title ?? l.sub)?.box

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
  // Shadow blur and offset ignore the canvas transform, so scale them by it
  // (the on-screen layer is drawn at devicePixelRatio).
  const cap = l.cap * ctx.getTransform().a, shade = shadowFor(color, bg)
  const pass = (alpha: number, blur: number, dy: number) => {
    ctx.shadowColor = `rgba(${shade.rgb}, ${alpha * shade.k})`; ctx.shadowBlur = cap * blur; ctx.shadowOffsetY = cap * dy
    for (const p of l.pens) ctx.fillText(p.ch, p.x, p.y)
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
