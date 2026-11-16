// Compact columnar world written by scripts/atlas.mjs; details per startup come from /api/startup.
export interface Raw {
  models: { text: string; logo: string }
  sectors: string[]; countries: string[]; stages: string[]
  id: string[]; name: string[]; sector: number[]; country: number[]; founded: number[]; raised: number[]
  stage: number[]; investors: number[]; slush: number[]; cluster: number[]; cluster2: number[]; mix: number[]; logo: number[]
  // value: valuation in EUR for node size; valueSrc 1 Cala, 2 model recollection, 3 estimated from money raised, 0 none.
  // maturity: 0 unknown, 1 early, 2 startup, 3 scale-up, 4 established.
  value: number[]; valueSrc: number[]; maturity: number[]; employees: number[]
  // Per country: is it in Europe (the World layout shows Europe only).
  europe: boolean[]
  // Palette index per country, chosen so neighbours never share a colour (-1 outside Europe).
  countryColor: number[]
  // Index of Cala itself (pinned to Barcelona), or -1.
  home: number
  meaning: number[]; look: number[]; world: number[]
  clusters: { label: string; terms: string[]; x: number; y: number; size: number }[]
  sprite: { url: string; ink: string; cols: number; cell: number; width: number; height: number }
}

export type RGB = [number, number, number]
// x, y: the densest spot of the theme on the Meaning map, where its name is lettered.
export interface Theme { index: number; label: string; terms: string[]; size: number; color: RGB; x: number; y: number }
export interface World extends Raw {
  n: number
  index: Map<string, number>
  themes: Theme[]
  region: string[]
}

// Layouts change where startups sit; stage, sector and money only change colour and size,
// so the cloud keeps its shape while you explore.
export type Lens = 'meaning' | 'world'
export const LENSES: { key: Lens; label: string; hint: string }[] = [
  { key: 'meaning', label: 'Meaning', hint: 'Similar companies sit together (t-SNE of what they do)' },
  { key: 'world', label: 'Europe', hint: 'Europe country by country, with a clear border between them' },
]

export type ColorBy = 'theme' | 'sector' | 'stage' | 'money' | 'age' | 'region' | 'maturity' | 'country'
export const COLOR_BY: { key: ColorBy; label: string }[] = [
  { key: 'theme', label: 'Theme' }, { key: 'maturity', label: 'Maturity' }, { key: 'country', label: 'Country' }, { key: 'sector', label: 'Sector' }, { key: 'stage', label: 'Stage' },
  { key: 'money', label: 'Raised' }, { key: 'age', label: 'Age' }, { key: 'region', label: 'Region' },
]

// Watercolour inks on parchment: terracotta, sage, ochre, slate, plum, teal...
export const PALETTE: RGB[] = [
  [196, 98, 74], [122, 150, 96], [214, 160, 72], [86, 120, 156], [140, 96, 140], [72, 140, 132],
  [178, 128, 92], [158, 168, 90], [120, 98, 160], [196, 132, 120], [92, 150, 110], [170, 110, 60],
  [110, 132, 176], [176, 86, 110], [134, 120, 82], [70, 112, 120], [200, 150, 110], [102, 86, 120],
  [160, 176, 140], [186, 112, 82], [96, 128, 92], [150, 84, 70], [124, 160, 168], [190, 170, 110],
]
export const STAGE_COLORS: RGB[] = [[170, 158, 136], [122, 150, 96], [72, 140, 132], [86, 120, 156], [140, 96, 140], [196, 98, 74]]

export type SizeBy = 'valuation' | 'equal'
export const SIZE_BY: { key: SizeBy; label: string }[] = [
  { key: 'valuation', label: 'Valuation' }, { key: 'equal', label: 'Equal' },
]

// Rough centroid per country (lon, lat) for the World lens.
const GEO: Record<string, [number, number]> = {
  Finland: [26, 63], Sweden: [16, 62], Norway: [9, 61], Denmark: [10, 56], Iceland: [-19, 65], Estonia: [25.5, 58.7], Latvia: [24.8, 56.9],
  Lithuania: [24, 55.3], Germany: [10.4, 51], France: [2.5, 46.6], 'United Kingdom': [-2, 53], Ireland: [-8, 53.3], Netherlands: [5.3, 52.2],
  Belgium: [4.6, 50.6], Luxembourg: [6.1, 49.7], Switzerland: [8.2, 46.8], Austria: [14.5, 47.6], Spain: [-3.6, 40.3], Portugal: [-8.2, 39.6],
  Italy: [12.5, 42.8], Poland: [19.4, 52], Czechia: [15.4, 49.8], 'Czech Republic': [15.4, 49.8], Slovakia: [19.5, 48.7], Hungary: [19.4, 47.2],
  Romania: [25, 45.9], Bulgaria: [25.5, 42.7], Greece: [22, 39.3], Croatia: [16, 45.2], Slovenia: [14.8, 46.1], Serbia: [20.8, 44],
  Ukraine: [31, 49], Turkey: [35, 39], Türkiye: [35, 39], Israel: [35, 31.4], Cyprus: [33.2, 35], Malta: [14.4, 35.9],
  'United States': [-98, 39], Canada: [-100, 56], Mexico: [-102, 23], Brazil: [-51, -10], Argentina: [-64, -34], Chile: [-71, -33],
  Colombia: [-74, 4.5], Peru: [-75, -9], India: [79, 22], China: [104, 35], Japan: [138, 37], 'South Korea': [128, 36.5], Singapore: [103.8, 1.35],
  'Hong Kong': [114.2, 22.3], Taiwan: [121, 23.7], Indonesia: [117, -2], Vietnam: [106, 16], Thailand: [101, 15], Malaysia: [102, 4], Philippines: [122, 12],
  Australia: [134, -25], 'New Zealand': [172, -41], 'United Arab Emirates': [54, 24], 'Saudi Arabia': [45, 24], Qatar: [51.2, 25.3],
  Egypt: [30, 27], Nigeria: [8, 9.5], Kenya: [38, 0.5], 'South Africa': [24, -29], Morocco: [-7, 32], Russia: [60, 58],
}
const REGION_OF = (c: string) => {
  const g = GEO[c]
  if (c === 'Unknown') return 'Elsewhere'
  if (!g) return 'Elsewhere'
  const [lon, lat] = g
  if (['Finland', 'Sweden', 'Norway', 'Denmark', 'Iceland', 'Estonia', 'Latvia', 'Lithuania'].includes(c)) return 'Nordics & Baltics'
  if (lon > -30 && lon < 45 && lat > 34) return 'Rest of Europe'
  if (lon < -30 && lat > 15) return 'North America'
  if (lon < -30) return 'Latin America'
  if (lat < 0 && lon > 100) return 'Oceania'
  if (lon > 60) return 'Asia'
  return 'Middle East & Africa'
}
export const REGIONS = ['Nordics & Baltics', 'Rest of Europe', 'North America', 'Latin America', 'Asia', 'Oceania', 'Middle East & Africa', 'Elsewhere']

// Themes blend into each other, so their median can sit in someone else's land; use the peak instead.
function densest(raw: Raw, t: number) {
  const bins = new Map<string, number>()
  const B = 6
  let best = '', most = 0
  raw.cluster.forEach((c, i) => {
    if (c !== t) return
    const key = `${Math.floor(raw.meaning[2 * i] / B)},${Math.floor(raw.meaning[2 * i + 1] / B)}`
    const n = (bins.get(key) ?? 0) + 1
    bins.set(key, n)
    if (n > most) { most = n; best = key }
  })
  const [bx, by] = best ? best.split(',').map(Number) : [0, 0]
  return { x: (bx + 0.5) * B, y: (by + 0.5) * B }
}

const files = import.meta.glob<Raw>('../data/world.json', { import: 'default' })
export async function loadWorld(): Promise<World | null> {
  const raw = await files['../data/world.json']?.()
  if (!raw) return null
  const n = raw.id.length
  return {
    ...raw,
    n,
    index: new Map(raw.id.map((id, i) => [id, i])),
    themes: raw.clusters.map((c, i) => ({ index: i, label: c.label, terms: c.terms, size: c.size, color: PALETTE[i % PALETTE.length], ...densest(raw, i) })),
    region: raw.countries.map(REGION_OF),
  }
}

// ---------- lens layouts, all computed by scripts/atlas.mjs ----------
const cache = new Map<string, Float32Array>()
export function lensPositions(w: World, lens: Lens): Float32Array {
  const hit = cache.get(lens)
  if (hit) return hit
  const out = new Float32Array(w.n * 2)
  for (let i = 0; i < w.n; i++) {
    const src = lens === 'world' ? w.world : w.meaning
    out[2 * i] = src[2 * i]
    out[2 * i + 1] = src[2 * i + 1]
  }
  cache.set(lens, out)
  return out
}

// Largest texture this device's GPU accepts (4096 on many phones).
let maxTex = 0
function maxTexture() {
  if (!maxTex) {
    try {
      const c = document.createElement('canvas')
      const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
      maxTex = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { maxTex = 4096 }
  }
  return maxTex
}
// Many phone GPUs can't load the full logo sheet and draw black boxes: they get the half-size one.
// The map and the logos in the panels use the same file, so the sheet downloads only once.
export const halfSheet = (w: World) => maxTexture() < Math.max(w.sprite.width, w.sprite.height)
export const sheetUrl = (w: World, file = w.sprite.url) => `/${halfSheet(w) ? file.replace(/\.webp$/, '.half.webp') : file}`

export const money = (eur: number) => (!eur ? '' : eur >= 1e9 ? `€${(eur / 1e9).toFixed(1)}B` : eur >= 1e6 ? `€${(eur / 1e6).toFixed(eur >= 1e7 ? 0 : 1)}M` : eur >= 1e3 ? `€${Math.round(eur / 1e3)}k` : `€${eur}`)

// Young ventures against established companies.
export const MATURITY = ['Unknown', 'Early stage', 'Startup', 'Scale-up', 'Established']
export const MATURITY_COLORS: RGB[] = [[190, 178, 156], [122, 168, 110], [86, 140, 176], [214, 160, 72], [112, 96, 128]]
export const isUnicorn = (w: World, i: number) => w.value[i] >= 0.9e9 && w.valueSrc[i] > 0 && w.valueSrc[i] < 3
export const VALUE_SRC = ['', 'Cala', 'model estimate', 'estimated from money raised']
