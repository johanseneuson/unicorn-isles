// Semantic search over the Atlas, all local (transformers.js), no API key:
// POST /api/semantic {q} | {id}          -> {hits: [{id, score}]}  startups by meaning (bge-small): words or another startup
// POST /api/logos    {q} | {image} | {id} -> {hits: [{id, score}]}  logos by look (CLIP): words, a picture (data URL) or another logo
// Vectors come from scripts/atlas.mjs (src/data/atlas-*.bin); models download once into .cache/models.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = (p) => new URL(`../${p}`, import.meta.url)
const TOP = 80
const MAX_BODY = 1_000_000
// bge wants this prefix on queries (not on documents).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

let index = null
function load() {
  const paths = ['src/data/world.json', 'src/data/atlas-text.bin', 'src/data/atlas-logo.bin']
  if (!paths.every((p) => existsSync(file(p)))) throw new Error('no atlas yet: run node scripts/atlas.mjs')
  const mtime = statSync(file(paths[0])).mtimeMs
  if (index?.mtime === mtime) return index
  const meta = JSON.parse(readFileSync(file(paths[0]), 'utf8'))
  const text = new Int8Array(readFileSync(file(paths[1])).buffer.slice(0))
  const logo = new Int8Array(readFileSync(file(paths[2])).buffer.slice(0))
  // Logo vectors are stored in sprite order: meta.logo[i] is startup i's slot.
  const logoIds = []
  meta.logo.forEach((k, i) => { if (k >= 0) logoIds[k] = meta.id[i] })
  index = {
    mtime, meta,
    lower: meta.name.map((n) => n.toLowerCase()),
    text: { ids: meta.id, vecs: text, dim: text.length / meta.id.length },
    logo: { ids: logoIds, vecs: logo, dim: logo.length / Math.max(1, logoIds.length) },
  }
  return index
}

function rank({ ids, vecs, dim }, q, skip) {
  const scores = new Float32Array(ids.length)
  for (let i = 0; i < ids.length; i++) {
    let s = 0
    for (let k = 0, o = i * dim; k < dim; k++) s += vecs[o + k] * q[k]
    scores[i] = s / 127
  }
  return [...scores.keys()].filter((i) => ids[i] !== skip).sort((a, b) => scores[b] - scores[a]).slice(0, TOP)
    .map((i) => ({ id: ids[i], score: Math.round(scores[i] * 1000) / 1000 }))
}

const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n) }

// Models load on first use and stay in memory.
let tf = null
const models = {}
async function lib() {
  tf ??= await import('@huggingface/transformers')
  tf.env.cacheDir = fileURLToPath(file('.cache/models/'))
  return tf
}
async function textModel() {
  const { pipeline } = await lib()
  models.text ??= pipeline('feature-extraction', load().meta.models.text, { dtype: 'q8' })
  return models.text
}
async function clip() {
  const t = await lib()
  const name = load().meta.models.logo
  models.clip ??= Promise.all([
    t.AutoTokenizer.from_pretrained(name),
    t.CLIPTextModelWithProjection.from_pretrained(name, { dtype: 'q8' }),
    t.AutoProcessor.from_pretrained(name),
    t.CLIPVisionModelWithProjection.from_pretrained(name, { dtype: 'q8' }),
  ])
  return models.clip
}

// Hybrid: a startup whose name contains the query goes first, the rest by meaning.
export async function semantic(q, id) {
  const idx = load()
  if (id) {
    const k = idx.text.ids.indexOf(id)
    if (k < 0) return { hits: [] }
    const { dim, vecs } = idx.text
    return { hits: rank(idx.text, Array.from(vecs.subarray(k * dim, (k + 1) * dim), (x) => x / 127), id) }
  }
  const ext = await textModel()
  const out = await ext(QUERY_PREFIX + q, { pooling: 'cls', normalize: true })
  const hits = rank(idx.text, out.data)
  const needle = q.toLowerCase()
  const named = []
  if (needle.length > 2) idx.lower.forEach((n, i) => { if (named.length < 5 && n.includes(needle)) named.push({ id: idx.meta.id[i], score: 1, name: true }) })
  const seen = new Set(named.map((h) => h.id))
  return { hits: [...named, ...hits.filter((h) => !seen.has(h.id))].slice(0, TOP) }
}

export async function logos({ q, image, id }) {
  const idx = load()
  if (id) {
    const k = idx.logo.ids.indexOf(id)
    if (k < 0) return { hits: [] }
    return { hits: rank(idx.logo, Array.from(idx.logo.vecs.subarray(k * idx.logo.dim, (k + 1) * idx.logo.dim), (x) => x / 127), id) }
  }
  const [tokenizer, textTower, processor, vision] = await clip()
  if (image) {
    const { RawImage } = await lib()
    const blob = await (await fetch(image)).blob()
    const img = await RawImage.fromBlob(blob)
    const { image_embeds } = await vision(await processor(img.rgb()))
    return { hits: rank(idx.logo, unit(image_embeds.data)) }
  }
  // Logos are pictures, so the words are framed as a description of one.
  const inputs = tokenizer([`a logo of ${q}`], { padding: true, truncation: true })
  const { text_embeds } = await textTower(inputs)
  return { hits: rank(idx.logo, unit(text_embeds.data)) }
}

// Full record for one startup: the page only holds compact columns for the whole world.
let records = null
let checked = 0
function startup(id) {
  // A list asks for up to 60 records at once: look at the file on disk at most every few seconds.
  if (!records || Date.now() - checked > 5000) {
    checked = Date.now()
    const src = existsSync(file('data/world-startups.json')) ? 'data/world-startups.json' : 'src/data/startups.json'
    const mtime = statSync(file(src)).mtimeMs
    if (records?.mtime !== mtime) records = { mtime, byId: new Map(JSON.parse(readFileSync(file(src), 'utf8')).map((s) => [s.id, s])) }
  }
  const s = records.byId.get(id)
  if (!s) throw new Error('unknown startup')
  records.summaries ??= existsSync(file('src/data/summaries.json')) ? JSON.parse(readFileSync(file('src/data/summaries.json'), 'utf8')) : {}
  records.prov ??= existsSync(file('src/data/prov.json')) ? JSON.parse(readFileSync(file('src/data/prov.json'), 'utf8')) : {}
  return { ...s, summary: records.summaries[id] ?? null, prov: records.prov[id] ?? null }
}

// The fast mixture-of-experts Gemma first; the API returns sporadic 500s, so retry and fall back.
const GEMMAS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it']
async function gemmaCall(key, prompt) {
  let last = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    const model = GEMMAS[attempt % GEMMAS.length]
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'minimal' } } }),
      signal: AbortSignal.timeout(90000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }))
    const out = await res.json().catch(() => ({}))
    if (res.ok) return { out, model }
    last = `gemma ${res.status}: ${out.error?.message ?? ''}`
    if (res.status !== 0 && res.status !== 429 && res.status < 500) break
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  throw new Error(last)
}

// Plain-language question -> local shortlist by meaning -> Gemma picks and says why.
async function askGemma(question, key) {
  if (!key) throw new Error('GEMINI_API_KEY missing in .env')
  const { hits } = await semantic(question)
  const shortlist = hits.slice(0, 24).map((h) => {
    const s = startup(h.id)
    return {
      id: s.id, name: s.name, country: s.country, founded: s.founded,
      raised: s.totalFunding ? `${s.totalFunding.value} ${s.totalFunding.units}` : undefined,
      investors: (s.investors ?? []).slice(0, 3).map((i) => i.name),
      about: (s.summary?.summary ?? s.description ?? '').slice(0, 220),
    }
  })
  const prompt = `You help investors and founders explore startups. Answer the question using only the candidates below.
Reply with JSON only, no reasoning, in this exact shape:
{"answer": "1-3 plain sentences", "picks": [{"id": "<candidate id>", "why": "one short reason"}]}
Pick up to 8 candidates that fit best. If none fit, say so in "answer" and return an empty "picks".

Question: ${question}

Candidates:
${JSON.stringify(shortlist)}`
  const { out, model } = await gemmaCall(key, prompt)
  // Gemma may think out loud before the JSON; keep the last object that parses.
  const text = (out.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('')
  let parsed = null
  for (let end = text.lastIndexOf('}'); end > 0 && !parsed; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0 && !parsed; start = text.lastIndexOf('{', start - 1)) {
      try { const v = JSON.parse(text.slice(start, end + 1)); if (v && 'answer' in v) parsed = v } catch { /* keep looking */ }
    }
  }
  const valid = new Set(shortlist.map((s) => s.id))
  return {
    answer: parsed?.answer ?? 'Gemma did not return an answer.',
    picks: (parsed?.picks ?? []).filter((p) => valid.has(p.id)).slice(0, 8),
    model,
  }
}

export function semanticPlugin({ gemini } = {}) {
  const routes = {
    '/api/ask-gemma': (b) => {
      const q = String(b.question ?? '').trim().slice(0, 400)
      if (!q) throw new Error('empty question')
      return askGemma(q, gemini)
    },
    // {id} -> full record; {ids} -> light records for lists (name, place, money, investors).
    '/api/startup': (b) => (Array.isArray(b.ids)
      ? b.ids.slice(0, 60).map((id) => {
        try {
          const s = startup(String(id))
          return { id: s.id, name: s.name, country: s.country, founded: s.founded, totalFunding: s.totalFunding, stage: s.fundingStage, investors: s.investors ?? [] }
        } catch { return null }
      }).filter(Boolean)
      : startup(String(b.id ?? ''))),
    '/api/semantic': (b) => {
      if (b.id) return semantic('', String(b.id))
      const q = String(b.q ?? '').trim().slice(0, 300)
      if (!q) throw new Error('empty query')
      return semantic(q)
    },
    '/api/logos': (b) => logos({ q: String(b.q ?? '').slice(0, 300), image: typeof b.image === 'string' && b.image.startsWith('data:image/') ? b.image : null, id: b.id ? String(b.id) : null }),
  }
  const handler = async (req, res, next) => {
    const route = routes[req.url]
    if (!route || req.method !== 'POST') return next()
    res.setHeader('Content-Type', 'application/json')
    // Bodies are small JSON (a dropped picture is shrunk to 256 px first): refuse anything huge.
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) { res.statusCode = 413; res.end(JSON.stringify({ error: 'request too large' })); req.destroy(); return }
    }
    try {
      res.end(JSON.stringify(await route(JSON.parse(raw || '{}'))))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: e.message }))
    }
  }
  // Load the search model as the server starts, so the first search does not wait for it.
  const warm = () => { textModel().catch(() => { /* no atlas or model yet: the first search reports it */ }) }
  return {
    name: 'semantic-api',
    configureServer: (server) => { server.middlewares.use(handler); warm() },
    configurePreviewServer: (server) => { server.middlewares.use(handler); warm() },
  }
}
