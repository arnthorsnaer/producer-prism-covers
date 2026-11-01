// The prism is fixed, colour-neutral geometry. Everything you see in colour comes
// from the lights, so this file is shared by the app and by scripts/fit.ts.
export const COLS = 14, ROWS = 10, CELL = 1

export type V3 = [number, number, number]
export type Tri = [V3, V3, V3]

// ridge: height of each cell's diagonal fold (negative = valley), dome: lens
// bulge (negative = bowl), cx/cy: the top of the bulge, where the under-glow
// sits (in or out of frame), spread: bulge width relative to the view,
// profile: 2 = round dome, 1 = four-sided pyramid whose ridges run through the
// top (the bright cross), ox/oy: where the diamond pattern grows out from,
// relative to the top, so it follows the bulge (0, 0 = on the top), thickness:
// glass slab depth (isometric only). These are the defaults; the app's Shape
// panel edits a copy.
export type Shape = { ridge: number; dome: number; cx: number; cy: number; spread: number; profile: number; ox: number; oy: number; thickness: number }

// The reference is a crop: 280 px cells in a 3500×2500 image show 12.5 × 8.93
// cells, centred on a cell centre. Its diamond pattern is centred on the grid
// corner 4.75 cells from the left and 2.96 from the top of that crop. VIEW is
// that window on our 14×10 grid, so every triangle lines up 1:1.
export const VIEW = { cx: -0.5, cy: 0.5, w: 12.5, h: 12.5 / 1.4 }
// In the reference the brightest cell, where the bright row and column cross, is
// the view centre; its pattern grows from grid corner (5, 7), 1.5 cells NW of it.
export const PRISM: Shape = { ridge: 0.004, dome: 0.914, cx: VIEW.cx, cy: VIEW.cy, spread: 1, profile: 2.06, ox: -1.5, oy: 1.5, thickness: 0.35 }

// Frosted glass. `translucency` is the share of light from behind a facet that
// scatters through it (thin-sheet diffuse transmission, see main.tsx).
export const SURFACE = { roughness: 0.5, specularIntensity: 0.5, translucency: 0.6 }

// The land is endless: cells are addressed by world-integer coordinates (cell
// (i, j) spans x i..i+1, y j..j+1) and only a patch is built at a time. GRID is
// the original 14×10 patch the fitter works on.
export type Grid = { x0: number; y0: number; cols: number; rows: number }
export const GRID: Grid = { x0: -COLS / 2, y0: -ROWS / 2, cols: COLS, rows: ROWS }
// The smallest patch covering a w×h window centred on (cx, cy), plus a cell.
export const gridFor = (cx: number, cy: number, w: number, h: number): Grid => {
  const x0 = Math.floor(cx - w / 2) - 1, y0 = Math.floor(cy - h / 2) - 1
  return { x0, y0, cols: Math.ceil(cx + w / 2) + 1 - x0, rows: Math.ceil(cy + h / 2) + 1 - y0 }
}
const wx = (i: number) => i * CELL, wy = (j: number) => j * CELL

// Diagonals run tangentially around the pattern centre, drawing concentric
// diamonds like a Fresnel lens: "/" in NW + SE cells, "\" in NE + SW cells.
// Each cell goes by which side of the centre its own centre is on, so the
// centre can sit anywhere (in or out of frame) and the cuts follow a cell at a time.
// The reference breaks the rule in exactly one cell, the first one SE of the
// centre (measured per cell against public/reference.jpg), so we do too; the
// quirk travels with the centre.
const slash = (ci: number, cj: number, p: Shape) => {
  const x = wx(ci) + CELL / 2, y = wy(cj) + CELL / 2, px = p.cx + p.ox, py = p.cy + p.oy
  const quirk = x === Math.floor(px - CELL / 2) + 1.5 * CELL && y === Math.ceil(py + CELL / 2) - 1.5 * CELL
  return ((x - px) * (y - py) < 0) !== quirk
}

// Height of corner (i, j) as seen by cell (ci, cj). Every cell is its own gabled
// tile: the two corners on its diagonal are lifted, so its halves slope toward
// and away from the centre and always catch light differently.
export function cornerZ(i: number, j: number, ci: number, cj: number, p = PRISM) {
  const u = Math.abs(wx(i) - p.cx) / (VIEW.w / 2) / p.spread, v = Math.abs(wy(j) - p.cy) / (VIEW.h / 2) / p.spread
  const r2 = (u ** p.profile + v ** p.profile) / 2
  const onRidge = slash(ci, cj, p) ? i - ci === j - cj : i - ci !== j - cj
  return p.dome * (1 - r2) + (onRidge ? p.ridge : 0)
}

// The lens surface at any point, without the per-cell folds (for drawing on it).
export function surfaceZ(x: number, y: number, p = PRISM) {
  const u = Math.abs(x - p.cx) / (VIEW.w / 2) / p.spread, v = Math.abs(y - p.cy) / (VIEW.h / 2) / p.spread
  return p.dome * (1 - (u ** p.profile + v ** p.profile) / 2) + Math.max(p.ridge, 0)
}

const corner = (i: number, j: number, ci: number, cj: number, p = PRISM): V3 => [wx(i), wy(j), cornerZ(i, j, ci, cj, p)]

export function topFacets(p = PRISM, g = GRID): Tri[] {
  const tris: Tri[] = []
  for (let cj = g.y0; cj < g.y0 + g.rows; cj++) for (let ci = g.x0; ci < g.x0 + g.cols; ci++) {
    const v = (di: number, dj: number) => corner(ci + di, cj + dj, ci, cj, p)
    const a = v(0, 0), b = v(1, 0), c = v(1, 1), d = v(0, 1)
    if (slash(ci, cj, p)) tris.push([a, b, c], [a, c, d])
    else tris.push([a, b, d], [b, c, d])
  }
  return tris
}

// Closes the vertical gap between two tiles' copies of the same edge A→B.
function riser(A1: V3, B1: V3, A2: V3, B2: V3): Tri[] {
  const dA = A1[2] - A2[2], dB = B1[2] - B2[2]
  if (Math.abs(dA) < 1e-9 && Math.abs(dB) < 1e-9) return []
  if (dA * dB >= 0) return [[A1, A2, B2], [A1, B2, B1]]
  const t = dA / (dA - dB), M: V3 = [A1[0] + t * (B1[0] - A1[0]), A1[1] + t * (B1[1] - A1[1]), A1[2] + t * (B1[2] - A1[2])]
  return [[A1, A2, M], [B1, M, B2]]
}

export function prismTriangles(p = PRISM, g = GRID): Tri[] {
  const tris = topFacets(p, g), X1 = g.x0 + g.cols, Y1 = g.y0 + g.rows
  for (let cj = g.y0; cj < Y1; cj++) for (let ci = g.x0; ci < X1; ci++) {
    if (ci + 1 < X1) tris.push(...riser(corner(ci + 1, cj, ci, cj, p), corner(ci + 1, cj + 1, ci, cj, p), corner(ci + 1, cj, ci + 1, cj, p), corner(ci + 1, cj + 1, ci + 1, cj, p)))
    if (cj + 1 < Y1) tris.push(...riser(corner(ci, cj + 1, ci, cj, p), corner(ci + 1, cj + 1, ci, cj, p), corner(ci, cj + 1, ci, cj + 1, p), corner(ci + 1, cj + 1, ci, cj + 1, p)))
  }
  // The floor sits a slab-thickness under the lowest point of the lens.
  let zMin = Infinity
  for (const t of tris) for (const v of t) zMin = Math.min(zMin, v[2])
  const z0 = zMin - p.thickness, L = wx(g.x0), R = wx(X1), B = wy(g.y0), T = wy(Y1)
  tris.push([[L, B, z0], [R, T, z0], [R, B, z0]], [[L, B, z0], [L, T, z0], [R, T, z0]])
  // Slab walls: drop every rim edge of the outer tiles to the bottom face.
  const wall = (t1: V3, t2: V3) => tris.push([[t1[0], t1[1], z0], [t2[0], t2[1], z0], t2], [[t1[0], t1[1], z0], t2, t1])
  for (let ci = g.x0; ci < X1; ci++) {
    wall(corner(ci, g.y0, ci, g.y0, p), corner(ci + 1, g.y0, ci, g.y0, p))
    wall(corner(ci + 1, Y1, ci, Y1 - 1, p), corner(ci, Y1, ci, Y1 - 1, p))
  }
  for (let cj = g.y0; cj < Y1; cj++) {
    wall(corner(X1, cj, X1 - 1, cj, p), corner(X1, cj + 1, X1 - 1, cj, p))
    wall(corner(g.x0, cj + 1, g.x0, cj, p), corner(g.x0, cj, g.x0, cj, p))
  }
  return tris
}

// Rolls the dice on the shape. 'move' places the top of the bulge (and with it
// the pattern centre, at its offset, and the under-glow) anywhere in view, about a third of the
// time out of frame; 'all' also rolls how bulgy (sometimes a bowl) and how wide.
export function randomShape(part: 'move' | 'all', from: Shape = PRISM): Shape {
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo), r2 = (n: number) => Math.round(n * 100) / 100
  const top = { cx: r2(VIEW.cx + rand(-0.7, 0.7) * VIEW.w), cy: r2(VIEW.cy + rand(-0.7, 0.7) * VIEW.h) }
  if (part === 'move') return { ...from, ...top }
  return {
    ...from, ...top,
    dome: r2(Math.random() < 0.15 ? rand(-1.5, -0.4) : rand(0.3, 3)),
    spread: r2(rand(0.6, 1.6)), profile: r2(rand(1, 2.2)),
    ridge: r2(Math.random() < 0.5 ? PRISM.ridge : rand(-0.12, 0.12)),
  }
}

export function faceNormal([a, b, c]: Tri): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  const l = Math.hypot(...n)
  return [n[0] / l, n[1] / l, n[2] / l]
}

// Where a facet's light is evaluated: its centroid, giving one colour per triangle.
export const facetCentre = ([a, b, c]: Tri): V3 => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
