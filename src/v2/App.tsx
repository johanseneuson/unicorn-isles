import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorldMap } from './Map'
import { Detail, ThemeSheet } from './Panels'
import { LENSES, MATURITY, isUnicorn, loadWorld, type Lens, type SizeBy, type World } from './world'
import { askCala, askGemma, plain, searchMeaning, type CalaAnswer, type GemmaAnswer, type Hit } from './api'
import { LogoImg } from './Logo'
import { Intro } from './Intro'
import { FavSheet } from './Favourites'
import { useSession } from '../auth'
import { useStored } from '../useStored'
import { Pad } from './Pad'
import './v2.css'

type Mode = 'search' | 'ask'
interface Filters { stage: string; sector: string; maturity: string; funded: boolean; unicorn: boolean }
const NONE: Filters = { stage: '', sector: '', maturity: '', funded: false, unicorn: false }
const EXAMPLES: Record<Mode, string[]> = {
  search: ['batteries for electric boats', 'AI that reads medical scans', 'payments for freelancers', 'carbon capture'],
  ask: ['Who is building food from fermentation?', 'Young robotics startups with no funding yet', 'Fintechs backed by many investors'],
}
const MODE_HINT: Record<Mode, string> = {
  search: 'Describe what a company does',
  ask: 'Ask Gemma and Cala a question',
}

export default function App() {
  const [world, setWorld] = useState<World | null>(null)
  useEffect(() => { loadWorld().then(setWorld) }, [])
  if (!world) return <div className="v2 loading"><div className="spinner" /><p>Charting the startup seas…</p></div>
  return <Explorer world={world} />
}

function Explorer({ world }: { world: World }) {
  const [lens, setLens] = useState<Lens>('world')
  const [sizeBy, setSizeBy] = useState<SizeBy>('valuation')
  const [selected, setSelected] = useState(-1)
  const [flySeq, setFlySeq] = useState(0)
  const [mode, setMode] = useState<Mode>('search')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [hitsLabel, setHitsLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gemma, setGemma] = useState<GemmaAnswer | null>(null)
  const [cala, setCala] = useState<CalaAnswer | 'pending' | null>(null)
  const [focusTheme, setFocusTheme] = useState<number | null>(null)
  const [filters, setFilters] = useState<Filters>(NONE)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [themesOpen, setThemesOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(true)
  // Compact search shows only the box: no mode tabs, no ready-made questions. It is the default; the arrow expands it.
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem('unicorn-isles-search') !== 'open' } catch { return true } })
  const toggleCompact = () => { const next = !compact; setCompact(next); try { localStorage.setItem('unicorn-isles-search', next ? 'compact' : 'open') } catch { /* private window */ } }
  const [intro, setIntro] = useState(true)
  // Saved startups: localStorage, and the user's Supabase row when signed in (same 'gems' column as the classic map).
  const session = useSession()
  const [favs, setFavs] = useStored<string[]>('unicorn-isles-favs', [], session?.user.id, 'gems')
  const [favsOpen, setFavsOpen] = useState(false)
  const favSet = useMemo(() => new Set(favs.map((id) => world.index.get(id)).filter((i): i is number => i !== undefined)), [favs, world])
  const toggleFav = useCallback((i: number) => setFavs(favs.includes(world.id[i]) ? favs.filter((x) => x !== world.id[i]) : [...favs, world.id[i]]), [favs, world, setFavs])
  const asked = useRef(0)

  const visible = useMemo(() => {
    const v = new Uint8Array(world.n)
    const stage = filters.stage ? world.stages.indexOf(filters.stage) : -1
    const sector = filters.sector ? world.sectors.indexOf(filters.sector) : -1
    const maturity = filters.maturity ? MATURITY.indexOf(filters.maturity) : -1
    for (let i = 0; i < world.n; i++) {
      v[i] = +((stage < 0 || world.stage[i] === stage)
        && (sector < 0 || world.sector[i] === sector)
        && (maturity < 0 || world.maturity[i] === maturity)
        && (!filters.unicorn || isUnicorn(world, i))
        && (!filters.funded || world.raised[i] > 0))
    }
    return v
  }, [world, filters])
  const shownCount = useMemo(() => visible.reduce((a, b) => a + b, 0), [visible])

  // Search hits shade the map: best match brightest, everything else fades.
  const scores = useMemo(() => {
    if (!hits?.length) return null
    const s = new Float32Array(world.n)
    const lo = Math.min(...hits.map((h) => h.score)) - 0.02
    for (const h of hits) {
      const i = world.index.get(h.id)
      if (i !== undefined) s[i] = Math.max(0.05, (h.score - lo) / Math.max(0.01, 1 - lo))
    }
    return s
  }, [hits, world])

  const pick = useCallback((i: number, fly = false) => {
    setSelected(i)
    if (fly) setFlySeq((n) => n + 1)
  }, [])
  const pickId = useCallback((id: string) => {
    const i = world.index.get(id)
    if (i !== undefined) pick(i, true)
  }, [world, pick])
  const onMapPick = useCallback((i: number) => pick(i), [pick])
  const onTheme = useCallback((t: number) => { setFocusTheme(t); setThemesOpen(true) }, [])

  function clear() {
    asked.current++
    setHits(null); setGemma(null); setCala(null); setError(''); setBusy(false); setHitsLabel('')
  }

  async function run(q: string, m: Mode = mode) {
    if (!q.trim()) return
    const n = ++asked.current
    setQuery(q); setBusy(true); setError(''); setGemma(null); setResultsOpen(true)
    try {
      if (m === 'ask') {
        setCala('pending')
        askCala(q).then((c) => n === asked.current && setCala(c))
        // The shortlist lights up at once; Gemma's picks arrive later and glow brightest.
        const h = await searchMeaning(q)
        if (n !== asked.current) return
        setHits(h.slice(0, 24)); setHitsLabel(q)
        const g = await askGemma(q)
        if (n !== asked.current) return
        setGemma(g)
        const picked = new Set(g.picks.map((p) => p.id))
        setHits([...g.picks.map((p) => ({ id: p.id, score: 1 })), ...h.slice(0, 24).filter((x) => !picked.has(x.id)).map((x) => ({ ...x, score: x.score * 0.8 }))])
        if (g.picks[0]) pickId(g.picks[0].id)
      } else {
        const h = await searchMeaning(q)
        if (n !== asked.current) return
        setHits(h.slice(0, 60)); setHitsLabel(q); setCala(null)
        if (h[0]) pickId(h[0].id)
      }
    } catch (e) {
      if (n === asked.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (n === asked.current) setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) { if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); return }
      // Leave typing in form fields and browser shortcuts (Ctrl/Cmd+F, Ctrl+1...) alone.
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey || e.altKey) return
      const k = LENSES.findIndex((_, i) => e.key === String(i + 1))
      if (k >= 0) setLens(LENSES[k].key)
      if (e.key === 'Escape') { setSelected(-1); setFocusTheme(null); setThemesOpen(false) }
      if (e.key === 'f' || e.key === 'F') { const el = document.querySelector<HTMLButtonElement>('.v2-detail .save'); el?.click() }
      if (e.key === '/') { e.preventDefault(); document.querySelector<HTMLInputElement>('.v2-search input')?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtering = JSON.stringify(filters) !== JSON.stringify(NONE)

  return (
    <div className="v2">
      <WorldMap world={world} lens={lens} colorBy="theme" sizeBy={sizeBy} favs={favSet} selected={selected} visible={visible} scores={scores} focusTheme={focusTheme} flySeq={flySeq} onPick={onMapPick} onTheme={onTheme} />
      <Pad canSave={selected >= 0} />

      <header className="v2-top">
        <div className="brand glass">
          <span className="brand-mark" aria-hidden>✦</span>
          <span className="brand-name">Unicorn Isles</span>
          <span className="brand-count">{world.n.toLocaleString()} startups · Cala</span>
        </div>
        <nav className="segmented glass" aria-label="Arrange the map by">
          {LENSES.map((l, k) => (
            <button key={l.key} className={lens === l.key ? 'on' : ''} title={`${l.hint} (${k + 1})`} onClick={() => setLens(l.key)}>{l.label}</button>
          ))}
        </nav>
      </header>
      <button className="help glass" title="Meet Eino again" onClick={() => setIntro(true)}>?</button>
      {intro && <Intro onClose={() => setIntro(false)} />}
      <p className="drag-hint">Drag to move the map · WASD to sail · E opens the nearest startup · Shift-drag a dot to push it</p>

      <section className="v2-search glass">
        <form onSubmit={(e) => { e.preventDefault(); run(query) }}>
          <svg className="mag" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" /></svg>
          <input value={query} placeholder={MODE_HINT[mode]} onChange={(e) => setQuery(e.target.value)} onFocus={() => setResultsOpen(true)} />
          {(hits || gemma || error) && <button type="button" className="clear" title="Clear" onClick={() => { clear(); setQuery('') }}>✕</button>}
          <button type="button" className="clear" title={compact ? 'Show search options' : 'Compact search'} onClick={toggleCompact}>{compact ? '▾' : '▴'}</button>
        </form>
        {!compact && <div className="modes">
          {(['search', 'ask'] as const).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => { setMode(m); clear() }}>{m === 'search' ? 'Similar companies' : 'Ask'}</button>
          ))}
        </div>}
        {resultsOpen && (
          <div className="results">
            {!compact && !hits && !busy && !error && (
              <div className="examples">{EXAMPLES[mode].map((q) => <button key={q} onClick={() => run(q)}>{q}</button>)}</div>
            )}
            {busy && <p className="muted"><span className="dot pulse" /> {mode === 'ask' ? 'Gemma is reading the shortlist…' : 'Searching…'}</p>}
            {error && <p className="error">{error}</p>}
            {gemma && (
              <div className="answer">
                <div className="label">Gemma · from {hits?.length ?? 0} closest startups</div>
                <p>{gemma.answer}</p>
                <ul className="list">
                  {gemma.picks.map((p) => {
                    const i = world.index.get(p.id)
                    return i === undefined ? null : (
                      <li key={p.id} className={i === selected ? 'on' : ''} onClick={() => pick(i, true)}>
                        <LogoImg world={world} i={i} />
                        <span className="txt"><b>{world.name[i]}</b><small>{p.why}</small></span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
            {cala && (
              <div className="answer cala">
                <div className="label"><span className={`dot ${cala === 'pending' ? 'pulse' : ''}`} /> Cala knowledge graph</div>
                {cala === 'pending' ? <p className="muted">Researching live, this can take a minute…</p>
                  : cala.error ? <p className="muted">Unavailable: {cala.error}</p>
                    : <CalaText a={cala} onPick={pickId} world={world} />}
              </div>
            )}
            {hits && (mode === 'search' || (mode === 'ask' && !gemma)) && (
              <ul className="list">
                {hits.slice(0, 40).map((h) => {
                  const i = world.index.get(h.id)
                  return i === undefined ? null : (
                    <li key={h.id} className={i === selected ? 'on' : ''} onClick={() => pick(i, true)}>
                      <LogoImg world={world} i={i} />
                      <span className="txt"><b>{world.name[i]}</b><small>{world.themes[world.cluster[i]].label} · {world.countries[world.country[i]]}</small></span>
                      <span className="score">{h.name ? 'name' : `${Math.round(h.score * 100)}%`}</span>
                    </li>
                  )
                })}
              </ul>
            )}
            {(hits || gemma) && <button className="fold" onClick={() => setResultsOpen(false)}>Hide results · {hitsLabel.slice(0, 40)}</button>}
          </div>
        )}
      </section>

      <footer className="v2-bottom">
        <button className={`pill glass ${sizeBy === 'valuation' ? 'on' : ''}`} title={sizeBy === 'valuation' ? 'Nodes are sized by valuation. Click for equal sizes.' : 'Nodes are all the same size. Click to size by valuation.'} onClick={() => setSizeBy(sizeBy === 'valuation' ? 'equal' : 'valuation')}>{sizeBy === 'valuation' ? '€ By value' : '● Equal'}</button>
        <div className="row">
          <button className={`pill glass ${filtersOpen || filtering ? 'on' : ''}`} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{filtering ? ` · ${shownCount.toLocaleString()}` : ''}</button>
          <button className={`pill glass ${themesOpen ? 'on' : ''}`} onClick={() => { setThemesOpen(!themesOpen); setFavsOpen(false); if (themesOpen) setFocusTheme(null) }}>Themes</button>
          <button className={`pill glass ${favsOpen ? 'on' : ''}`} onClick={() => { setFavsOpen(!favsOpen); setThemesOpen(false); setFocusTheme(null) }}>Saved{favSet.size ? ` · ${favSet.size}` : ''}</button>
          {hits && <button className="pill glass on" onClick={clear}>{hits.length} matches ✕</button>}
          {focusTheme !== null && <button className="pill glass on" onClick={() => setFocusTheme(null)}>{world.themes[focusTheme].label} ✕</button>}
        </div>
        {filtersOpen && (
          <div className="filters glass">
            <FilterRow label="Stage" value={filters.stage} options={world.stages.slice(1)} onChange={(v) => setFilters({ ...filters, stage: v })} />
            <FilterRow label="Sector" value={filters.sector} options={world.sectors} onChange={(v) => setFilters({ ...filters, sector: v })} />
            <FilterRow label="Maturity" value={filters.maturity} options={MATURITY.slice(1)} onChange={(v) => setFilters({ ...filters, maturity: v })} />
            <label className="check"><input type="checkbox" checked={filters.unicorn} onChange={(e) => setFilters({ ...filters, unicorn: e.target.checked })} /> Unicorns only (1B+ valuation)</label>
            <label className="check"><input type="checkbox" checked={filters.funded} onChange={(e) => setFilters({ ...filters, funded: e.target.checked })} /> Has raised money</label>
            {filtering && <button className="link" onClick={() => setFilters(NONE)}>Reset filters</button>}
          </div>
        )}
      </footer>

      {favsOpen && <FavSheet world={world} ids={favs} email={session?.user.email} onPick={(i) => pick(i, true)} onRemove={(id) => setFavs(favs.filter((x) => x !== id))} onClose={() => setFavsOpen(false)} />}
      {themesOpen && (
        <ThemeSheet world={world} focus={focusTheme} visible={visible} onFocus={(t) => { setFocusTheme(t); if (t !== null && lens !== 'meaning') setLens('meaning') }} onPick={(i) => pick(i, true)} onClose={() => { setThemesOpen(false); setFocusTheme(null) }} />
      )}
      {selected >= 0 && <Detail world={world} i={selected} beside={resultsOpen && !!(hits || gemma)} fav={favSet.has(selected)} onFav={() => toggleFav(selected)} onPick={pickId} onClose={() => setSelected(-1)} />}
    </div>
  )
}

function FilterRow({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  // Picked with the mouse or a finger, the list lets go of the keyboard: otherwise the arrow keys meant for
  // the boat keep flipping through the filter. Picked with the keyboard, it keeps focus so the arrows still step through it.
  const pointer = useRef(false)
  return (
    <label className="frow">
      <span>{label}</span>
      <select value={value} onPointerDown={() => { pointer.current = true }} onKeyDown={() => { pointer.current = false }}
        onChange={(e) => { onChange(e.target.value); if (pointer.current) e.target.blur() }}>
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

function CalaText({ a, onPick, world }: { a: CalaAnswer; onPick: (id: string) => void; world: World }) {
  const [open, setOpen] = useState(false)
  const onMap = (a.entities ?? []).filter((e) => world.index.has(e.id))
  return (
    <>
      <p className={open ? '' : 'clamp'} onClick={() => setOpen(!open)}>{plain(a.answer ?? '')}</p>
      {onMap.length > 0 && <div className="chips">{onMap.map((e) => <button key={e.id} onClick={() => onPick(e.id)}>{e.name}</button>)}</div>}
      {(a.sources ?? []).length > 0 && <p className="sources">{a.sources!.slice(0, 5).map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.name}</a>)}</p>}
    </>
  )
}
