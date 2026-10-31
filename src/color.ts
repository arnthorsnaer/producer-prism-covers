// Small colour toolkit shared by the app's match meter and scripts/fit.ts.
export type RGB = [number, number, number]

export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const toSRGB = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055)

export const hexToRGB = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB
export const rgbToHex = (c: RGB) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')

// Port of three.js NeutralToneMapping (Khronos PBR Neutral), linear in → linear out.
export function neutral([r, g, b]: RGB, exposure = 1): RGB {
  r *= exposure; g *= exposure; b *= exposure
  const x = Math.min(r, g, b), offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  r -= offset; g -= offset; b -= offset
  const peak = Math.max(r, g, b), start = 0.76
  if (peak < start) return [r, g, b]
  const d = 1 - start, newPeak = 1 - (d * d) / (peak + d - start), s = newPeak / peak
  const t = 1 - 1 / (0.15 * (peak - newPeak) + 1)
  return [r * s * (1 - t) + newPeak * t, g * s * (1 - t) + newPeak * t, b * s * (1 - t) + newPeak * t]
}

// sRGB (0..1) → CIE L*a*b* (D65), for perceptual ΔE comparisons.
export function lab([r, g, b]: RGB): RGB {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b)
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
  const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
  const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}

export const deltaE = (p: RGB, q: RGB) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

// HSL (h in degrees, s/l 0..1) → sRGB hex.
export function hslToHex(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l), f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return rgbToHex([f(0), f(8), f(4)])
}
