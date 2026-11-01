// Projects: a named, saved look (lights, shape, zoom, title, …) kept in this
// browser's localStorage. The old "scenes" are read-only starter projects.
// The working state is also autosaved as the session, so a reload resumes.
import { PRISM, type Shape } from './prism'
import { themes, type Rig } from './rig'
import { SUBTITLE, TITLE, type Title } from './title'

// Everything that makes the picture. `base` is what "↺ reset" lights returns to.
export type Look = { rig: Rig; base: Rig; shape: Shape; zoom: number; master: number; title: Title; subtitle: Title; gray: boolean }
export type Project = { id: string; name: string; savedAt: number; look: Look; starter?: true }
export type Locks = { lights: boolean; shape: boolean; zoom: boolean }
// The workspace around the look: which project is open and the export settings.
// A project is named by its title; several may share a name.
export type Session = { current: string | null; look: Look; formatId: string; picked: string[] | null; scale: 1 | 2; locks: Locks }

const PROJECTS = 'prism:projects', SESSION = 'prism:session'
const read = <T,>(key: string): T | null => { try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null } catch { return null } }
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full or blocked */ } }

export const DEFAULT_LOOK: Look = { rig: themes.reference, base: themes.reference, shape: PRISM, zoom: 1, master: 1, title: TITLE, subtitle: SUBTITLE, gray: false }
// Fills anything an older or hand-edited project lacks.
export const complete = (l: Partial<Look>): Look => ({
  ...DEFAULT_LOOK, ...l, rig: l.rig ?? DEFAULT_LOOK.rig, base: l.base ?? l.rig ?? DEFAULT_LOOK.base,
  shape: { ...PRISM, ...l.shape }, title: { ...TITLE, ...l.title }, subtitle: { ...SUBTITLE, ...l.subtitle },
})

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
export const STARTERS: Project[] = Object.entries(themes).map(([k, rig]) => ({ id: `starter-${k}`, name: cap(k), savedAt: 0, starter: true, look: { ...DEFAULT_LOOK, rig, base: rig } }))

export const listProjects = (): Project[] => (read<Project[]>(PROJECTS) ?? []).map((p) => ({ ...p, look: complete(p.look) }))
export const storeProjects = (ps: Project[]) => write(PROJECTS, ps)
export const loadSession = (): Session | null => {
  const s = read<Session>(SESSION)
  // Sessions from before titles named projects stored { id, name }.
  return s && { ...s, current: typeof s.current === 'object' && s.current ? (s.current as { id: string | null }).id : s.current, look: complete(s.look) }
}
export const storeSession = (s: Session) => write(SESSION, s)
export const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// A project as a file, for backup or moving to another computer.
export const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9áéíóúýþæöð]+/g, '-').replace(/^-|-$/g, '') || 'prism'
export const nameOf = (l: Look) => l.title.text.trim() || 'Untitled'
export function exportProject(p: { name: string; look: Look }) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ kind: 'prism-project', version: 1, name: p.name, look: p.look }, null, 2)], { type: 'application/json' }))
  Object.assign(document.createElement('a'), { href: url, download: `${slug(p.name)}.prism.json` }).click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
export async function importProject(file: File): Promise<{ name: string; look: Look }> {
  const d = JSON.parse(await file.text())
  if (d?.kind !== 'prism-project' || !d.look?.rig) throw new Error('Not a prism project file')
  return { name: String(d.name || file.name.replace(/\.prism\.json$|\.json$/, '')), look: complete(d.look) }
}
