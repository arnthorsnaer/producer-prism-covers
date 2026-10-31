import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useThree } from '@react-three/fiber'
import { Line, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import { GRID, PRISM, SURFACE, VIEW, gridFor, prismTriangles, faceNormal, facetCentre, randomShape, type Shape } from './prism'
import { CONE_MAX, CROSS_N, DECAY, NO_CROSS, randomRig, themes, type Cross, type Lamp, type Rig } from './rig'
import { deltaE, lab, type RGB } from './color'
import { INKS, TITLE, drawTitle, fontsReady, inkColor, layoutTitle, meanColor, pickInk, sampleBox, type Ink, type RGB8, type Title } from './title'
import './styles.css'

type Compare = 'none' | 'side' | 'stack' | 'wipe'

// Output formats. Each shows the same amount of land as the reference crop
// (landscape) at zoom 1, centred on the same point, in its own aspect.
const FORMATS = [
  { id: 'landscape', name: 'Landscape', ar: 1.4, out: [3500, 2500] },
  { id: 'cover', name: 'Cover', ar: 1, out: [3000, 3000] },
  { id: 'portrait', name: 'Portrait', ar: 9 / 16, out: [2160, 3840] },
  { id: 'header', name: 'Social header', ar: 3, out: [4500, 1500] },
] as const
type Format = (typeof FORMATS)[number]
// The window of land a format shows at a zoom (zoom 2 = twice as close).
const windowOf = (f: Format, zoom: number) => {
  const area = VIEW.w * VIEW.h
  return { cx: VIEW.cx, cy: VIEW.cy, w: Math.sqrt(area * f.ar) / zoom, h: Math.sqrt(area / f.ar) / zoom }
}
type Win = ReturnType<typeof windowOf>
// Zoom is a log slider: 1/4× to 4×.
const ZOOM_MIN = -2, ZOOM_MAX = 2

function usePrismMaterial() {
  return useMemo(() => {
    const m = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: SURFACE.roughness, metalness: 0, ior: 1.5, specularIntensity: SURFACE.specularIntensity, side: THREE.DoubleSide })
    // Frosted glass is not just reflective: light arriving from behind a facet
    // scatters through it. three.js has no thin-sheet transmission for direct
    // lights, so add it to the physical BRDF (this is what the under-glow uses).
    const lambert = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );'
    const chunk = THREE.ShaderChunk.lights_physical_pars_fragment
    if (!chunk.includes(lambert)) console.warn('prism: translucency hook not found in three.js shader chunk')
    const translucent = chunk.replace(lambert, `${lambert}
	reflectedLight.directDiffuse += saturate( -dot( geometryNormal, directLight.direction ) ) * directLight.color * BRDF_Lambert( material.diffuseColor ) * ${SURFACE.translucency.toFixed(3)};`)
    // Each tile acts as a small diffuser: lighting is evaluated once at the facet
    // centre (not per pixel), so every triangle carries a single flat colour.
    const begin = THREE.ShaderChunk.lights_fragment_begin
      .replace('vec3 geometryPosition = - vViewPosition;', 'vec3 geometryPosition = vFacetView;')
      .replace('normalize( vViewPosition )', 'normalize( - vFacetView )')
    m.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader
        .replace('void main() {', 'attribute vec3 facet;\nvarying vec3 vFacetView;\nvoid main() {')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvFacetView = ( modelViewMatrix * vec4( facet, 1.0 ) ).xyz;')
      s.fragmentShader = s.fragmentShader
        .replace('void main() {', 'varying vec3 vFacetView;\nvoid main() {')
        .replace('#include <lights_physical_pars_fragment>', translucent)
        .replace('#include <lights_fragment_begin>', begin)
    }
    m.customProgramCacheKey = () => 'prism-faceted'
    return m
  }, [])
}

function Prism({ shape, grid }: { shape: Shape; grid: typeof GRID }) {
  const geometry = useMemo(() => {
    const pos: number[] = [], normals: number[] = [], facets: number[] = []
    for (const t of prismTriangles(shape, grid)) {
      const n = faceNormal(t), c = facetCentre(t)
      for (const v of t) { pos.push(...v); normals.push(...n); facets.push(...c) }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    g.setAttribute('facet', new THREE.Float32BufferAttribute(facets, 3))
    return g
  }, [shape, grid])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh geometry={geometry} material={usePrismMaterial()} />
}

function Renderer({ exposure }: { exposure: number }) {
  const gl = useThree((s) => s.gl)
  // Neutral keeps saturated light colours saturated (ACES pushed them to pastel).
  useEffect(() => { gl.toneMapping = THREE.NeutralToneMapping; gl.toneMappingExposure = exposure }, [gl, exposure])
  return null
}

// Plan view of a window of land, framed like an <img> with object-fit: contain.
// The camera sits high so even a deep bowl far out stays in front of it.
const CAM_Z = 200
const viewZoom = (size: { width: number; height: number }, win: Win) => Math.min(size.width / win.w, size.height / win.h)
function TopCamera({ win }: { win: Win }) {
  const size = useThree((s) => s.size)
  return <OrthographicCamera makeDefault position={[win.cx, win.cy, CAM_Z]} zoom={viewZoom(size, win)} near={0.1} far={CAM_Z * 4} />
}

// public/ files live under the deploy's base path (GitHub Pages serves from /<repo>/).
const REFERENCE = `${import.meta.env.BASE_URL}reference.jpg`
const MATCH_W = 70, MATCH_H = 50, VIEW_WIN: Win = { ...VIEW }
const readPixels = (ctx: CanvasRenderingContext2D): RGB[] => {
  const d = ctx.getImageData(0, 0, MATCH_W, MATCH_H).data, out: RGB[] = []
  for (let i = 0; i < d.length; i += 4) out.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255])
  return out
}

// Samples the live frame and the reference at 70×50 and reports mean ΔE (CIE76).
function MatchMeter({ onScore }: { onScore: (de: number | null) => void }) {
  const gl = useThree((s) => s.gl), size = useThree((s) => s.size)
  useEffect(() => {
    const ctx = () => Object.assign(document.createElement('canvas'), { width: MATCH_W, height: MATCH_H }).getContext('2d', { willReadFrequently: true })!
    const live = ctx(), ref = ctx(), img = new Image()
    let target: RGB[] | null = null
    img.onload = () => { ref.imageSmoothingQuality = 'high'; ref.drawImage(img, 0, 0, MATCH_W, MATCH_H); target = readPixels(ref).map(lab) }
    img.src = REFERENCE
    const id = setInterval(() => {
      if (!target) return
      const dpr = gl.getPixelRatio(), z = viewZoom(size, VIEW_WIN) * dpr
      const w = VIEW.w * z, h = VIEW.h * z
      live.imageSmoothingQuality = 'high'
      live.drawImage(gl.domElement, (size.width * dpr - w) / 2, (size.height * dpr - h) / 2, w, h, 0, 0, MATCH_W, MATCH_H)
      const px = readPixels(live)
      onScore(px.reduce((s, c, i) => s + deltaE(lab(c), target![i]), 0) / px.length)
    }, 500)
    return () => { clearInterval(id); onScore(null) }
  }, [gl, size, onScore])
  return null
}

// Grayscale with the same weights as CSS grayscale(1), so the export matches
// what the views show.
export const grayOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
function toGray(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const img = ctx.getImageData(x, y, w, h), d = img.data
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = grayOf(d[i], d[i + 1], d[i + 2])
  ctx.putImageData(img, x, y)
}

// Print export: re-renders a format's window at its output size (or a multiple)
// in tiles, so no GPU drawing-buffer limit applies, and stitches them into one
// canvas. Every tile shares the camera, so the shading is identical. Tone
// mapping, sRGB and MSAA are as on screen; lamp helpers are hidden. The main
// view builds land for every format's window, so it can export any of them.
export type Shoot = (scale: number, f: Format, zoom: number, title: Title, gray: boolean, ink: string) => Promise<Blob>
const TILE_W = 1750, TILE_H = 1250
function Exporter({ shoot }: { shoot: React.MutableRefObject<Shoot | null> }) {
  const gl = useThree((s) => s.gl), scene = useThree((s) => s.scene), size = useThree((s) => s.size)
  useEffect(() => {
    shoot.current = async (scale, f, zoom, title, gray, ink) => {
      await fontsReady(title.weight)
      const W = f.out[0] * scale, H = f.out[1] * scale, dpr = gl.getPixelRatio(), win = windowOf(f, zoom)
      const out = Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = out.getContext('2d')!
      const cam = new THREE.OrthographicCamera(-win.w / 2, win.w / 2, win.h / 2, -win.h / 2, 0.1, CAM_Z * 4)
      cam.position.set(win.cx, win.cy, CAM_Z); cam.lookAt(win.cx, win.cy, 0)
      const helpers = scene.getObjectByName('helpers')
      if (helpers) helpers.visible = false
      gl.setPixelRatio(1); gl.setSize(TILE_W, TILE_H, false)
      for (let y = 0; y < H; y += TILE_H) for (let x = 0; x < W; x += TILE_W) {
        cam.setViewOffset(W, H, x, y, TILE_W, TILE_H)
        gl.render(scene, cam)
        ctx.drawImage(gl.domElement, x, y)
        if (gray) toGray(ctx, x, y, TILE_W, TILE_H)
      }
      if (helpers) helpers.visible = true
      gl.setPixelRatio(dpr); gl.setSize(size.width, size.height, false)
      // The title goes on last, in the ink every format shares; its shadow is tinted from the pixels under it.
      const l = layoutTitle(ctx, title, win, W, H)
      if (l) { const px = sampleBox(out, l.box, 1, 1), c = meanColor(px); drawTitle(ctx, l, ink, gray ? c.map(() => grayOf(...c)) as RGB8 : c) }
      return new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
    }
    return () => { shoot.current = null }
  }, [gl, scene, size, shoot])
  return null
}

// The cross light as CROSS_N point lights per strip, centred over the top.
const crossPoints = (c: Cross, top: [number, number]): Lamp['pos'][] => [0, 1].flatMap((axis) =>
  Array.from({ length: CROSS_N }, (_, k) => { const t = (k / (CROSS_N - 1)) * 2 - 1, a = c.arm[axis] * t; return [top[0] + (axis ? 0 : a), top[1] + (axis ? a : 0), c.height] as Lamp['pos'] }))
function CrossLight({ cross, top }: { cross: Cross; top: [number, number] }) {
  if (cross.intensity <= 0) return null
  return <>{crossPoints(cross, top).map((p, k) => <pointLight key={k} position={p} color={cross.color} intensity={cross.intensity / CROSS_N} distance={0} decay={DECAY} />)}</>
}

function Spot({ lamp }: { lamp: Lamp }) {
  // The target must live in the scene graph so its world matrix stays current.
  const target = useMemo(() => new THREE.Object3D(), [])
  target.position.set(lamp.aim[0], lamp.aim[1], 0)
  return <>
    <primitive object={target} />
    <spotLight color={lamp.color} intensity={lamp.intensity} position={lamp.pos} target={target} angle={lamp.cone * THREE.MathUtils.DEG2RAD} penumbra={lamp.soft} distance={0} decay={DECAY} />
  </>
}

type SceneProps = { rig: Rig; shape: Shape; format: Format; zoom: number; iso?: boolean; onScore?: (de: number | null) => void; shoot?: React.MutableRefObject<Shoot | null> }
const Scene = memo(function Scene({ rig, shape, format, zoom, iso = false, onScore, shoot }: SceneProps) {
  const win = windowOf(format, zoom)
  // Land under this view; the main view (the one that exports) covers every
  // format's window, and the isometric view at least the original slab.
  const grid = useMemo(() => {
    const wins = shoot ? FORMATS.map((f) => windowOf(f, zoom)) : [win]
    const w = Math.max(...wins.map((x) => x.w), iso ? GRID.cols : 0), h = Math.max(...wins.map((x) => x.h), iso ? GRID.rows : 0)
    return gridFor(win.cx, win.cy, w, h)
  }, [shoot, zoom, iso, win.cx, win.cy, win.w, win.h])
  return <Canvas dpr={shoot ? [1, 2] : 1} gl={{ preserveDrawingBuffer: true, antialias: true }}>
    <color attach="background" args={['#111316']} />
    <Renderer exposure={rig.exposure} />
    {shoot && <Exporter shoot={shoot} />}
    {iso
      ? <><PerspectiveCamera makeDefault position={[15, -21, 17]} up={[0, 0, 1]} fov={40} far={CAM_Z * 4} /><OrbitControls enablePan={false} minDistance={8} maxDistance={80} /></>
      : <><TopCamera win={win} />{onScore && format.id === 'landscape' && zoom === 1 && <MatchMeter onScore={onScore} />}</>}
    <ambientLight color={rig.room} intensity={rig.roomStrength} />
    {rig.lamps.map((l) => <Spot key={l.id} lamp={l} />)}
    <CrossLight cross={rig.cross ?? NO_CROSS} top={[shape.cx, shape.cy]} />
    <Prism shape={shape} grid={grid} />
    <group name="helpers">{iso && (rig.cross?.intensity ?? 0) > 0 && [0, 1].map((axis) => { const c = rig.cross!, a = c.arm[axis]
      return <Line key={axis} points={[[shape.cx - (axis ? 0 : a), shape.cy - (axis ? a : 0), c.height], [shape.cx + (axis ? 0 : a), shape.cy + (axis ? a : 0), c.height]]} color={c.color} lineWidth={3} /> })}
    {iso && rig.lamps.map((l) => <group key={l.id}>
      <mesh position={l.pos}><sphereGeometry args={[0.14, 16, 16]} /><meshBasicMaterial color={l.color} toneMapped={false} /></mesh>
      <Line points={[l.pos, [l.aim[0], l.aim[1], 0]]} color={l.color} lineWidth={1} dashed dashSize={0.2} gapSize={0.15} transparent opacity={0.6} />
    </group>)}</group>
  </Canvas>
})

// The title over a view, drawn by the same code as the export. In auto ink it
// re-reads the pixels under itself a few times a second. On the main view it can
// be dragged; the drag sets the format-agnostic u, v and every format follows.
// Every view's pixels under its title, by format id. The app picks one auto
// ink from all of them together, so every format (and the export) agrees.
type Samples = React.MutableRefObject<Map<string, Uint8ClampedArray>>
function TitleOverlay({ title, win, gray, ink, samples, id, onMove }: { title: Title; win: Win; gray: boolean; ink: string; samples: Samples; id: string; onMove?: (t: Title) => void }) {
  const ref = useRef<HTMLCanvasElement>(null), [size, setSize] = useState({ w: 0, h: 0 })
  const [bg, setBg] = useState<RGB8>([0, 0, 0]), [fonts, setFonts] = useState(0)
  useEffect(() => { fontsReady(title.weight).then(() => setFonts((n) => n + 1)) }, [title.weight])
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(ref.current!); return () => ro.disconnect()
  }, [])
  const layout = useMemo(() => (size.w ? layoutTitle(ref.current!.getContext('2d')!, title, win, size.w, size.h) : null),
    [title, win.cx, win.cy, win.w, win.h, size, fonts]) // eslint-disable-line react-hooks/exhaustive-deps
  const color = ink
  useEffect(() => {
    const c = ref.current!, dpr = devicePixelRatio, ctx = c.getContext('2d')!
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (layout) drawTitle(ctx, layout, color, bg)
  }, [layout, color, bg, size])
  useEffect(() => {
    if (!layout) return
    const read = () => {
      const gl = ref.current?.parentElement?.querySelector<HTMLCanvasElement>('canvas:not(.title-layer)')
      if (!gl?.width) return
      const px = sampleBox(gl, layout.box, gl.width / size.w, gl.height / size.h), c = meanColor(px), m = gray ? c.map(() => grayOf(...c)) as RGB8 : c
      samples.current.set(id, px)
      setBg((prev) => (prev.every((c, i) => Math.abs(c - m[i]) < 2) ? prev : m))
    }
    read(); const timer = setInterval(read, 400); return () => clearInterval(timer)
  }, [layout, size, gray, samples, id])
  const grab = useRef<{ x: number; y: number; u: number; v: number } | null>(null)
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  return <>
    <canvas ref={ref} className="title-layer" />
    {onMove && layout && <div className="title-grab" title="Drag to move the title · it snaps to rows and columns in every format"
      style={{ left: layout.box.x - 8, top: layout.box.y - 8, width: layout.box.w + 16, height: layout.box.h + 16 }}
      onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); grab.current = { x: e.clientX, y: e.clientY, u: title.u, v: title.v } }}
      onPointerMove={(e) => { const g = grab.current; if (!g) return; e.stopPropagation(); onMove({ ...title, u: clamp(g.u + (e.clientX - g.x) / size.w), v: clamp(g.v + (e.clientY - g.y) / size.h) }) }}
      onPointerUp={() => { grab.current = null }} />}
  </>
}

// Intensity is a log slider: far "sun-like" lamps need thousands, near fills need tens.
const LOG_MIN = -1, LOG_MAX = 5.5, toSlider = (i: number) => (i <= 0 ? LOG_MIN : Math.log10(i)), fromSlider = (s: number) => (s <= LOG_MIN + 0.01 ? 0 : 10 ** s)
const FAR = 40
const range = (label: string, value: number, set: (n: number) => void, min: number, max: number, step = 0.05, fmt = (n: number) => n.toFixed(1)) =>
  <label className="range"><span>{label}<b>{fmt(value)}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)} /></label>

function LampControls({ lamp, set }: { lamp: Lamp; set: (l: Lamp) => void }) {
  const under = lamp.id === 'under'
  const axis = (k: 0 | 1 | 2, label: string, min: number, max: number) =>
    range(label, lamp.pos[k], (v) => { const pos = [...lamp.pos] as Lamp['pos']; pos[k] = v; set({ ...lamp, pos }) }, min, max)
  const aim = (k: 0 | 1, label: string) =>
    range(label, lamp.aim[k], (v) => { const a = [...lamp.aim] as Lamp['aim']; a[k] = v; set({ ...lamp, aim: a }) }, -10, 10)
  return <div className="corner">
    <label className="color"><span>{lamp.name}</span><input type="color" value={lamp.color} onChange={(e) => set({ ...lamp, color: e.target.value })} /></label>
    <label className="range"><span>Intensity<b>{lamp.intensity < 100 ? lamp.intensity.toFixed(1) : Math.round(lamp.intensity)}</b></span>
      <input type="range" min={LOG_MIN} max={LOG_MAX} step={0.005} value={toSlider(lamp.intensity)} onChange={(e) => set({ ...lamp, intensity: fromSlider(+e.target.value) })} /></label>
    <details><summary>Position & beam</summary>
      {under
        ? <><p className="follows">X, Y and aim follow the top of the bulge</p><div className="xyz">{axis(2, 'Depth', -FAR, -0.3)}</div></>
        : <><div className="xyz">{axis(0, 'X', -FAR, FAR)}{axis(1, 'Y', -FAR, FAR)}{axis(2, 'Height', 0.3, FAR)}</div>
          <div className="xyz">{aim(0, 'Aim X')}{aim(1, 'Aim Y')}</div></>}
      <div className="xyz">{range('Cone °', lamp.cone, (v) => set({ ...lamp, cone: v }), 5, CONE_MAX, 0.5)}{range('Soft', lamp.soft, (v) => set({ ...lamp, soft: v }), 0, 1, 0.01, (n) => n.toFixed(2))}</div>
    </details>
  </div>
}

function CrossControls({ cross, set }: { cross: Cross; set: (c: Cross) => void }) {
  return <div className="corner">
    <label className="color"><span>Cross light</span><input type="color" value={cross.color} onChange={(e) => set({ ...cross, color: e.target.value })} /></label>
    <label className="range"><span>Intensity<b>{cross.intensity.toFixed(2)}</b></span>
      <input type="range" min={LOG_MIN} max={3} step={0.005} value={toSlider(cross.intensity)} onChange={(e) => set({ ...cross, intensity: fromSlider(+e.target.value) })} /></label>
    <details><summary>Size & height</summary>
      <p className="follows">Centred over the top of the bulge</p>
      <div className="xyz">{range('Height', cross.height, (v) => set({ ...cross, height: v }), 0.3, 20)}{range('Arm X', cross.arm[0], (v) => set({ ...cross, arm: [v, cross.arm[1]] }), 0.5, 12)}{range('Arm Y', cross.arm[1], (v) => set({ ...cross, arm: [cross.arm[0], v] }), 0.5, 12)}</div>
    </details>
  </div>
}

function App() {
  const [rig, setRig] = useState<Rig>(themes.reference), [theme, setTheme] = useState('reference'), [base, setBase] = useState<Rig>(themes.reference)
  const [iso, setIso] = useState(() => location.hash === '#iso'), [compare, setCompare] = useState<Compare>('none')
  const [formatId, setFormatId] = useState<Format['id']>('landscape'), [zoom, setZoom] = useState(1)
  const format = FORMATS.find((f) => f.id === formatId)!
  const [score, setScore] = useState<number | null>(null), [wipe, setWipe] = useState(50)
  const [title, setTitle] = useState<Title>(TITLE), [gray, setGray] = useState(false)
  // One auto ink for all formats, judged on everything under every title.
  const samples = useRef(new Map<string, Uint8ClampedArray>()), [autoInk, setAutoInk] = useState<string>(INKS.white)
  useEffect(() => {
    const id = setInterval(() => {
      const all = [...samples.current.values()]
      if (!all.length) return
      const px = new Uint8ClampedArray(all.reduce((n, a) => n + a.length, 0))
      all.reduce((at, a) => (px.set(a, at), at + a.length), 0)
      setAutoInk((prev) => pickInk(px, prev))
    }, 400)
    return () => clearInterval(id)
  }, [])
  const ink = inkColor(title, autoInk)
  const shoot = useRef<Shoot | null>(null), [saving, setSaving] = useState<string | null>(null)
  const download = async (scale: number, formats: readonly Format[]) => {
    if (!shoot.current) return
    setSaving(`${scale}×…`)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      for (const f of formats) {
        const url = URL.createObjectURL(await shoot.current(scale, f, zoom, title, gray, ink))
        Object.assign(document.createElement('a'), { href: url, download: `prism-${theme}${gray ? '-gray' : ''}-${f.id}-${f.out[0] * scale}x${f.out[1] * scale}-${stamp}.png` }).click()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      }
      setSaving(null)
    } catch (e) { setSaving((e as Error).message) }
  }
  // Master dimmer: scales every lamp and the room light together, so a roll's
  // balance of colours is kept. It sits outside the rig and survives new rolls.
  const [master, setMaster] = useState(1), [shape, setShape] = useState<Shape>(PRISM)
  const shapeRange = (label: string, key: keyof Shape, min: number, max: number, step = 0.01) => range(label, shape[key], (v) => setShape({ ...shape, [key]: v }), min, max, step, (n) => n.toFixed(2))
  // The under-glow sits right under the top of the bulge and shines up at it.
  const lit = useMemo(() => ({
    ...rig, roomStrength: rig.roomStrength * master, cross: { ...(rig.cross ?? NO_CROSS), intensity: (rig.cross ?? NO_CROSS).intensity * master },
    lamps: rig.lamps.map((l) => ({ ...l, intensity: l.intensity * master, ...(l.id === 'under' && { pos: [shape.cx, shape.cy, l.pos[2]] as Lamp['pos'], aim: [shape.cx, shape.cy] as Lamp['aim'] }) })),
  }), [rig, master, shape])
  const load = (name: string, r: Rig) => { setTheme(name); setBase(r); setRig(r) }
  const randomZoom = () => setZoom(Math.round(2 ** (-1.5 + Math.random() * 2.7) * 100) / 100)
  // The master roll: lights (in a random mood), shape and zoom at once.
  const rollEverything = () => {
    load('random-everything', randomRig((['any', 'day', 'night'] as const)[Math.floor(Math.random() * 3)]))
    setShape(randomShape('all', shape)); randomZoom()
  }
  const choose = (name: string) => load(name, themes[name])
  const setLamp = (l: Lamp) => setRig((r) => ({ ...r, lamps: r.lamps.map((x) => (x.id === l.id ? l : x)) }))
  const toggle = (mode: Compare) => setCompare(compare === mode ? 'none' : mode)
  const wiping = compare === 'wipe' && !iso
  // The reference is only comparable in landscape at zoom 1.
  const comparable = format.id === 'landscape' && zoom === 1
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!wiping || !e.buttons) return
    const r = e.currentTarget.getBoundingClientRect()
    setWipe(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }
  return <main className={gray ? "gray" : ""}>
    <section className="stage">
    <div className={`main-view compare-${compare}`}>
      <div className={`visual generated ${wiping ? 'wiping' : ''}`} onPointerDown={drag} onPointerMove={drag}>
        <div className={iso ? 'frame' : 'frame window'} style={{ '--ar': format.ar } as React.CSSProperties}><Scene rig={lit} shape={shape} format={format} zoom={zoom} iso={iso} onScore={setScore} shoot={shoot} />
          {!iso && !wiping && <TitleOverlay title={title} win={windowOf(format, zoom)} gray={gray} ink={ink} samples={samples} id={format.id} onMove={setTitle} />}</div>
        {wiping && <><img className="wipe-ref" src={REFERENCE} alt="" style={{ clipPath: `inset(0 0 0 ${wipe}%)` }} /><div className="wipe-handle" style={{ left: `${wipe}%` }} /></>}
        <span className="panel-tag">{wiping ? 'DRAG TO WIPE · ' : ''}{format.name.toUpperCase()} · {zoom.toFixed(2)}×{score != null && comparable && !iso && <b> · ΔE {score.toFixed(1)}</b>}</span>
      </div>
      {(compare === 'side' || compare === 'stack') && <figure className="visual reference"><img src={REFERENCE} alt="Geometric abstract reference" /><figcaption>REFERENCE IMAGE</figcaption></figure>}
      <div className="label"><i></i>PRISMATIC STUDY <small>ENDLESS LAND · SHAPE & LIGHTING LIVE</small></div>
      <div className="view-bar">
        <button className="view" onClick={() => setIso(!iso)}>{iso ? 'TOP DOWN' : 'ISOMETRIC'} <span>↗</span></button>
        <button className={`compare ${compare === 'side' ? 'selected' : ''}`} onClick={() => toggle('side')}>SIDE × SIDE</button>
        <button className={`compare ${compare === 'stack' ? 'selected' : ''}`} onClick={() => toggle('stack')}>ABOVE / BELOW</button>
        <button className={`compare ${compare === 'wipe' ? 'selected' : ''}`} onClick={() => toggle('wipe')}>WIPE</button>
        <button className={`compare ${gray ? 'selected' : ''}`} onClick={() => setGray(!gray)} title="Show and save the artwork in black and white (the title keeps its colour)">GRAYSCALE</button>
      </div>
    </div>
    <div className="thumbs">
      {FORMATS.filter((f) => f.id !== formatId).map((f) =>
        <button key={f.id} className="thumb" style={{ '--ar': f.ar } as React.CSSProperties} onClick={() => setFormatId(f.id)} title={`Focus ${f.name}`}>
          <Scene rig={lit} shape={shape} format={f} zoom={zoom} />
          <TitleOverlay title={title} win={windowOf(f, zoom)} gray={gray} ink={ink} samples={samples} id={f.id} />
          <span>{f.name.toUpperCase()}</span>
        </button>)}
    </div>
    </section>
    <aside>
      <header><p>LIGHT LAB / 01</p><h1>Glass prism<br /><em>in colored light.</em></h1><div className="rule" /></header>
      <section className="themes"><button className="roll-all" onClick={rollEverything} title="Roll lights, shape and zoom together">🎲 Randomize everything</button>
        <p className="corner-title">SCENES</p><div>
        {Object.keys(themes).map((x) => <button onClick={() => choose(x)} className={theme === x ? 'active' : ''} key={x}>{x}</button>)}
      </div><p className="corner-title">RANDOMIZE COLORS / LIGHTS</p><div>
        {([['any', '🎲 anything'], ['day', '☀ day'], ['night', '☾ night']] as const).map(([mood, label]) =>
          <button key={mood} onClick={() => load(`random-${mood}`, randomRig(mood))} className={theme === `random-${mood}` ? 'active' : ''} title="Roll the dice on every light">{label}</button>)}
        <button onClick={() => setRig(base)}>↺ reset</button>
      </div><p className="corner-title">RANDOMIZE SHAPE</p><div>
        <button onClick={() => setShape(randomShape('all', shape))} title="Roll where the bulge sits, how bulgy and how wide; pattern and under-glow follow">🎲 bulge</button>
        <button onClick={() => setShape(randomShape('move', shape))} title="Move the top of the bulge only; pattern and under-glow follow">🎲 position</button>
        <button onClick={() => setShape(PRISM)} className={shape === PRISM ? 'active' : ''}>↺ default</button>
      </div><p className="corner-title">RANDOMIZE ZOOM</p><div>
        <button onClick={randomZoom} title="Roll how close the camera is">🎲 zoom</button>
        <button onClick={() => setZoom(1)} className={zoom === 1 ? 'active' : ''}>↺ 1×</button>
      </div><p className="corner-title">SAVE IMAGE · {format.name.toUpperCase()}</p><div>
        {[1, 2].map((k) => <button key={k} onClick={() => download(k, [format])} disabled={saving?.endsWith('…')} title="Lossless PNG of the focused format, sRGB">⤓ PNG {format.out[0] * k}×{format.out[1] * k}</button>)}
        <button onClick={() => download(1, FORMATS)} disabled={saving?.endsWith('…')} title="One PNG per format, at 1×">⤓ all 4 formats</button>
        {saving && <span className="saving">{saving}</span>}
      </div></section>
      <section className="controls">
        <p>MASTER</p>
        <label className="range master"><span>All lights<b>{Math.round(master * 100)}%</b></span><input type="range" min={0} max={1.5} step={0.01} value={master} onChange={(e) => setMaster(+e.target.value)} onDoubleClick={() => setMaster(1)} title="Dims or boosts every light at once · double-click for 100%" /></label>
        <label className="range"><span>Zoom (− out · + in)<b>{zoom.toFixed(2)}×</b></span><input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.01} value={Math.log2(zoom)} onChange={(e) => setZoom(Math.round(2 ** +e.target.value * 100) / 100)} onDoubleClick={() => setZoom(1)} title="Camera height over the land · double-click for 1×" /></label>
        <p className="corner-title">TITLE</p>
        <div className="title-row">
          <input className="title-text" value={title.text} onChange={(e) => setTitle({ ...title, text: e.target.value })} placeholder="Title" spellCheck={false} />
          <label className="check"><input type="checkbox" checked={title.show} onChange={(e) => setTitle({ ...title, show: e.target.checked })} />show</label>
        </div>
        <div className="inks">
          {(['auto', 'white', 'gray', 'black'] as const).map((k) => <button key={k} className={title.ink === k ? 'active' : ''} onClick={() => setTitle({ ...title, ink: k })}
            title={k === 'auto' ? 'White, dark gray or black, whichever reads best over what is under it' : undefined}>{k === 'auto' ? 'auto' : <><i style={{ background: INKS[k] }} />{k}</>}</button>)}
          <label className={`custom ${title.ink.startsWith('#') ? 'active' : ''}`} title="Custom colour"><input type="color" value={title.ink.startsWith('#') ? title.ink : '#ffffff'} onChange={(e) => setTitle({ ...title, ink: e.target.value as Ink })} /></label>
        </div>
        {range('Size (of a row)', title.size, (v) => setTitle({ ...title, size: v }), 0.25, 0.85, 0.01, (n) => `${Math.round(n * 100)}%`)}
        {range('Letter spacing', title.spacing, (v) => setTitle({ ...title, spacing: v }), 0.1, 1.6, 0.01, (n) => n.toFixed(2))}
        {range('Weight', title.weight, (v) => setTitle({ ...title, weight: v }), 300, 900, 100, (n) => String(n))}
        <div className="xyz">{range('Across', title.u, (v) => setTitle({ ...title, u: v }), 0, 1, 0.01, (n) => n.toFixed(2))}{range('Down', title.v, (v) => setTitle({ ...title, v }), 0, 1, 0.01, (n) => n.toFixed(2))}
          <button className="small" onClick={() => setTitle({ ...title, u: TITLE.u, v: TITLE.v })}>↺ centre</button></div>
        <p className="follows">Drag it in the main view. One position for all formats; each snaps it to its own rows and columns.</p>
        <p className="corner-title">SHAPE</p>
        {shapeRange('Bulge (− = bowl)', 'dome', -3, 4)}
        {shapeRange('Top X (pattern + glow follow)', 'cx', VIEW.cx - VIEW.w * 0.75, VIEW.cx + VIEW.w * 0.75)}
        {shapeRange('Top Y (pattern + glow follow)', 'cy', VIEW.cy - VIEW.h * 0.75, VIEW.cy + VIEW.h * 0.75)}
        {shapeRange('Spread', 'spread', 0.4, 2.5)}
        {shapeRange('Profile (1 pyramid · 2 round)', 'profile', 0.8, 3)}
        {shapeRange('Fold (per cell)', 'ridge', -0.3, 0.3, 0.005)}
        {shapeRange('Pattern offset X (from top)', 'ox', -6, 6, 0.5)}
        {shapeRange('Pattern offset Y (from top)', 'oy', -6, 6, 0.5)}
        <p className="corner-title">ROOM & CAMERA</p>
        <label className="color"><span>Room light</span><input type="color" value={rig.room} onChange={(e) => setRig({ ...rig, room: e.target.value })} /></label>
        {range('Room intensity', rig.roomStrength, (v) => setRig({ ...rig, roomStrength: v }), 0, 3, 0.01, (n) => n.toFixed(2))}
        {range('Exposure', rig.exposure, (v) => setRig({ ...rig, exposure: v }), 0.2, 3, 0.01, (n) => n.toFixed(2))}
        <p className="corner-title">LAMPS</p>
        {rig.lamps.map((l) => <LampControls key={l.id} lamp={l} set={setLamp} />)}
        <CrossControls cross={rig.cross ?? NO_CROSS} set={(cross) => setRig({ ...rig, cross })} />
      </section>
      <footer>ENDLESS FRESNEL LAND · FROSTED GLASS<br />COLOUR FROM LIGHT ONLY · ΔE LOWER = CLOSER</footer>
    </aside>
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
