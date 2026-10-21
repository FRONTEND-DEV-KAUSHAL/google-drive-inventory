import { openDB, type IDBPDatabase } from 'idb'
import { DriveError, FOLDER_MIME, getContent, getStartPageToken, listFiles, type DriveFile } from './drive'

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
export type Issue = 'bad-name' | 'missing-details' | 'malformed-details' | 'details-unreadable'
export type Details = {
  length?: number
  width?: number
  height?: number
  dimension_unit?: string
  weight?: number
  weight_unit?: string
  image_src: string[]
}
export type Image = { id: string; name: string; thumb?: string } // thumb = short-lived thumbnailLink; display only
export type Category = { id: string; name: string }
export type Item = {
  id: string
  name: string
  categoryId: string
  detailsId?: string
  detailsModified?: string
  details?: Details
  images: Image[]
  issues: Issue[]
}
export type Catalog = {
  v: 1
  rootId: string
  changesToken: string
  builtAt: number
  thumbsAt: number
  categories: Category[]
  items: Item[]
}
export type DetailsResult = { details?: Details; issue?: 'malformed-details' | 'details-unreadable' }

export function parseDetails(raw: unknown): DetailsResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { issue: 'malformed-details' }
  const r = raw as Record<string, unknown>
  const d: Details = { image_src: [] }
  let bad = false
  for (const k of ['length', 'width', 'height', 'weight'] as const) {
    const v = r[k]
    if (v === undefined) continue
    if ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v))) d[k] = Number(v)
    else bad = true
  }
  for (const k of ['dimension_unit', 'weight_unit'] as const) {
    const v = r[k]
    if (v === undefined) continue
    if (typeof v === 'string') d[k] = v
    else bad = true
  }
  if (r.image_src !== undefined) {
    if (Array.isArray(r.image_src)) {
      for (const s of r.image_src) typeof s === 'string' ? d.image_src.push(s) : (bad = true)
    } else bad = true
  }
  return bad ? { details: d, issue: 'malformed-details' } : { details: d }
}

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

export function treeOf(rootId: string, folders: DriveFile[]) {
  const categories = folders.filter((f) => f.parents?.includes(rootId)).sort(byName)
  const catIds = new Set(categories.map((c) => c.id))
  const items = folders.filter((f) => !f.parents?.includes(rootId) && f.parents?.some((p) => catIds.has(p))).sort(byName)
  return { categories, items }
}

export const srcId = (s: string) => s.match(/[?&]id=([\w-]+)/)?.[1] ?? s.match(/\/d\/([\w-]+)/)?.[1] ?? s

export function assemble(
  rootId: string,
  changesToken: string,
  folders: DriveFile[],
  detailsFiles: DriveFile[],
  images: DriveFile[],
  results: Map<string, DetailsResult>,
): Catalog {
  const { categories, items } = treeOf(rootId, folders)
  const catIds = new Set(categories.map((c) => c.id))
  const detailsBy = new Map<string, DriveFile>()
  for (const f of detailsFiles) {
    const p = f.parents?.[0]
    if (!p) continue
    const cur = detailsBy.get(p)
    if (!cur || (f.modifiedTime ?? '') > (cur.modifiedTime ?? '')) detailsBy.set(p, f)
  }
  const imgBy = new Map<string, DriveFile[]>()
  for (const f of images) {
    const p = f.parents?.[0]
    if (p) (imgBy.get(p) ?? imgBy.set(p, []).get(p)!).push(f)
  }
  const out: Item[] = items.map((f) => {
    const categoryId = f.parents!.find((p) => catIds.has(p))!
    const issues: Issue[] = []
    if (!SLUG.test(f.name)) issues.push('bad-name')
    const df = detailsBy.get(f.id)
    let details: Details | undefined
    if (!df) issues.push('missing-details')
    else {
      const r = results.get(df.id)
      details = r?.details
      if (r?.issue) issues.push(r.issue)
    }
    const order = new Map((details?.image_src ?? []).map((s, i) => [srcId(s), i]))
    const imgs = (imgBy.get(f.id) ?? []).sort(
      (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || byName(a, b),
    )
    return {
      id: f.id,
      name: f.name,
      categoryId,
      detailsId: df?.id,
      detailsModified: df?.modifiedTime,
      details,
      images: imgs.map((i) => ({ id: i.id, name: i.name, thumb: i.thumbnailLink })),
      issues,
    }
  })
  const now = Date.now()
  return {
    v: 1,
    rootId,
    changesToken,
    builtAt: now,
    thumbsAt: now,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    items: out,
  }
}

export function filterItems(items: Item[], q: string, categoryId?: string): Item[] {
  const n = q.trim().toLowerCase()
  return items.filter((i) => (!categoryId || i.categoryId === categoryId) && i.name.toLowerCase().includes(n))
}

export async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) await fn(xs[i++])
    }),
  )
}

export async function scan(
  rootId: string,
  prev: Catalog | null,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Catalog> {
  const changesToken = await getStartPageToken() // first: Phase 5 replays changes made during the crawl
  // ponytail: whole-Drive queries filtered client-side; if the Drive has huge unrelated content, scope with chunked `'<id>' in parents` ORs.
  const [folders, detailsAll, images] = await Promise.all([
    listFiles(`mimeType='${FOLDER_MIME}'`, 'files(id,name,parents)'),
    listFiles("name='details.json'", 'files(id,parents,modifiedTime)'),
    listFiles("mimeType contains 'image/'", 'files(id,name,parents,thumbnailLink)'),
  ])
  const itemIds = new Set(treeOf(rootId, folders).items.map((i) => i.id))
  const detailsFiles = detailsAll.filter((f) => f.parents?.[0] && itemIds.has(f.parents[0]))
  const prevBy = new Map((prev?.items ?? []).filter((i) => i.detailsId).map((i) => [i.detailsId!, i]))
  const results = new Map<string, DetailsResult>()
  const queue: DriveFile[] = []
  for (const f of detailsFiles) {
    const p = prevBy.get(f.id)
    if (p && p.detailsModified === f.modifiedTime && !p.issues.includes('details-unreadable')) {
      results.set(f.id, { details: p.details, issue: p.issues.includes('malformed-details') ? 'malformed-details' : undefined })
    } else queue.push(f)
  }
  let done = 0
  onProgress(0, queue.length)
  await pool(queue, 6, async (f) => {
    try {
      results.set(f.id, parseDetails(await getContent(f.id)))
    } catch (e) {
      if (e instanceof SyntaxError) results.set(f.id, { issue: 'malformed-details' })
      else if (e instanceof DriveError) results.set(f.id, { issue: 'details-unreadable' })
      else throw e
    }
    onProgress(++done, queue.length)
  })
  return assemble(rootId, changesToken, folders, detailsFiles, images, results)
}

// ponytail: one blob (~1MB at 2k items); split per item if writes get slow.
let dbp: Promise<IDBPDatabase> | undefined
const db = () => (dbp ??= openDB('drive-inventory', 1, { upgrade: (d) => void d.createObjectStore('kv') }))
const load = () => db().then((d) => d.get('kv', 'catalog') as Promise<Catalog | undefined>)
const save = (c: Catalog) => db().then((d) => d.put('kv', c, 'catalog'))

export type CatalogState = { catalog: Catalog | null; busy: { done: number; total: number } | null; error: string | null }
let state: CatalogState = { catalog: null, busy: null, error: null }
const subs = new Set<() => void>()
const set = (patch: Partial<CatalogState>) => {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
export function subscribe(fn: () => void) {
  subs.add(fn)
  return () => void subs.delete(fn)
}
export const getCatalog = () => state

// After a write: patch the cached catalog from the write response instead of rescanning (list results lag).
export async function applyLocal(fn: (c: Catalog) => Catalog) {
  if (!state.catalog) return
  const next = fn(state.catalog)
  set({ catalog: next })
  await save(next)
}

let lastRoot: string | undefined
let inflight: Promise<void> | null = null
const dedupe = (p: () => Promise<void>) => (inflight ??= p().finally(() => void (inflight = null)))

async function run(rootId: string, prev: Catalog | null) {
  set({ busy: { done: 0, total: 0 }, error: null })
  try {
    const c = await scan(rootId, prev, (done, total) => set({ busy: { done, total } }))
    await save(c)
    set({ catalog: c, busy: null })
  } catch (e) {
    set({ busy: null, error: String((e as Error)?.message ?? e) })
  }
}

// ponytail: thumbnailLink expires after hours; Phase 4 public lh3 URLs remove the need.
async function refreshThumbs(c: Catalog) {
  const links = new Map((await listFiles("mimeType contains 'image/'", 'files(id,thumbnailLink)')).map((f) => [f.id, f.thumbnailLink]))
  const next: Catalog = {
    ...c,
    thumbsAt: Date.now(),
    items: c.items.map((i) => ({ ...i, images: i.images.map((m) => ({ ...m, thumb: links.get(m.id) ?? m.thumb })) })),
  }
  await save(next)
  set({ catalog: next })
}

export const openCatalog = (rootId: string) =>
  dedupe(async () => {
    lastRoot = rootId
    const cached = await load()
    if (cached?.v === 1 && cached.rootId === rootId) {
      set({ catalog: cached })
      if (Date.now() - cached.thumbsAt > 3_600_000) await refreshThumbs(cached).catch((e) => console.warn('thumb refresh failed', e))
      return
    }
    if (state.catalog && state.catalog.rootId !== rootId) set({ catalog: null }) // don't show previous root's items
    await run(rootId, null)
  })

export const rescan = () =>
  dedupe(async () => {
    const rootId = state.catalog?.rootId ?? lastRoot
    if (rootId) await run(rootId, state.catalog)
  })
