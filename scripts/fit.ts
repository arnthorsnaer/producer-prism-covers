// Fits the six lamps (colour, intensity, position, aim, cone), the cross light and the room light
// so the top-down render of the prism matches public/reference.jpg. It runs on
// the CPU with the same maths as three.js MeshPhysicalMaterial (Lambert + GGX,
// physical falloff, spot cones, the translucency term from main.tsx, Neutral
// tone mapping), so the result transfers to the GPU almost exactly.
//   npm run fit   → rewrites src/reference-rig.json   (STEPS=n to change length)
//   FIT_SHAPE=1 npm run fit   → also solves the prism's dome (printed; copy into
//   PRISM in src/prism.ts to freeze the structure).
//   FRESH=1 npm run fit   → start from a generic rig instead of the current one.
//   DOME=x / PROFILE=x   → start the dome at x / hold the profile at x (with FIT_SHAPE).
//   LMAP=1   → also print per-cell lightness, ours vs the reference.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COLS, ROWS, PRISM, SURFACE, VIEW, topFacets, faceNormal, facetCentre, type V3 } from '../src/prism'
import { lab, neutral, toSRGB, toLinear, hexToRGB, rgbToHex, deltaE, type RGB } from '../src/color'
import { LAMP_SLOTS, DECAY, CONE_MAX, CROSS_N, NO_CROSS, themes, type Rig } from '../src/rig'

// The reference at full resolution, as sRGB 0..1.
function loadReference() {
  const out = join(mkdtempSync(join(tmpdir(), 'prism-fit-')), 'ref.bmp')
  execFileSync('sips', ['-s', 'format', 'bmp', 'public/reference.jpg', '--out', out], { stdio: 'ignore' })
  const buf = readFileSync(out), off = buf.readUInt32LE(10), bpp = buf.readUInt16LE(28) / 8
  const W = buf.readInt32LE(18), h = buf.readInt32LE(22), H = Math.abs(h), stride = Math.ceil((W * bpp) / 4) * 4
  const at = (x: number, y: number): RGB => {
    const o = off + (h > 0 ? H - 1 - y : y) * stride + x * bpp
    return [buf[o + 2] / 255, buf[o + 1] / 255, buf[o] / 255]
  }
  return { W, H, at }
}

// Per-triangle targets: the mean colour of the matching reference triangle,
// sampled on a lattice shrunk toward the centroid to skip anti-aliased edges.
// Triangles cut by the crop count in proportion to how much of them is visible.
type Target = { k: number; lab: RGB; rgb: RGB; weight: number }
function triangleTargets(): Target[] {
  const ref = loadReference(), tris = topFacets(), out: Target[] = [], N = 14
  const left = VIEW.cx - VIEW.w / 2, top = VIEW.cy + VIEW.h / 2
  tris.forEach((t, k) => {
    const c = facetCentre(t), sum = [0, 0, 0]
    let inside = 0, total = 0
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) {
      const l = [i / N, j / N, 1 - (i + j) / N]
      const x = c[0] + 0.7 * (l[0] * t[0][0] + l[1] * t[1][0] + l[2] * t[2][0] - c[0])
      const y = c[1] + 0.7 * (l[0] * t[0][1] + l[1] * t[1][1] + l[2] * t[2][1] - c[1])
      const u = Math.floor(((x - left) / VIEW.w) * ref.W), v = Math.floor(((top - y) / VIEW.h) * ref.H)
      total++
      if (u < 0 || v < 0 || u >= ref.W || v >= ref.H) continue
      const p = ref.at(u, v); sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; inside++
    }
    if (inside / total < 0.25) return
    const rgb = sum.map((v) => v / inside) as RGB
    out.push({ k, rgb, lab: lab(rgb), weight: inside / total })
  })
  return out
}

// What the shader computes for each facet: lit once at its centroid.
type Sample = { p: V3; n: V3 }
const samples = (shape = PRISM): Sample[] => topFacets(shape).map((t) => ({ p: facetCentre(t), n: faceNormal(t) }))

// Parameter vector, per lamp: [x, y, z, aimX, aimY, cone (rad), soft, logR, logG, logB];
// then the room light [logR, logG, logB]. Logs keep colours positive.
const N_LAMP = LAMP_SLOTS.length, P = 10, ROOM = N_LAMP * P, SHAPE = ROOM + 3
const CROSS = SHAPE + 3
const FIT_SHAPE = !!process.env.FIT_SHAPE, FAR = 40, UNDER = LAMP_SLOTS.findIndex(([id]) => id === 'under')
const rad = Math.PI / 180

function shade(q: number[], S: Sample[]): RGB[] {
  const a2 = SURFACE.roughness ** 4, f0 = 0.04 * SURFACE.specularIntensity, f90 = SURFACE.specularIntensity
  const room = [0, 1, 2].map((k) => Math.exp(q[ROOM + k]) / Math.PI)
  const lamps = LAMP_SLOTS.map((_, k) => {
    const o = k * P, [x, y, z] = [q[o], q[o + 1], q[o + 2]]
    let dx = x - q[o + 3], dy = y - q[o + 4], dz = z
    const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl
    const coneCos = Math.cos(q[o + 5]), penCos = Math.cos(q[o + 5] * (1 - q[o + 6]))
    return { x, y, z, dx, dy, dz, coneCos, penCos, c: [0, 1, 2].map((i) => Math.exp(q[o + 7 + i])) }
  })
  // The cross light: two strips over the top, each CROSS_N points (as in the app).
  for (const axis of [0, 1]) for (let k = 0; k < CROSS_N; k++) {
    const t = (k / (CROSS_N - 1)) * 2 - 1, arm = q[CROSS + 1 + axis]
    lamps.push({ x: PRISM.cx + (axis ? 0 : t * arm), y: PRISM.cy + (axis ? t * arm : 0), z: q[CROSS], dx: 0, dy: 0, dz: 1, coneCos: -2, penCos: -1.5,
      c: [0, 1, 2].map((i) => Math.exp(q[CROSS + 3 + i]) / CROSS_N) })
  }
  return S.map(({ p, n }) => {
    const acc = [...room]
    for (const L of lamps) {
      let lx = L.x - p[0], ly = L.y - p[1], lz = L.z - p[2]
      const dist = Math.hypot(lx, ly, lz); lx /= dist; ly /= dist; lz /= dist
      // three.js getSpotAttenuation: smoothstep across the penumbra.
      const ac = lx * L.dx + ly * L.dy + lz * L.dz
      const s = Math.min(1, Math.max(0, (ac - L.coneCos) / Math.max(L.penCos - L.coneCos, 1e-6))), spot = s * s * (3 - 2 * s)
      if (spot === 0) continue
      const nl = n[0] * lx + n[1] * ly + n[2] * lz, dotNL = Math.max(nl, 0)
      let w = (SURFACE.translucency * Math.max(-nl, 0) + dotNL) / Math.PI
      if (dotNL > 0) {
        // Orthographic camera straight above: view direction is +z.
        const hz = lz + 1, hl = Math.hypot(lx, ly, hz)
        const dotNH = Math.max((n[0] * lx + n[1] * ly + n[2] * hz) / hl, 0), dotVH = Math.max(hz / hl, 0), dotNV = Math.max(n[2], 0)
        const fr = Math.pow(2, (-5.55473 * dotVH - 6.98316) * dotVH), F = f0 * (1 - fr) + f90 * fr
        const gl = dotNV * Math.sqrt(a2 + (1 - a2) * dotNL ** 2), gv = dotNL * Math.sqrt(a2 + (1 - a2) * dotNV ** 2)
        const D = a2 / (Math.PI * (dotNH ** 2 * (a2 - 1) + 1) ** 2)
        w += dotNL * F * (0.5 / (gl + gv)) * D
      }
      w *= spot / Math.max(dist ** DECAY, 0.01)
      for (let c = 0; c < 3; c++) acc[c] += w * L.c[c]
    }
    return neutral(acc as RGB).map(toSRGB) as RGB
  })
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
function clampParams(q: number[]) {
  LAMP_SLOTS.forEach(([id], k) => {
    const o = k * P
    q[o] = clamp(q[o], -FAR, FAR); q[o + 1] = clamp(q[o + 1], -FAR, FAR)
    q[o + 2] = id === 'under' ? clamp(q[o + 2], -FAR, -0.6) : clamp(q[o + 2], 0.6, FAR)
    q[o + 3] = clamp(q[o + 3], -9, 9); q[o + 4] = clamp(q[o + 4], -9, 9)
    q[o + 5] = clamp(q[o + 5], 8 * rad, CONE_MAX * rad); q[o + 6] = clamp(q[o + 6], 0.05, 1)
    for (let c = 7; c < 10; c++) q[o + c] = clamp(q[o + c], -9, 12)
  })
  // The under-glow is pinned under the top of the bulge, as in the app.
  const u = UNDER * P; q[u] = q[u + 3] = PRISM.cx; q[u + 1] = q[u + 4] = PRISM.cy
  for (let c = 0; c < 3; c++) q[ROOM + c] = clamp(q[ROOM + c], -9, 1)
  q[SHAPE + 1] = clamp(q[SHAPE + 1], -0.3, 0.3); q[SHAPE + 2] = process.env.PROFILE ? Number(process.env.PROFILE) : clamp(q[SHAPE + 2], 0.8, 3)
  q[SHAPE] = clamp(q[SHAPE], 0, 8)
  { q[CROSS] = clamp(q[CROSS], 0.3, 20); q[CROSS + 1] = clamp(q[CROSS + 1], 0.5, 12); q[CROSS + 2] = clamp(q[CROSS + 2], 0.5, 12); for (let c = 3; c < 6; c++) q[CROSS + c] = clamp(q[CROSS + c], -9, 10) }
}

const targets = triangleTargets(), totalWeight = targets.reduce((s, t) => s + t.weight, 0)
const shapeOf = (q: number[]) => ({ ...PRISM, dome: q[SHAPE], ridge: q[SHAPE + 1], profile: q[SHAPE + 2] })
const visible = (S: Sample[]) => targets.map((t) => S[t.k]), fixedS = visible(samples())
const samplesFor = (q: number[]) => (FIT_SHAPE ? visible(samples(shapeOf(q))) : fixedS)
const errors = (q: number[]) => shade(q, samplesFor(q)).map((c, i) => deltaE(lab(c), targets[i].lab))
const loss = (q: number[]) => errors(q).reduce((s, e, i) => s + targets[i].weight * e * e, 0) / totalWeight
console.log(`${targets.length} reference triangles in view`)

// Starting rig: red NW, green SE, dim warm off-corners, warm key + under-glow.
// Lamps start far out and low so they act almost like sunlight: facets are
// coloured by which way they face, which is what keeps each triangle flat.
const init: [V3, [number, number], number, RGB][] = [
  [[-16, 11, 6], [-4, 3], 30, [40, 1, 0.5]], [[16, 11, 6], [4, 3], 30, [8, 4, 0.5]],
  [[-16, -11, 6], [-4, -3], 30, [8, 4, 0.5]], [[16, -11, 6], [4, -3], 30, [1, 30, 2]],
  [[0, 0, 12], [0, 0], 40, [12, 11, 6]], [[0, 0, -6], [0, 0], 40, [6, 6, 3]],
]
const current = themes.reference
let q = !process.env.FRESH && current.lamps.length === N_LAMP
  ? current.lamps.flatMap((l) => [...l.pos, ...l.aim, l.cone * rad, l.soft, ...hexToRGB(l.color).map((c) => Math.log(Math.max(toLinear(c) * l.intensity, 1e-4)))])
    .concat(hexToRGB(current.room).map((c) => Math.log(Math.max(toLinear(c) * current.roomStrength, 1e-4))), [Number(process.env.DOME ?? PRISM.dome), PRISM.ridge, Number(process.env.PROFILE ?? PRISM.profile)])
  : init.flatMap(([p, aim, cone, c]) => { const d2 = Math.hypot(p[0] - aim[0], p[1] - aim[1], p[2]) ** 2; return [...p, ...aim, cone * rad, 0.9, ...c.map((x) => Math.log(x * d2 / 10))] })
  .concat([-4, -4, -4], [Number(process.env.DOME ?? PRISM.dome), PRISM.ridge, Number(process.env.PROFILE ?? PRISM.profile)])
const cross0 = current.cross ?? { ...NO_CROSS, intensity: 1 }
q = q.concat([cross0.height, ...cross0.arm], hexToRGB(cross0.color).map((c) => Math.log(Math.max(toLinear(c) * cross0.intensity, 1e-4))))
clampParams(q)

// Adam on forward-difference gradients.
const lr = Number(process.env.LR ?? 0.06), b1 = 0.9, b2 = 0.999, m = q.map(() => 0), v = q.map(() => 0)
let best = q.slice(), bestLoss = loss(q)
const steps = Number(process.env.STEPS ?? 500)
for (let t = 1; t <= steps; t++) {
  const f = loss(q), g = q.map((_, i) => { const e = q.slice(); e[i] += 1e-3; return (loss(e) - f) / 1e-3 })
  if (f < bestLoss) { bestLoss = f; best = q.slice() }
  const rate = lr * (t > steps * 0.7 ? 0.25 : 1)
  q = q.map((x, i) => {
    m[i] = b1 * m[i] + (1 - b1) * g[i]; v[i] = b2 * v[i] + (1 - b2) * g[i] ** 2
    return x - (rate * (m[i] / (1 - b1 ** t))) / (Math.sqrt(v[i] / (1 - b2 ** t)) + 1e-8)
  })
  clampParams(q)
  if (t % 50 === 0) console.log(`step ${t}  rms ΔE ${Math.sqrt(bestLoss).toFixed(2)}`)
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const asLight = (logC: number[]) => {
  const lin = logC.map(Math.exp), peak = Math.max(...lin)
  return { color: rgbToHex(lin.map((c) => toSRGB(c / peak)) as RGB), intensity: round(peak) }
}
const room = asLight(best.slice(ROOM, ROOM + 3))
const rig: Rig = {
  room: room.color, roomStrength: room.intensity, exposure: 1,
  lamps: LAMP_SLOTS.map(([id, name], k) => {
    const o = k * P
    return {
      id, name, ...asLight(best.slice(o + 7, o + 10)),
      pos: [round(best[o]), round(best[o + 1]), round(best[o + 2])], aim: [round(best[o + 3]), round(best[o + 4])],
      cone: round(best[o + 5] / rad, 1), soft: round(best[o + 6]),
    }
  }),
  cross: { ...asLight(best.slice(CROSS + 3, CROSS + 6)), height: round(best[CROSS]), arm: [round(best[CROSS + 1]), round(best[CROSS + 2])] },
}
const err = errors(best), meanDE = err.reduce((s, e, i) => s + targets[i].weight * e, 0) / totalWeight
writeFileSync('src/reference-rig.json', JSON.stringify(rig, null, 2) + '\n')
console.log(`mean ΔE ${meanDE.toFixed(2)} → src/reference-rig.json`)
if (FIT_SHAPE) console.log(`prism shape: dome ${round(best[SHAPE], 3)}, ridge ${round(best[SHAPE + 1], 3)}, profile ${round(best[SHAPE + 2], 3)}`)
// Per-cell report (worst of its two triangles), north at the top.
const cells = new Map<number, number>()
targets.forEach((t, i) => { const c = t.k >> 1; cells.set(c, Math.max(cells.get(c) ?? 0, err[i])) })
const sorted = [...err].sort((a, b) => a - b)
console.log(`per-triangle ΔE  median ${sorted[sorted.length >> 1].toFixed(1)}  90th ${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)}  worst ${sorted[sorted.length - 1].toFixed(1)}`)
for (let j = ROWS - 1; j >= 0; j--) {
  let line = ''
  for (let i = 0; i < COLS; i++) { const e = cells.get(j * COLS + i); line += e == null ? '   .' : e.toFixed(0).padStart(4) }
  console.log(line)
}
// LMAP=1: per-cell lightness (L*), ours over the reference's, to compare the
// bright centre and cross.
if (process.env.LMAP) {
  const ours = shade(best, samplesFor(best)).map((c) => lab(c)[0]), sums = new Map<number, number[]>()
  targets.forEach((t, i) => { const s = sums.get(t.k >> 1) ?? [0, 0, 0]; s[0] += ours[i]; s[1] += t.lab[0]; s[2]++; sums.set(t.k >> 1, s) })
  for (const pick of [0, 1]) {
    console.log(pick ? 'reference L*' : 'ours L*')
    for (let j = ROWS - 1; j >= 0; j--) {
      let line = ''
      for (let i = 0; i < COLS; i++) { const s = sums.get(j * COLS + i); line += s ? (s[pick] / s[2]).toFixed(0).padStart(4) : '   .' }
      console.log(line)
    }
  }
}
