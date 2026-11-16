import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { LinearInterpolator, OrthographicView } from '@deck.gl/core'
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { useClock } from '../anim'
import { BOAT_LEFT, BOAT_RIGHT, COMPASS, CREATURES, DISC, TILE, WAVE } from './sprites'
import { MATURITY, MATURITY_COLORS, PALETTE, REGIONS, STAGE_COLORS, halfSheet, isUnicorn, lensPositions, sheetUrl, type ColorBy, type Lens, type RGB, type SizeBy, type World } from './world'

const INK: RGB = [74, 58, 42]
const SERIF = '"IM Fell English", Georgia, serif'
const FLY = {
  transitionDuration: 1100,
  transitionInterpolator: new LinearInterpolator({ transitionProps: ['target', 'zoom'] }),
  transitionEasing: (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2),
}
const MORPH = { duration: 1400, easing: (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2) }
const VIEW = new OrthographicView({ flipY: true })
// deck.gl's own keyboard control is off: it would pan the map on the arrow keys while the boat sails on them too,
// and its pan stops the camera from following the boat. The boat owns the arrows; + and - zoom (handled below).
const CONTROLLER = { inertia: 250, keyboard: false }
// Over a node, a drag moves the node instead of the map.
const NO_PAN = { inertia: 250, dragPan: false, keyboard: false }
// Below this zoom nodes are a few pixels wide: every drag pans. Above it, dragging a node moves it.
const NODE_DRAG_ZOOM = 3
// Multiply: an ink-stamp logo takes the colour of the tile under it.
const MULTIPLY = { blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'dst-color', blendColorDstFactor: 'zero', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one-minus-src-alpha' } as const
// Pixel art stays crisp; logos are smoothed so they read cleanly at any zoom.
const CRISP = { minFilter: 'nearest', magFilter: 'nearest' } as const
const SMOOTH = { minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' } as const
type ViewState = { target: [number, number, number]; zoom: number } & Partial<typeof FLY>

const ramp = (k: number): RGB => {
  const a: RGB = [160, 176, 140], b: RGB = [214, 160, 72], c: RGB = [176, 72, 56]
  const [p, q, t] = k < 0.5 ? [a, b, k * 2] : [b, c, (k - 0.5) * 2]
  return p.map((v, i) => Math.round(v + (q[i] - v) * t)) as RGB
}
const NONE: RGB = [206, 194, 168]

// Neighbouring countries get clearly different colours: stride through the palette by a coprime step.
// Ten earthy colours that stay apart on a map; scripts/world-layout.mjs assigns them so neighbours differ.
const EUROPE_PALETTE: RGB[] = [[196, 98, 74], [72, 140, 132], [214, 160, 72], [86, 120, 156], [140, 96, 140], [122, 150, 96], [190, 100, 120], [150, 110, 70], [110, 160, 190], [150, 150, 60]]
export const countryColor = (c: number): RGB => PALETTE[(c * 7) % PALETTE.length]

export function colorOf(w: World, by: ColorBy, i: number): RGB {
  switch (by) {
    case 'sector': return PALETTE[(w.sector[i] * 5) % PALETTE.length]
    case 'stage': return STAGE_COLORS[w.stage[i]]
    case 'money': return w.raised[i] ? ramp(Math.min(1, Math.max(0, (Math.log10(w.raised[i]) - 5) / 3.5))) : NONE
    case 'region': return PALETTE[(REGIONS.indexOf(w.region[w.country[i]]) * 3 + 1) % PALETTE.length]
    case 'maturity': return MATURITY_COLORS[w.maturity[i]]
    case 'country': { const k = w.countryColor[w.country[i]]; return k >= 0 ? EUROPE_PALETTE[k] : countryColor(w.country[i]) }
    default: {
      // Startups between two fields take a blend of both colours.
      const a = w.themes[w.cluster[i]].color, m = w.mix[i]
      if (m < 10) return a
      const b = w.themes[w.cluster2[i]].color, t = m / 100
      return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]
    }
  }
}

// Tile side in grid cells: 1 makes solid land; bigger tiles stand out as landmarks.
// A fixed pseudo-random factor per node (0.8 to 1.2), well mixed so neighbours differ, applied after the size cap
// so even the biggest nodes are never exactly the same size.
export const jitter = (i: number) => {
  let h = Math.imul(i + 1, 0x9e3779b1)
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13
  return 0.8 + ((h >>> 0) / 4294967296) * 0.4
}
export function sideOf(w: World, by: SizeBy, i: number) {
  switch (by) {
    // Valuation (Cala, else model recollection, else a multiple of money raised): 1M to 10B+ maps to about 0.8..3.2 cells.
    case 'valuation': return (w.value[i] > 0 ? 0.8 + Math.min(1, Math.max(0, (Math.log10(w.value[i]) - 6) / 3.4)) ** 1.15 * 2.4 : 0.68)
    default: return 1
  }
}
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k]

interface Props {
  world: World
  lens: Lens
  colorBy: ColorBy
  sizeBy: SizeBy
  favs: Set<number>
  selected: number
  visible: Uint8Array
  scores: Float32Array | null
  focusTheme: number | null
  flySeq: number
  onPick: (i: number) => void
  onTheme: (t: number) => void
}

export const WorldMap = memo(function WorldMap({ world, lens, colorBy, sizeBy, favs, selected, visible, scores, focusTheme, flySeq, onPick, onTheme }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const boat = useRef({ x: 0, y: 0, vx: 0, vy: 0, spn: 0, face: 1, goto: null as [number, number] | null, follow: false })
  const keys = useRef(new Set<string>())
  // Foam left behind the stern: a few small dots that shrink and fade within a second or so.
  const trail = useRef<{ x: number; y: number; t: number }[]>([])
  const [size, setSize] = useState({ w: 900, h: 700 })
  const pos = useMemo(() => lensPositions(world, lens), [world, lens])
  // Logos are always shown on real logos; startups without one show their first letter.
  const logoStyle: 'colour' | 'tinted' = 'colour'
  // Not part of this layout at all: no known HQ or outside Europe in the Europe layout.
  const unknownHq = useMemo(() => world.countries.indexOf('Unknown'), [world])
  const absent = (i: number) => (lens === 'world' && (world.country[i] === unknownHq || !world.europe[world.country[i]]))
  const bounds = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let i = 0; i < world.n; i++) {
      if (absent(i)) continue
      const x = pos[2 * i], y = pos[2 * i + 1]
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    return { x0, x1, y0, y1 }
  }, [pos, world, lens]) // eslint-disable-line react-hooks/exhaustive-deps
  const median = useMemo(() => {
    const xs: number[] = [], ys: number[] = []
    for (let i = 0; i < world.n; i++) if (!absent(i)) { xs.push(pos[2 * i]); ys.push(pos[2 * i + 1]) }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b)
    return [xs[xs.length >> 1] ?? 0, ys[ys.length >> 1] ?? 0] as [number, number]
  }, [pos, world, lens]) // eslint-disable-line react-hooks/exhaustive-deps
  const fit = (): ViewState => ({
    target: [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2, 0],
    // Room for the sea margin and its creatures around the land.
    zoom: Math.log2(Math.min(size.w / ((bounds.x1 - bounds.x0) * 1.45 + 20), size.h / ((bounds.y1 - bounds.y0) * 1.45 + 20))),
  })
  // The first view is a sailor's view, not the whole chart: zoom out to see everything.
  const CLOSE = 1.25
  // Europe opens on the whole continent so the country shapes read; the other layouts open close in.
  // The very first view: Barcelona, close in, with Cala beside the boat.
  const firstView = useRef(true)
  const sized = useRef(false)
  const homeAt = (): [number, number] | null => (world.home >= 0 ? [pos[2 * world.home], pos[2 * world.home + 1]] : null)
  const start = (): ViewState => (firstView.current && lens === 'world' && homeAt()
    ? { target: [homeAt()![0], homeAt()![1], 0], zoom: fit().zoom + 3 }
    : lens === 'world'
    ? { target: [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2, 0], zoom: fit().zoom + 0.1 }
    : { target: [median[0], median[1], 0], zoom: fit().zoom + CLOSE })
  const [view, setView] = useState<ViewState>(start)
  // Where the camera and boat were last placed: a resize alone (phone keyboard, address bar, rotation) must not move them.
  const placed = useRef<{ lens: Lens; sized: boolean } | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => { sized.current = true; setSize({ w: e.contentRect.width, h: e.contentRect.height }) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    // Only a new layout, or the first real measurement of the window, places the camera and boat again.
    const p = placed.current
    if (p && p.lens === lens && p.sized) return
    placed.current = { lens, sized: sized.current }
    setView({ ...start(), ...FLY })
    const h = firstView.current && lens === 'world' ? homeAt() : null
    boat.current = { ...boat.current, x: h ? h[0] - 3 : median[0], y: h ? h[1] + 1.6 : median[1] + 1.5, vx: 0, vy: 0, goto: null }
    // The first run happens before the real window size is known; keep the Barcelona start until it is.
    if (sized.current) firstView.current = false
  }, [lens, size.w, size.h]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selected < 0) return
    setView((v) => ({ ...v, ...FLY, target: [pos[2 * selected], pos[2 * selected + 1], 0], zoom: Math.max(v.zoom, 3.6) }))
    // The boat sails over to the startup that was picked.
    boat.current.goto = [pos[2 * selected] - 2, pos[2 * selected + 1] + 1.2]
  }, [flySeq]) // eslint-disable-line react-hooks/exhaustive-deps

  const clock = useClock(14)
  const [dives, setDives] = useState<Record<number, number>>({})
  const [hovered, setHovered] = useState<number | null>(null)
  const shown = (i: number) => !!visible[i] && !absent(i) && (focusTheme === null || world.cluster[i] === focusTheme)
  // Cala is always easy to spot; the Europe layout lets the biggest companies swell to 2.2 cells.
  const cap = lens === 'world' ? 1.9 : 3.3
  const side = (i: number) => (absent(i) ? 0 : shown(i) ? Math.min(cap, sideOf(world, sizeBy, i)) * jitter(i) : 0.4)
  // The physics reads the same radii the screen draws.
  const radius = useRef<(i: number) => number>(() => 0.5)
  radius.current = (i: number) => side(i) / 2
  // Fixed order: deck.gl animates attributes by index, so a stable order means only the
  // startups whose spot really changes are seen moving.
  const order = useMemo(() => Array.from({ length: world.n }, (_, i) => i), [world])
  const top = useMemo(() => (scores ? Math.max(...scores) : 1), [scores])
  // Creatures only tell jokes. One joke per visit: the bubble keeps its line until the creature is left behind.
  const [speech, setSpeech] = useState<{ k: number } | null>(null)
  const jokeRef = useRef<Record<number, string>>({})
  const tickKey = Math.floor(clock * 4)
  useEffect(() => {
    const b = boat.current
    const range = decor.unit * 1.3 + 2
    const dist = (k: number) => Math.hypot(decor.creatures[k].p[0] - b.x, decor.creatures[k].p[1] - b.y)
    let best = -1, bd = Infinity
    decor.creatures.forEach((_, k) => { const d = dist(k); if (d < bd) { bd = d; best = k } })
    setSpeech((prev) => {
      if (prev) { if (dist(prev.k) < range * 1.35) return prev; delete jokeRef.current[prev.k]; return null }
      return best >= 0 && bd < range ? { k: best } : null
    })
  }, [tickKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Logos appear as black-and-white stamps tinted by their node once you sail close; those nodes are round.
  // Far away you see only the theme colours (blended where two fields meet); logos and letters appear when you are close.
  const showLogos = view.zoom > 3.6
  // Every node is a true circle; logos and letters appear inside once you are close.
  const round = () => true
  const EMPTY: number[] = []
  const logoIds = useMemo(() => order.filter((i) => world.logo[i] >= 0), [order, world])
  const letterIds = useMemo(() => order.filter((i) => world.logo[i] < 0), [order, world])

  // ---------- physics: drag a node and it shoves its neighbours; all drift back home ----------
  const sweep = useRef(0)
  const sim = useRef<{ ids: number[]; x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array; drag: number; px: number; py: number } | null>(null)
  const [active, setActive] = useState<Set<number>>(new Set())
  const [, setTick] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [overNode, setOverNode] = useState(false)
  // Dragging always pans the map (dense areas are all dots); holding Shift drags a dot instead.
  const [shiftHeld, setShiftHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true) }
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false) }
    const clear = () => setShiftHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear) }
  }, [])
  const near = (cx: number, cy: number, R: number) => {
    const out: number[] = []
    for (let j = 0; j < world.n; j++) {
      if (absent(j) || !visible[j]) continue
      if (Math.abs(pos[2 * j] - cx) < R && Math.abs(pos[2 * j + 1] - cy) < R) out.push(j)
    }
    return out
  }
  // Brings nodes into the simulation; those already moving keep their place.
  function addToSim(ids: number[]) {
    const prev = sim.current
    const index = new Map<number, number>(prev ? prev.ids.map((j, k) => [j, k]) : [])
    const all = prev ? [...prev.ids] : []
    for (const j of ids) if (!index.has(j)) { index.set(j, all.length); all.push(j) }
    if (prev && all.length === prev.ids.length) return
    const x = new Float32Array(all.length), y = new Float32Array(all.length), vx = new Float32Array(all.length), vy = new Float32Array(all.length)
    all.forEach((j, k) => {
      const old = prev ? prev.ids.indexOf(j) : -1
      x[k] = old >= 0 ? prev!.x[old] : pos[2 * j]; y[k] = old >= 0 ? prev!.y[old] : pos[2 * j + 1]
      vx[k] = old >= 0 ? prev!.vx[old] : 0; vy[k] = old >= 0 ? prev!.vy[old] : 0
    })
    sim.current = { ids: all, x, y, vx, vy, drag: prev?.drag ?? -1, px: prev?.px ?? 0, py: prev?.py ?? 0 }
    setActive(new Set(all))
  }
  function startDrag(i: number) {
    addToSim([i, ...near(pos[2 * i], pos[2 * i + 1], 9)])
    const s = sim.current!
    s.drag = s.ids.indexOf(i); s.px = pos[2 * i]; s.py = pos[2 * i + 1]
    setDragging(true)
  }
  useEffect(() => {
    if (!active.size) return
    let raf = 0
    const step = () => {
      const s = sim.current
      if (!s) return
      const m = s.ids.length
      const b = boat.current
      let moving = false
      for (let a = 0; a < m; a++) {
        const i = s.ids[a]
        if (a === s.drag && dragging) {
          s.x[a] += (s.px - s.x[a]) * 0.5; s.y[a] += (s.py - s.y[a]) * 0.5; s.vx[a] = 0; s.vy[a] = 0
          continue
        }
        // Gentle spring home: the dragged node returns slowly, neighbours a little faster.
        const k = a === s.drag ? 0.012 : 0.03
        s.vx[a] += (pos[2 * i] - s.x[a]) * k
        s.vy[a] += (pos[2 * i + 1] - s.y[a]) * k
        // The hull shoves whatever it sails through.
        if (b.spn > 0.04) {
          const dx = s.x[a] - b.x, dy = s.y[a] - (b.y + 0.4), R = 1.2 + radius.current(i) * 1.1, d = Math.hypot(dx, dy)
          if (d < R && d > 1e-4) { const f = ((R - d) / R) * (0.18 + b.spn * 0.7); s.vx[a] += (dx / d) * f; s.vy[a] += (dy / d) * f }
        }
      }
      // Collisions, solved a few times per frame by moving nodes apart directly. Heavier (bigger) nodes give way less,
      // and two nodes that already overlap at home are only kept at their home spacing, so a cluster of big nodes
      // rests calmly instead of fighting itself.
      for (let iter = 0; iter < 3; iter++) {
        for (let a = 0; a < m; a++) {
          const ia = s.ids[a], ra = radius.current(ia)
          for (let c = a + 1; c < m; c++) {
            const ic = s.ids[c]
            const dx = s.x[c] - s.x[a], dy = s.y[c] - s.y[a]
            const d = Math.hypot(dx, dy)
            const home = Math.hypot(pos[2 * ic] - pos[2 * ia], pos[2 * ic + 1] - pos[2 * ia + 1])
            const rc = radius.current(ic)
            const min = Math.min(ra + rc, home)
            if (d >= min || d < 1e-6) continue
            const overlap = min - d
            const ma = ra * ra, mc = rc * rc
            let wa = mc / (ma + mc), wc = 1 - wa
            if (a === s.drag && dragging) { wa = 0; wc = 1 } else if (c === s.drag && dragging) { wa = 1; wc = 0 }
            const nx = dx / d, ny = dy / d
            s.x[a] -= nx * overlap * wa; s.y[a] -= ny * overlap * wa
            s.x[c] += nx * overlap * wc; s.y[c] += ny * overlap * wc
          }
        }
      }
      for (let a = 0; a < m; a++) {
        if (a === s.drag && dragging) continue
        s.vx[a] *= 0.78; s.vy[a] *= 0.78
        s.x[a] += s.vx[a]; s.y[a] += s.vy[a]
        const i = s.ids[a]
        if (Math.abs(s.x[a] - pos[2 * i]) > 0.01 || Math.abs(s.y[a] - pos[2 * i + 1]) > 0.01 || Math.abs(s.vx[a]) > 0.002) moving = true
      }
      // Nodes back home and at rest leave the simulation, so it stays small however long you sail.
      if (++sweep.current % 12 === 0) {
        const keep: number[] = []
        for (let a = 0; a < m; a++) {
          const i = s.ids[a]
          const rest = Math.abs(s.x[a] - pos[2 * i]) < 0.02 && Math.abs(s.y[a] - pos[2 * i + 1]) < 0.02 && Math.abs(s.vx[a]) < 0.003 && Math.abs(s.vy[a]) < 0.003
          if (!rest || (a === s.drag && dragging)) keep.push(a)
        }
        if (keep.length < m) {
          const pick = <T extends Float32Array>(arr: T) => Float32Array.from(keep, (a) => arr[a]) as T
          sim.current = { ids: keep.map((a) => s.ids[a]), x: pick(s.x), y: pick(s.y), vx: pick(s.vx), vy: pick(s.vy), drag: s.drag >= 0 ? keep.indexOf(s.drag) : -1, px: s.px, py: s.py }
          setActive(new Set(sim.current.ids))
        }
      }
      setTick((t) => t + 1)
      if (moving || dragging || b.spn > 0.04) raf = requestAnimationFrame(step)
      else { sim.current = null; setActive(new Set()) }
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [active, dragging, pos, world, sizeBy])

  // ---------- the boat: WASD or arrows to sail, E opens the nearest startup ----------
  const [nearest, setNearest] = useState(-1)
  const latest = useRef({ zoom: 3, onPick, nearest: -1, near, addToSim, side: () => 1, setView, minZoom: 0 })
  latest.current = { zoom: view.zoom, onPick, nearest, near, addToSim, side: () => 1, setView, minZoom: fit().zoom - 0.5 }
  useEffect(() => {
    const dirs: Record<string, string> = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' }
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
      if (dirs[e.code]) { e.preventDefault(); keys.current.add(dirs[e.code]) }
      if (e.code === 'KeyE' && latest.current.nearest >= 0) latest.current.onPick(latest.current.nearest)
      // + and - zoom around the current centre, within the same limits as the wheel.
      const dz = e.key === '+' || e.key === '=' ? 0.5 : e.key === '-' || e.key === '_' ? -0.5 : 0
      if (dz) {
        e.preventDefault()
        const min = latest.current.minZoom
        latest.current.setView((v) => ({ target: v.target, zoom: Math.min(7, Math.max(min, v.zoom + dz)) }))
      }
    }
    const up = (e: KeyboardEvent) => { if (dirs[e.code]) keys.current.delete(dirs[e.code]) }
    const clear = () => keys.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear) }
  }, [])
  useEffect(() => {
    let raf = 0, frame = 0, last = performance.now()
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      const L = latest.current, b = boat.current, k = keys.current
      const ix = (k.has('r') ? 1 : 0) - (k.has('l') ? 1 : 0), iy = (k.has('d') ? 1 : 0) - (k.has('u') ? 1 : 0)
      // Speed is about 320 screen pixels a second, whatever the zoom.
      const turbo = import.meta.env.DEV ? (window as unknown as { __turbo?: number }).__turbo ?? 1 : 1 // dev only: the video script sails faster
      const top = 320 * turbo * 2 ** -L.zoom
      if (ix || iy) {
        const n = Math.hypot(ix, iy)
        b.vx += (ix / n) * top * 5 * dt; b.vy += (iy / n) * top * 5 * dt
        b.goto = null
      } else if (b.goto) {
        const dx = b.goto[0] - b.x, dy = b.goto[1] - b.y
        b.vx += dx * 4 * dt; b.vy += dy * 4 * dt
        if (Math.hypot(dx, dy) < 0.15) b.goto = null
      }
      const damp = Math.exp(-3 * dt)
      b.vx *= damp; b.vy *= damp
      const sp = Math.hypot(b.vx, b.vy)
      if (sp > top) { b.vx *= top / sp; b.vy *= top / sp }
      b.x += b.vx * dt; b.y += b.vy * dt
      const tail = trail.current, lastDot = tail[tail.length - 1]
      if (Math.hypot(b.vx, b.vy) > top * 0.08 && (!lastDot || Math.hypot(lastDot.x - b.x, lastDot.y - b.y) > 0.35)) tail.push({ x: b.x - Math.sign(b.vx) * 0.5, y: b.y + 0.95, t })
      while (tail.length && t - tail[0].t > 1400) tail.shift()
      b.spn = Math.min(1, sp / top)
      if (Math.abs(b.vx) > top * 0.04) b.face = b.vx > 0 ? 1 : -1
      // The camera keeps easing after the boat while it glides to a stop, so the next move starts centred.
      if (ix || iy) b.follow = true
      else if (sp < top * 0.01) b.follow = false
      if (b.follow) {
        const k = Math.min(1, dt * 12)
        L.setView((v) => ({ target: [v.target[0] + (b.x - v.target[0]) * k, v.target[1] + (b.y - v.target[1]) * k, 0], zoom: v.zoom }))
      }
      frame++
      if (b.spn > 0.04 && frame % 4 === 0) L.addToSim(L.near(b.x, b.y, 4.4))
      if (frame % 6 === 0) {
        let best = -1, bd = 3.2
        for (const j of L.near(b.x, b.y, 3.4)) {
          const d = Math.hypot(pos[2 * j] - b.x, pos[2 * j + 1] - (b.y + 0.4))
          if (d < bd) { bd = d; best = j }
        }
        setNearest((n) => (n === best ? n : best))
      }
      if (b.spn > 0.003 || b.goto) setTick((n) => n + 1)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [pos]) // eslint-disable-line react-hooks/exhaustive-deps
  const simPos = (i: number): [number, number] => {
    const s = sim.current
    const k = s ? s.ids.indexOf(i) : -1
    return k >= 0 ? [s!.x[k], s!.y[k]] : [pos[2 * i], pos[2 * i + 1]]
  }
  const live = useMemo(() => [...active], [active])
  const liveLogoIds = useMemo(() => live.filter((i) => world.logo[i] >= 0), [live, world])
  const liveLetterIds = useMemo(() => live.filter((i) => world.logo[i] < 0), [live, world])
  const canDragNodes = view.zoom >= NODE_DRAG_ZOOM && shiftHeld
  // Nodes in the simulation are drawn by the live layers; the big static layers hide them.
  const still = (i: number) => !active.has(i)
  const triggers = [sizeBy, visible, lens, focusTheme, showLogos, active]

  // Gold ring for unicorns (a sourced valuation of 1B or more), slate ring for established companies.
  // Rings would repaint the country colours in the Europe view, so only saved startups keep one there.
  const rim = (i: number): RGB | null => (lens === 'world' && !favs.has(i) ? null : favs.has(i) ? [214, 64, 110] : isUnicorn(world, i) ? [214, 160, 40] : world.maturity[i] === 4 ? [78, 92, 120] : null)
  const coin = (i: number) => showLogos && logoStyle === 'colour' && world.logo[i] >= 0
  const tileColor = (i: number): [number, number, number, number] => {
    const c = colorOf(world, colorBy, i)
    if (!shown(i)) return [c[0], c[1], c[2], 45]
    if (coin(i) && !scores) return [251, 246, 234, 255]
    if (scores) {
      const s = scores[i]
      if (s <= 0) return [...shade(c, 0.95), 70] as [number, number, number, number]
      const k = 0.55 + 0.45 * (s / top)
      return [c[0] * k + 250 * (1 - k), c[1] * k + 240 * (1 - k), c[2] * k + 220 * (1 - k), 255]
    }
    return [c[0], c[1], c[2], 255]
  }
  // Many phone GPUs can't load an 8192 px texture and draw black boxes: they get the half-size sheet.
  const half = useMemo(() => halfSheet(world), [world])
  const sheet = (file: string) => sheetUrl(world, file)
  const mapping = useMemo(() => {
    const m: Record<string, { x: number; y: number; width: number; height: number }> = {}
    const { cols } = world.sprite, cell = half ? world.sprite.cell / 2 : world.sprite.cell
    world.logo.forEach((k, i) => { if (k >= 0) m[i] = { x: (k % cols) * cell, y: Math.floor(k / cols) * cell, width: cell, height: cell } })
    return m
  }, [world, half])

  // One set of node layers; `which` picks the static nodes or the ones the physics is moving.
  const nodeLayers = (which: 'static' | 'live') => {
    const data = which === 'static' ? order : live
    const at = which === 'static' ? (i: number): [number, number] => [pos[2 * i], pos[2 * i + 1]] : simPos
    const vis = which === 'static' ? still : () => true
    const tick = which === 'live' ? Math.random() : 0
    const base = { sizeUnits: 'common' as const, updateTriggers: {} }
    return [
      // A darker copy a little lower gives each node the raised edge of 16-bit land.
      new IconLayer<number>({
        ...base, id: `shadow-${which}`, data, getIcon: () => (round() ? DISC : TILE),
        getPosition: (i) => { const [x, y] = at(i); return [x, y + 0.16] },
        getSize: (i) => (vis(i) ? side(i) * (rim(i) ? 1.24 : coin(i) ? 1.16 : 1.02) : 0),
        getColor: (i) => [...(rim(i) ?? shade(colorOf(world, colorBy, i), coin(i) ? 0.9 : 0.62)), shown(i) ? 255 : 0] as [number, number, number, number],
        textureParameters: SMOOTH,
        transitions: which === 'static' ? { getPosition: MORPH } : undefined,
        updateTriggers: { getPosition: [lens, tick], getSize: triggers, getColor: [colorBy, ...triggers], getIcon: showLogos },
      }),
      new IconLayer<number>({
        ...base, id: `tiles-${which}`, data, getIcon: () => (round() ? DISC : TILE),
        getPosition: at,
        getSize: (i) => (vis(i) ? side(i) : 0),
        getColor: tileColor,
        textureParameters: SMOOTH,
        pickable: true, autoHighlight: true, highlightColor: [255, 250, 235, 140],
        transitions: which === 'static' ? { getPosition: MORPH } : undefined,
        updateTriggers: { getPosition: [lens, tick], getSize: triggers, getColor: [colorBy, scores, ...triggers], getIcon: showLogos },
        onClick: ({ object }) => object !== undefined && onPick(object),
        onDragStart: ({ object }) => { if (object !== undefined && canDragNodes) startDrag(object) },
        onDrag: ({ coordinate }) => { if (sim.current && coordinate) { sim.current.px = coordinate[0]; sim.current.py = coordinate[1] } },
        onDragEnd: () => setDragging(false),
        onHover: ({ object }) => setOverNode(canDragNodes && object !== undefined && object !== null),
      }),
      new IconLayer<number>({
        ...base, id: `logos-${which}`,
        data: !showLogos ? EMPTY : which === 'static' ? logoIds : liveLogoIds,
        iconAtlas: sheet(logoStyle === 'colour' ? world.sprite.url : world.sprite.ink),
        iconMapping: mapping,
        getIcon: (i) => String(i),
        getPosition: at,
        getSize: (i) => (shown(i) && vis(i) ? side(i) * (logoStyle === 'colour' ? 0.78 : 0.92) : 0),
        textureParameters: SMOOTH,
        parameters: logoStyle === 'colour' ? undefined : MULTIPLY,
        transitions: which === 'static' ? { getPosition: MORPH } : undefined,
        updateTriggers: { getPosition: [lens, tick], getSize: triggers },
      }),
      // No logo: the first letter of the name stands in for it.
      new TextLayer<number>({
        id: `letters-${which}`,
        data: !showLogos ? EMPTY : which === 'static' ? letterIds : liveLetterIds,
        getPosition: at,
        getText: (i) => (world.name[i].trim()[0] ?? '?').toUpperCase(),
        getColor: [...INK, 235],
        getSize: (i) => (shown(i) && vis(i) ? side(i) * 0.62 : 0),
        sizeUnits: 'common', sizeMinPixels: 4,
        fontFamily: SERIF, characterSet: 'auto', fontSettings: { sdf: true },
        updateTriggers: { getPosition: [lens, tick], getSize: triggers },
      }),
    ]
  }

  const [sx, sy] = selected >= 0 ? simPos(selected) : [0, 0]
  const ss = selected >= 0 ? side(selected) : 0
  const selection = new ScatterplotLayer<number>({
    id: 'selection', data: selected >= 0 ? [0] : [], getPosition: () => [sx, sy], getRadius: ss * 0.8 + 0.3, radiusUnits: 'common',
    filled: false, stroked: true, getLineColor: [176, 72, 56, 255], getLineWidth: 2.4, lineWidthUnits: 'pixels',
    transitions: { getPosition: MORPH }, updateTriggers: { getPosition: [sx, sy], getRadius: ss },
  })
  // Rings spread from the hull; the boat bobs, and its wake gets longer the faster it sails.
  const bt = boat.current
  const bobAt: [number, number] = [bt.x, bt.y + Math.sin(clock * 1.8) * 0.08]
  const now = performance.now()
  const wake = new ScatterplotLayer<{ x: number; y: number; t: number }>({
    id: 'wake', data: [...trail.current],
    getPosition: (d) => [d.x, d.y],
    getRadius: (d) => 0.34 * (1 - (now - d.t) / 1400) + 0.05, radiusUnits: 'common',
    getFillColor: (d) => [255, 252, 242, Math.round(200 * (1 - (now - d.t) / 1400))],
    updateTriggers: { getRadius: now, getFillColor: now },
  })
  const boatLayer = new IconLayer<number>({
    id: 'boat', data: [0],
    getPosition: () => bobAt,
    getIcon: () => (bt.face > 0 ? BOAT_RIGHT : BOAT_LEFT),
    getSize: 2.6, sizeUnits: 'common', sizeMinPixels: 34, sizeMaxPixels: 90,
    getAngle: () => Math.sin(clock * 1.3) * 3 + bt.spn * -4 * bt.face,
    textureParameters: CRISP,
    updateTriggers: { getPosition: [bt.x, bt.y, clock], getIcon: bt.face, getAngle: [clock, bt.spn] },
  })
  // The startup the bow points at, with the key that opens it.
  const hint = new TextLayer<{ p: [number, number]; t: string }>({
    id: 'boat-hint',
    data: nearest >= 0 ? [{ p: [pos[2 * nearest], pos[2 * nearest + 1]] as [number, number], t: `${world.name[nearest]}  ·  press E` }] : [],
    getPosition: (d) => d.p, getText: (d) => d.t, getColor: [...INK, 255], getSize: 15, sizeUnits: 'pixels',
    getPixelOffset: [0, -26], fontFamily: SERIF, characterSet: 'auto', fontSettings: { sdf: true },
    outlineWidth: 6, outlineColor: [243, 234, 216, 245],
  })

  // Sea life and glints fill the margins, as on an old chart.
  const decor = useMemo(() => {
    const w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0
    const pad = Math.max(w, h) * 0.1
    const unit = Math.max(6, Math.max(w, h) * 0.07)
    const spots = [
      [bounds.x0 - pad * 0.6, bounds.y0 + h * 0.15], [bounds.x1 + pad * 0.6, bounds.y0 + h * 0.3],
      [bounds.x0 + w * 0.3, bounds.y1 + pad * 0.8], [bounds.x1 - w * 0.1, bounds.y0 - pad * 0.7],
      [bounds.x0 - pad * 0.7, bounds.y1 - h * 0.25], [bounds.x1 + pad * 0.7, bounds.y1 - h * 0.15],
      [bounds.x0 + w * 0.7, bounds.y1 + pad * 0.9], [bounds.x0 + w * 0.15, bounds.y0 - pad * 0.8],
    ].slice(0, CREATURES.length) as [number, number][]
    const r = (k: number) => { const v = Math.sin(k * 12.9898) * 43758.5453; return v - Math.floor(v) }
    return {
      unit,
      creatures: spots.map((p, k) => ({ p, sprite: CREATURES[k % CREATURES.length], phase: k * 1.9 })),
      compass: [bounds.x0 - pad * 0.3, bounds.y1 + pad * 0.4] as [number, number],
      waves: Array.from({ length: 90 }, (_, k) => ({ p: [bounds.x0 - pad * 1.5 + r(k) * (w + pad * 3), bounds.y0 - pad * 1.5 + r(k + 99) * (h + pad * 3)] as [number, number], phase: r(k + 7) * 6.28 })),
    }
  }, [bounds])
  // Click a creature and it dives with a splash, resurfacing a few seconds later; hover makes it wriggle.
  const dive = (k: number) => {
    const t = clock - (dives[k] ?? -99)
    if (t < 0.7) return { sink: (t / 0.7) ** 2, alpha: 1 - t / 0.7 }
    if (t < 3.2) return { sink: 1, alpha: 0 }
    if (t < 4) return { sink: 1 - (t - 3.2) / 0.8, alpha: (t - 3.2) / 0.8 }
    return { sink: 0, alpha: 1 }
  }
  // Dev only: lets the video script steer the boat.
  if (import.meta.env.DEV) Object.assign(window, { __boat: boat, __decor: decor, __setView: setView })
  const creaturePos = (c: (typeof decor.creatures)[number], k: number): [number, number] => {
    const wriggle = hovered === k || speech?.k === k ? Math.sin(clock * 14) * 0.25 : 0
    return [c.p[0] + Math.sin(clock * 0.3 + c.phase) * 1.2 + wriggle, c.p[1] + Math.cos(clock * 0.4 + c.phase) * 0.5 + dive(k).sink * decor.unit * 0.45]
  }
  const creatures = new IconLayer<(typeof decor.creatures)[number]>({
    id: 'creatures', data: decor.creatures,
    getPosition: (c) => creaturePos(c, decor.creatures.indexOf(c)),
    getIcon: (c) => c.sprite, getSize: decor.unit, sizeUnits: 'common', sizeMaxPixels: 150, textureParameters: CRISP,
    getColor: (c) => [255, 255, 255, Math.round(255 * dive(decor.creatures.indexOf(c)).alpha)],
    getAngle: (c) => (hovered === decor.creatures.indexOf(c) || speech?.k === decor.creatures.indexOf(c) ? Math.sin(clock * 10) * 6 : 0),
    pickable: true,
    onClick: ({ index }) => { setDives((d) => ({ ...d, [index]: clock })) },
    onHover: ({ index }) => setHovered(index >= 0 ? index : null),
    updateTriggers: { getPosition: [clock, hovered, speech?.k], getColor: clock, getAngle: [clock, hovered, speech?.k] },
  })
  const splashes = new ScatterplotLayer<{ p: [number, number]; t: number; r: number }>({
    id: 'splashes',
    data: Object.entries(dives).flatMap(([k, t0]) => {
      const t = clock - t0
      const c = decor.creatures[+k]
      return c && t < 1.6 ? [0, 0.35, 0.7].filter((d) => t > d).map((d) => ({ p: [c.p[0], c.p[1] + decor.unit * 0.25] as [number, number], t: t - d, r: decor.unit })) : []
    }),
    getPosition: (d) => d.p, getRadius: (d) => d.r * (0.1 + d.t * 0.5), radiusUnits: 'common',
    filled: false, stroked: true, getLineColor: (d) => [154, 136, 102, Math.max(0, 170 * (1 - d.t / 1.2))], getLineWidth: 2, lineWidthUnits: 'pixels',
  })
  const waves = new IconLayer<(typeof decor.waves)[number]>({
    id: 'waves', data: decor.waves, getPosition: (d) => d.p, getIcon: () => WAVE,
    getSize: decor.unit * 0.14, sizeUnits: 'common', textureParameters: CRISP,
    getColor: (d) => [255, 255, 255, Math.round(60 + 150 * Math.max(0, Math.sin(clock * 0.7 + d.phase)))],
    updateTriggers: { getColor: Math.floor(clock * 5) },
  })
  const compass = new IconLayer<number>({ id: 'compass', data: [0], getPosition: () => decor.compass, getIcon: () => COMPASS, getSize: decor.unit * 0.7, sizeUnits: 'common', textureParameters: CRISP })

  // Region names lettered across the land, fading as you sail in close.
  const labelOpacity = Math.min(1, Math.max(0, (6.2 - view.zoom) / 1.4))
  // Label spacing done by hand: biggest first, and a label is skipped if its box would touch one already placed.
  const scaleNow = 2 ** view.zoom
  const declutter = <T,>(items: T[], at: (t: T) => [number, number], text: (t: T) => string, px: (t: T) => number, priority: (t: T) => number): T[] => {
    const kept: { x0: number; x1: number; y0: number; y1: number }[] = []
    const out: T[] = []
    for (const it of [...items].sort((a, b) => priority(b) - priority(a))) {
      const [wx, wy] = at(it)
      const sx = (wx - view.target[0]) * scaleNow + size.w / 2, sy = (wy - view.target[1]) * scaleNow + size.h / 2
      const f = px(it), w = text(it).length * f * 0.6, h = f * 1.3
      const box = { x0: sx - w / 2 - 10, x1: sx + w / 2 + 10, y0: sy - h / 2 - 6, y1: sy + h / 2 + 6 }
      if (kept.some((k) => k.x0 < box.x1 && k.x1 > box.x0 && k.y0 < box.y1 && k.y1 > box.y0)) continue
      kept.push(box); out.push(it)
    }
    return out
  }
  const themePx = (t: World['themes'][number]) => Math.min(30, Math.max(15, (2.4 + Math.sqrt(t.size) * 0.1) * scaleNow))
  const themeLabels = new TextLayer<World['themes'][number]>({
    id: 'theme-labels',
    data: lens === 'meaning' ? declutter(world.themes, (t) => [t.x, t.y], (t) => t.label, themePx, (t) => t.size) : [],
    getPosition: (t) => [t.x, t.y],
    getText: (t) => t.label,
    getColor: (t) => [...INK, focusTheme === null || focusTheme === t.index ? 240 : 60] as [number, number, number, number],
    getSize: (t) => 2.4 + Math.sqrt(t.size) * 0.1,
    sizeUnits: 'common', sizeMinPixels: 15, sizeMaxPixels: 30, fontWeight: 700,
    fontFamily: SERIF, characterSet: 'auto', fontSettings: { sdf: true },
    outlineWidth: 10, outlineColor: [247, 240, 224, 250],
    opacity: Math.max(labelOpacity, focusTheme !== null ? 0.95 : 0),
    pickable: true,
    // Where names would overlap, the bigger theme keeps its name.
    onClick: ({ object }) => object && onTheme(object.index),
    updateTriggers: { getColor: focusTheme },
  })
  type CountryLabel = { p: [number, number]; t: string; n: number }
  // Only depends on the layout: computing it on every animation frame was the costliest part of a render.
  const countryGroups = useMemo(() => (lens === 'world' ? groupLabels(world, pos) : []), [world, pos, lens])
  const countryPx = (d: CountryLabel) => Math.min(30, Math.max(13, (2 + Math.sqrt(d.n) * 0.13) * scaleNow))
  const countryLabels = new TextLayer<CountryLabel>({
    id: 'country-labels',
    // Small countries are named only once you zoom in, so the crowded south east stays readable.
    data: lens === 'world' ? declutter(countryGroups, (d) => d.p, (d) => d.t, countryPx, (d) => d.n) : [],
    getPosition: (d) => d.p, getText: (d) => d.t,
    getColor: [...INK, 240], getSize: (d: CountryLabel) => 2 + Math.sqrt(d.n) * 0.13, sizeUnits: 'common', sizeMinPixels: 13, sizeMaxPixels: 30,
    fontFamily: SERIF, characterSet: 'auto', fontSettings: { sdf: true },
    outlineWidth: 7, outlineColor: [243, 234, 216, 245],
    // Where names would collide, the country with more startups keeps its name.
  })

  return (
    <div ref={box} className="v2-map">
      <DeckGL
        views={VIEW}
        viewState={view}
        controller={(overNode && canDragNodes) || dragging ? NO_PAN : CONTROLLER}
        onViewStateChange={({ viewState, interactionState }) => {
          const v = viewState as ViewState
          // Dragging or zooming the map yourself stops the camera from chasing the boat.
          if (interactionState?.isDragging || interactionState?.isZooming || interactionState?.isPanning) boat.current.follow = false
          const z = Math.min(7, Math.max(fit().zoom - 0.5, v.zoom))
          // At a zoom limit the wheel would still slide the map toward the cursor: keep the centre where it is.
          if (z !== v.zoom) setView((prev) => ({ target: prev.target, zoom: z }))
          else setView({ target: v.target, zoom: z })
        }}
        layers={[waves, compass, splashes, creatures, ...nodeLayers('static'), ...nodeLayers('live'), selection, wake, boatLayer, hint, themeLabels, countryLabels]}
        getCursor={({ isHovering, isDragging }) => (dragging ? 'grabbing' : isDragging ? 'grabbing' : overNode && canDragNodes ? 'move' : isHovering ? 'pointer' : 'grab')}
        getTooltip={({ object, layer }) => {
          if (object === undefined || object === null) return null
          if (layer?.id === 'creatures') {
            const c = (object as (typeof decor.creatures)[number]).sprite
            return { html: `<b>${c.name}</b><div>${c.myth}</div>`, className: 'v2-tip', style: {} }
          }
          if (layer?.id === 'theme-labels') {
            const t = object as World['themes'][number]
            return { html: `<b>${t.label}</b><div>${t.size.toLocaleString()} startups · ${t.terms.slice(0, 4).join(', ')}</div><div>Click to read this market</div>`, className: 'v2-tip', style: {} }
          }
          if (layer?.id !== 'tiles') return null
          const i = object as number
          const s = scores?.[i]
          return {
            html: `<b>${world.name[i]}</b><div>${world.themes[world.cluster[i]].label} · ${world.countries[world.country[i]]}${world.founded[i] ? ` · ${world.founded[i]}` : ''}</div>${world.maturity[i] ? `<div>${MATURITY[world.maturity[i]]}${isUnicorn(world, i) ? ' · unicorn' : ''}</div>` : ''}${world.value[i] ? `<div class="gold">${world.valueSrc[i] === 3 ? '≈ ' : ''}valued ${fmt(world.value[i])}${world.valueSrc[i] === 3 ? ' (from funding)' : ''}</div>` : ''}${world.raised[i] ? `<div class="gold">raised ${fmt(world.raised[i])}</div>` : ''}${scores && s ? `<div class="gold">${Math.round(s * 100)}% match</div>` : ''}`,
            className: 'v2-tip', style: {},
          }
        }}
      />
      {speech && (() => {
        const c = decor.creatures[speech.k]
        const [cx, cy] = creaturePos(c, speech.k)
        const scale = 2 ** view.zoom
        const x = Math.min(size.w - 170, Math.max(170, size.w / 2 + (cx - view.target[0]) * scale))
        const y = Math.min(size.h - 120, Math.max(150, size.h / 2 + (cy - view.target[1]) * scale - Math.min(150, decor.unit * scale) * 0.55))
        return (
          <div className="creature-bubble glass" style={{ left: x, top: y }} key={speech.k}>
            <div className="who">{c.sprite.name}</div>
            <p>{jokeRef.current[speech.k] ??= talk(c.sprite.name)}</p>
            <p className="lore">{c.sprite.myth}</p>
          </div>
        )
      })()}
    </div>
  )
})

// What each creature says: a joke from the startup and VC world, picked at random.
const JOKES: Record<string, string[]> = {
  'Iku-Turso': ['I have been pre-revenue since the Kalevala.', 'My burn rate is mostly ships.', 'Investors asked for my moat. I am the moat.'],
  'Swan of Tuonela': ['My last round was a funeral. Down round.', 'I pivoted to elegies. Retention is excellent.', 'The underworld has no churn.'],
  'Näkki': ['I live under a pier. Very asset light.', 'Raising a seed round? I only accept lake-based funding.', 'My growth hack is drowning the competition.'],
  'Jörmungandr': ['I have no exit strategy. I eat my own tail.', 'Circular economy. I invented it.', 'Ten years in, still hunting for product-market fit.'],
  Whale: ['Every VC wants to meet a whale. I am tired.', 'I raised a Series A just from krill.', 'They call me a unicorn. I am a mammal.'],
  Kraken: ['Eight arms, nine pivots.', 'I do not need a co-founder. I have tentacles.', 'My pitch deck is 80 slides long. It is also a trap.'],
  'Sea serpent': ['I told investors I am a long-term play.', 'Spotted in 1746. Still no term sheet.', 'I got acqui-hired by a lighthouse.'],
}
function talk(who: string) {
  const list = JOKES[who] ?? ['Is this a pitch, or are you just happy to see me?']
  return list[Math.floor(Math.random() * list.length)]
}

const fmt = (eur: number) => (eur >= 1e9 ? `€${(eur / 1e9).toFixed(1)}B` : eur >= 1e6 ? `€${(eur / 1e6).toFixed(1)}M` : `€${Math.round(eur / 1e3)}k`)

function groupLabels(w: World, pos: Float32Array) {
  const xs = w.countries.map(() => [] as number[]), ys = w.countries.map(() => [] as number[])
  for (let i = 0; i < w.n; i++) if (w.europe[w.country[i]]) { xs[w.country[i]].push(pos[2 * i]); ys[w.country[i]].push(pos[2 * i + 1]) }
  const mid = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1]
  return w.countries.map((t, g) => ({ p: [mid(xs[g]), mid(ys[g])] as [number, number], t, n: xs[g].length })).filter((d) => d.n >= 4)
}
