import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveFile } from './drive'

const mem = new Map<string, unknown>()
vi.mock('idb', () => ({
  openDB: async () => ({
    get: async (_s: string, k: string) => mem.get(k),
    put: async (_s: string, v: unknown, k: string) => void mem.set(k, v),
  }),
}))
vi.mock('./drive', async (orig) => ({
  ...(await orig<typeof import('./drive')>()),
  listFiles: vi.fn(),
  getContent: vi.fn(),
  getStartPageToken: vi.fn(),
}))

const F = (id: string, name: string, parents: string[], extra: Partial<DriveFile> = {}): DriveFile => ({ id, name, parents, ...extra })

async function fresh() {
  vi.resetModules()
  const m = await import('./catalog')
  const d = await import('./drive')
  vi.mocked(d.getStartPageToken).mockResolvedValue('tok')
  return { m, d }
}

function fixture(n: number) {
  const folders = [F('cat', 'cat-a', ['root']), F('other', 'x', ['elsewhere'])]
  const details: DriveFile[] = [F('dout', 'details.json', ['other'], { modifiedTime: 't' })]
  for (let i = 0; i < n; i++) {
    folders.push(F('i' + i, 'item-' + i, ['cat']))
    details.push(F('d' + i, 'details.json', ['i' + i], { modifiedTime: 't1' }))
  }
  return { folders, details, images: [F('img', 'a.jpg', ['i0'], { thumbnailLink: 'u' })] }
}
function wire(d: typeof import('./drive'), fx: ReturnType<typeof fixture>) {
  vi.mocked(d.listFiles).mockImplementation(async (q: string) =>
    q.includes('folder') ? fx.folders : q.includes('details.json') ? fx.details : fx.images,
  )
  vi.mocked(d.getContent).mockResolvedValue({ height: 3 })
}

beforeEach(() => {
  mem.clear()
  vi.clearAllMocks()
})

describe('pure core', () => {
  it('parseDetails lenient', async () => {
    const { m } = await fresh()
    for (const x of [null, 'x', []]) expect(m.parseDetails(x)).toEqual({ issue: 'malformed-details' })
    const ok = m.parseDetails({ height: '10', width: 5, image_src: ['a'], junk: 1 })
    expect(ok.details?.height).toBe(10)
    expect(ok.issue).toBeUndefined()
    const bad = m.parseDetails({ height: 'tall' })
    expect(bad.issue).toBe('malformed-details')
    expect(bad.details?.height).toBeUndefined()
    expect(bad.details?.image_src).toEqual([])
    expect(m.parseDetails({ image_src: 'a' })).toMatchObject({ issue: 'malformed-details', details: { image_src: [] } })
    expect(m.parseDetails({})).toEqual({ details: { image_src: [] } })
  })

  it('assemble builds tree, ignores strays, flags health, orders images', async () => {
    const { m } = await fresh()
    const folders = [
      F('c2', 'b-cat', ['root']),
      F('c1', 'a-cat', ['root']),
      F('i1', 'Red Mug', ['c1']),
      F('i2', 'red-mug-2', ['c1']),
      F('nested', 'n', ['i1']),
      F('stray', 's', ['nowhere']),
    ]
    const details = [
      F('dOld', 'details.json', ['i2'], { modifiedTime: '1' }),
      F('dNew', 'details.json', ['i2'], { modifiedTime: '2' }),
    ]
    const images = [F('x', 'z.jpg', ['i2']), F('y', 'a.jpg', ['i2']), F('w', 'm.jpg', ['i2'])]
    const results = new Map([
      ['dNew', { details: { image_src: ['https://drive.google.com/uc?export=download&id=w', 'https://drive.google.com/file/d/x/view'] } }],
    ])
    const c = m.assemble('root', 'tok', folders, details, images, results)
    expect(c.categories.map((x) => x.name)).toEqual(['a-cat', 'b-cat'])
    expect(c.items.map((x) => x.name)).toEqual(['Red Mug', 'red-mug-2'])
    const [mug, mug2] = c.items
    expect(mug.issues).toEqual(['bad-name', 'missing-details'])
    expect(mug2.issues).toEqual([])
    expect(mug2.detailsId).toBe('dNew')
    expect(mug2.images.map((i) => i.id)).toEqual(['w', 'x', 'y'])
  })

  it('filterItems', async () => {
    const { m } = await fresh()
    const mk = (name: string, categoryId: string) => ({ id: name, name, categoryId, images: [], issues: [] })
    const items = [mk('red-mug', 'a'), mk('blue-pen', 'b')]
    expect(m.filterItems(items, 'MUG').map((i) => i.name)).toEqual(['red-mug'])
    expect(m.filterItems(items, '', 'b').map((i) => i.name)).toEqual(['blue-pen'])
    expect(m.filterItems(items, '')).toHaveLength(2)
  })
})

describe('scan', () => {
  it('token first, exactly 3 lists, content per item details only, progress ends total', async () => {
    const { m, d } = await fresh()
    wire(d, fixture(5))
    const prog = vi.fn()
    const c = await m.scan('root', null, prog)
    expect(d.listFiles).toHaveBeenCalledTimes(3)
    expect(vi.mocked(d.getStartPageToken).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(d.listFiles).mock.invocationCallOrder[0],
    )
    expect(c.changesToken).toBe('tok')
    expect(d.getContent).toHaveBeenCalledTimes(5)
    expect(vi.mocked(d.getContent).mock.calls.some(([id]) => id === 'dout')).toBe(false)
    expect(prog).toHaveBeenLastCalledWith(5, 5)
  })

  it('still 3 lists for 50 items', async () => {
    const { m, d } = await fresh()
    wire(d, fixture(50))
    await m.scan('root', null)
    expect(d.listFiles).toHaveBeenCalledTimes(3)
  })

  it('reuses unchanged details', async () => {
    const { m, d } = await fresh()
    const fx = fixture(2)
    wire(d, fx)
    const prev = await m.scan('root', null)
    vi.mocked(d.getContent).mockClear()
    fx.details[2] = { ...fx.details[2], modifiedTime: 't2' }
    const c = await m.scan('root', prev)
    expect(vi.mocked(d.getContent).mock.calls.map(([id]) => id)).toEqual(['d1'])
    expect(c.items[0].details?.height).toBe(3)
  })

  it('bad items are flagged, never thrown', async () => {
    const { m, d } = await fresh()
    wire(d, fixture(3))
    vi.mocked(d.getContent).mockImplementation(async (id: string) => {
      if (id === 'd0') throw new SyntaxError('x')
      if (id === 'd1') throw new d.DriveError(404, 'notFound', 'nf')
      return { height: 1 } as never
    })
    const c = await m.scan('root', null)
    expect(c.items.map((i) => i.issues)).toEqual([['malformed-details'], ['details-unreadable'], []])
  })
})

describe('store', () => {
  const cached = (over = {}) => ({ v: 1, rootId: 'root', changesToken: 't', builtAt: 0, thumbsAt: Date.now(), categories: [], items: [], ...over })

  it('serves cache without crawling', async () => {
    const { m, d } = await fresh()
    mem.set('catalog', cached())
    await m.openCatalog('root')
    expect(m.getCatalog().catalog).toEqual(mem.get('catalog'))
    expect(d.listFiles).not.toHaveBeenCalled()
  })

  it('applyLocal patches memory and IDB', async () => {
    const { m } = await fresh()
    mem.set('catalog', cached())
    await m.openCatalog('root')
    await m.applyLocal((c) => ({ ...c, categories: [{ id: 'x', name: 'X' }] }))
    expect(m.getCatalog().catalog?.categories).toEqual([{ id: 'x', name: 'X' }])
    expect(mem.get('catalog')).toBe(m.getCatalog().catalog)
    const f = vi.fn()
    const { m: m2 } = await fresh()
    await m2.applyLocal(f)
    expect(f).not.toHaveBeenCalled()
  })

  it('scans and saves when no cache', async () => {
    const { m, d } = await fresh()
    wire(d, fixture(2))
    await m.openCatalog('root')
    expect(mem.get('catalog')).toBe(m.getCatalog().catalog)
    expect(m.getCatalog().catalog?.items).toHaveLength(2)
  })

  it('stale thumbs refresh with one images query', async () => {
    const { m, d } = await fresh()
    const it = { id: 'i0', name: 'item-0', categoryId: 'c', images: [{ id: 'img', name: 'a', thumb: 'old' }], issues: [] }
    mem.set('catalog', cached({ thumbsAt: Date.now() - 2 * 3_600_000, items: [it] }))
    vi.mocked(d.listFiles).mockResolvedValue([{ id: 'img', name: '', thumbnailLink: 'new' }])
    await m.openCatalog('root')
    expect(d.listFiles).toHaveBeenCalledTimes(1)
    expect(m.getCatalog().catalog?.items[0].images[0].thumb).toBe('new')
  })

  it('different cached root clears catalog and rescans', async () => {
    const { m, d } = await fresh()
    mem.set('catalog', cached({ rootId: 'old' }))
    wire(d, fixture(1))
    await m.openCatalog('root')
    expect(m.getCatalog().catalog?.rootId).toBe('root')
    expect(d.listFiles).toHaveBeenCalledTimes(3)
  })

  it('rescan always scans and saves', async () => {
    const { m, d } = await fresh()
    wire(d, fixture(2))
    await m.openCatalog('root')
    vi.mocked(d.listFiles).mockClear()
    await m.rescan()
    expect(d.listFiles).toHaveBeenCalledTimes(3)
    expect(mem.get('catalog')).toBe(m.getCatalog().catalog)
  })
})
