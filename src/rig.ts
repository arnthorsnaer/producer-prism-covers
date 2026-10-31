import type { V3 } from './prism'
import { hslToHex } from './color'
import fitted from './reference-rig.json'

// Every lamp is a soft-edged spot: `aim` is where it points on the prism plane,
// `cone` its half-angle in degrees (near 90 ≈ bare bulb), `soft` the penumbra.
export type Lamp = { id: string; name: string; color: string; intensity: number; pos: V3; aim: [number, number]; cone: number; soft: number }
// The cross light: two crossed strip lights hanging `height` over the top of the
// bulge (it follows the bulge like the under-glow); `arm` is each strip's half
// length in x and y. It draws the bright row and column through the centre.
export type Cross = { color: string; intensity: number; height: number; arm: [number, number] }
export type Rig = { room: string; roomStrength: number; exposure: number; lamps: Lamp[]; cross?: Cross }

// Physical inverse-square falloff (decay 2, no cutoff) gives the darker rim.
export const DECAY = 2
export const CONE_MAX = 89
// Each strip is CROSS_N points along its length (the fitter uses the same).
export const CROSS_N = 13
export const NO_CROSS: Cross = { color: '#ffffff', intensity: 0, height: 2, arm: [6, 4.5] }

export const LAMP_SLOTS = [
  ['nw', 'North west'], ['ne', 'North east'], ['sw', 'South west'], ['se', 'South east'],
  ['key', 'Overhead key'], ['under', 'Under-glow'],
] as const

type Spec = [color: string, intensity: number, pos: V3, aim?: [number, number], cone?: number, soft?: number]
const lamps = (spec: Spec[]): Lamp[] => LAMP_SLOTS.map(([id, name], k) => {
  const [color, intensity, pos, aim = [pos[0] * 0.8, pos[1] * 0.8], cone = 60, soft = 0.9] = spec[k]
  return { id, name, color, intensity, pos, aim, cone, soft }
})

export const themes: Record<string, Rig> = {
  // Produced by `npm run fit`, which solves the lamps against public/reference.jpg.
  reference: fitted as Rig,
  aurora: { room: '#dff4ff', roomStrength: 0.15, exposure: 1, lamps: lamps([
    ['#7a3dff', 60, [-7, 5, 2.5]], ['#1a7cff', 45, [7, 5, 2.5]], ['#00e0b0', 40, [-7, -5, 2.5]], ['#00ffd0', 55, [7, -5, 2.5]],
    ['#e8fbff', 22, [0, 0, 4], [0, 0], 70], ['#bff6ff', 14, [0, 0, -1.6], [0, 0], 80],
  ]) },
  ember: { room: '#fff0dc', roomStrength: 0.1, exposure: 1, lamps: lamps([
    ['#ff2a10', 70, [-7, 5, 2.2]], ['#ff7a00', 40, [7, 5, 2.4]], ['#ff5000', 40, [-7, -5, 2.4]], ['#ffb030', 50, [7, -5, 2.2]],
    ['#ffd690', 20, [0, 0, 4], [0, 0], 70], ['#ffcc70', 18, [0, 0, -1.6], [0, 0], 80],
  ]) },
  nocturne: { room: '#b7c8ff', roomStrength: 0.05, exposure: 1, lamps: lamps([
    ['#d413ff', 55, [-7, 5, 2.4]], ['#3020ff', 35, [7, 5, 2.4]], ['#0050ff', 35, [-7, -5, 2.4]], ['#00d6ff', 55, [7, -5, 2.4]],
    ['#8aa0ff', 8, [0, 0, 4], [0, 0], 70], ['#7897ff', 10, [0, 0, -1.6], [0, 0], 80],
  ]) },
}

// Rolls the dice on everything in a scene. Ranges follow what the fitted rig
// does (distant, narrow corner spots plus a softer key and an under-glow), and
// intensity is derived from distance² so the light *arriving* stays in a sane
// band wherever a lamp lands; wider cones get less, so a flood doesn't wash out.
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]
const r2 = (n: number) => Math.round(n * 100) / 100
const wrap = (h: number) => ((h % 360) + 360) % 360
const SCHEMES = { analogous: [0, 30, 60, 90], triad: [0, 120, 240, 60], complementary: [0, 180, 30, 210], split: [0, 150, 210, 180] }
const CORNER_AZIMUTH: Record<string, number> = { nw: 135, ne: 45, sw: 225, se: 315 }

type Range = [number, number]
type HSL = { h: number; s: Range; l: Range }
// A mood decides colours and how much light; geometry of the throw is shared.
type Mood = {
  corner: (id: string) => HSL; cornerLight: Range; cone: Range
  key: HSL; keyLight: Range; under: HSL; underLight: Range; cross: HSL; crossLight: Range
  room: HSL; roomStrength: Range; exposure: Range
}
const hex = ({ h, s, l }: HSL) => hslToHex(wrap(h), rand(...s), rand(...l))
const shuffle = <T,>(xs: T[]) => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x)

export type MoodName = 'any' | 'day' | 'night'
const MOODS: Record<MoodName, () => Mood> = {
  any: () => {
    const base = rand(0, 360), offsets = [...pick(Object.values(SCHEMES))].sort(() => Math.random() - 0.5)
    const slot = (id: string) => ['nw', 'ne', 'sw', 'se'].indexOf(id)
    return {
      corner: (id) => ({ h: base + offsets[slot(id)] + rand(-12, 12), s: [0.8, 1], l: [0.45, 0.55] }), cornerLight: [1, 2.5], cone: [10, 50],
      key: { h: base + rand(-40, 40), s: [0.4, 1], l: [0.6, 0.8] }, keyLight: [0.08, 0.35],
      under: { h: rand(0, 360), s: [0.2, 0.8], l: [0.7, 0.9] }, underLight: [2, 8],
      cross: { h: rand(0, 360), s: [0.2, 0.8], l: [0.6, 0.85] }, crossLight: [0.1, 0.6],
      room: { h: rand(0, 360), s: [0, 0.6], l: [0.6, 0.95] }, roomStrength: [0, 0.06], exposure: [0.85, 1.05],
    }
  },
  // Daylight: a warm sun overhead, golden / coral / sky-blue corners, broad soft beams.
  day: () => {
    const [nw, ne, sw, se] = shuffle([rand(35, 55), rand(190, 212), rand(5, 22), pick([rand(35, 55), rand(190, 212)])])
    const hues: Record<string, number> = { nw, ne, sw, se }
    return {
      corner: (id) => ({ h: hues[id], s: [0.75, 1], l: [0.5, 0.6] }), cornerLight: [1.3, 2.6], cone: [18, 45],
      key: { h: rand(35, 55), s: [0.4, 0.9], l: [0.75, 0.88] }, keyLight: [0.15, 0.4],
      under: { h: rand(40, 60), s: [0.3, 0.7], l: [0.8, 0.9] }, underLight: [3, 10],
      cross: { h: pick([rand(195, 215), rand(40, 55)]), s: [0.4, 1], l: [0.65, 0.85] }, crossLight: [0.2, 0.6],
      room: { h: rand(30, 50), s: [0.2, 0.5], l: [0.85, 0.95] }, roomStrength: [0.03, 0.08], exposure: [1, 1.1],
    }
  },
  // Synthwave: violet / magenta / deep-blue sky to the north, hot-pink / sunset /
  // cyan horizon to the south, a near-black room and a neon glow from below.
  night: () => {
    // Drawn without repeats so the pink / cyan / orange accents stay distinct.
    const [nw, ne] = shuffle([rand(260, 285), rand(295, 320), rand(222, 238)]), [sw, se] = shuffle([rand(325, 345), rand(12, 28), rand(178, 192)])
    const hues: Record<string, number> = { nw, ne, sw, se }
    return {
      corner: (id) => ({ h: hues[id], s: [0.95, 1], l: [0.48, 0.55] }), cornerLight: [0.9, 2.2], cone: [8, 30],
      key: { h: rand(270, 310), s: [0.6, 1], l: [0.45, 0.6] }, keyLight: [0.02, 0.12],
      under: { h: pick([rand(178, 192), rand(300, 330)]), s: [0.9, 1], l: [0.5, 0.6] }, underLight: [1.5, 5],
      cross: { h: pick([rand(178, 192), rand(300, 330), rand(270, 290)]), s: [0.9, 1], l: [0.5, 0.65] }, crossLight: [0.1, 0.5],
      room: { h: rand(235, 265), s: [0.6, 1], l: [0.12, 0.25] }, roomStrength: [0, 0.03], exposure: [0.8, 0.95],
    }
  },
}

export function randomRig(moodName: MoodName = 'any'): Rig {
  const mood = MOODS[moodName]()
  const lamp = (id: string, name: string): Lamp => {
    let pos: V3, aim: [number, number], cone: number, soft: number, color: string, arriving: number
    if (id in CORNER_AZIMUTH) {
      const az = (CORNER_AZIMUTH[id] + rand(-35, 35)) * Math.PI / 180, reach = rand(8, 30)
      pos = [Math.cos(az) * reach, Math.sin(az) * reach, rand(4, 28)]
      // Aim into its own corner so each colour pools rather than greying out in the middle.
      const into = rand(1.5, 5); aim = [Math.cos(az) * into * 1.3 + rand(-1, 1), Math.sin(az) * into + rand(-1, 1)]; cone = rand(...mood.cone); soft = rand(0.4, 1)
      color = hex(mood.corner(id)); arriving = rand(...mood.cornerLight) * (20 / cone) ** 0.7
    } else if (id === 'key') {
      pos = [rand(-4, 4), rand(-4, 4), rand(8, 22)]; aim = [rand(-2, 2), rand(-2, 2)]; cone = rand(15, 45); soft = rand(0.5, 1)
      color = hex(mood.key); arriving = rand(...mood.keyLight)
    } else {
      pos = [rand(-2, 2), rand(-2, 2), rand(-3, -0.5)]; aim = [rand(-1, 1), rand(-1, 1)]; cone = rand(60, CONE_MAX); soft = 1
      color = hex(mood.under); arriving = rand(...mood.underLight)
    }
    const d2 = (pos[0] - aim[0]) ** 2 + (pos[1] - aim[1]) ** 2 + pos[2] ** 2
    return { id, name, color, intensity: r2(arriving * d2), pos: pos.map(r2) as V3, aim: aim.map(r2) as [number, number], cone: r2(cone), soft: r2(soft) }
  }
  return {
    room: hex(mood.room), roomStrength: r2(rand(...mood.roomStrength)), exposure: r2(rand(...mood.exposure)),
    lamps: LAMP_SLOTS.map(([id, name]) => lamp(id, name)),
    cross: (() => { const height = rand(1, 4); return { color: hex(mood.cross), intensity: r2(rand(...mood.crossLight) * height ** 2), height: r2(height), arm: [r2(rand(3, 8)), r2(rand(2.5, 6))] } })(),
  }
}
