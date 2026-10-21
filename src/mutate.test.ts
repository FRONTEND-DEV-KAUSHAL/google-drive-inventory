import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Catalog } from './catalog'

vi.mock('./drive', async (orig) => ({
  ...(await orig<typeof import('./drive')>()),
  createFolder: vi.fn(), createJsonFile: vi.fn(), writeJsonFile: vi.fn(), getContent: vi.fn(),
  listFiles: vi.fn(), trash: vi.fn(), updateFile: vi.fn(),
}))
let current: Catalog
vi.mock('./catalog', async (orig) => ({
  ...(await orig<typeof import('./catalog')>()),
  getCatalog: vi.fn(() => ({ catalog: current, busy: null, error: null })),
  applyLocal: vi.fn(async (fn: (c: Catalog) => Catalog) => { current = fn(current) }),
}))

import * as d from './drive'
import * as m from './mutate'

const det = { length: 1, width: 1, height: 1, dimension_unit: 'cm', weight: 1, weight_unit: 'kg', image_src: ['img1'] }
const input = (o = {}): m.ItemInput => ({ name: 'blue-mug', length: '2', width: '3', height: '4', dimension_unit: 'cm', weight: '5', weight_unit: 'g', ...o })
const same = () => m.toInput(current.items[0])

beforeEach(() => {
  vi.resetAllMocks()
  current = {
    v: 1, rootId: 'root', changesToken: 't', builtAt: 0, thumbsAt: 0,
    categories: [{ id: 'c1', name: 'kitchen' }, { id: 'c2', name: 'garden' }],
    items: [{ id: 'i1', name: 'red-mug', categoryId: 'c1', detailsId: 'd1', details: det, images: [], issues: [] }],
  }
  vi.mocked(d.createFolder).mockImplementation(async (name) => ({ id: 'new', name, createdTime: '2026-01-02' }))
  vi.mocked(d.listFiles).mockResolvedValue([])
  vi.mocked(d.trash).mockResolvedValue({ id: 'x', name: '' })
  vi.mocked(d.createJsonFile).mockResolvedValue({ id: 'dnew', name: 'details.json', modifiedTime: 'm' })
  vi.mocked(d.writeJsonFile).mockResolvedValue({ id: 'd1', name: 'details.json', modifiedTime: 'm2' })
  vi.mocked(d.getContent).mockResolvedValue({ ...det, image_src: ['img1', 'img2'], note: 'keep' })
})

describe('validation', () => {
  it('categoryNameError', () => {
    const cs = [{ id: 'a', name: 'kitchen' }]
    expect(m.categoryNameError('  Kitchen ', cs)).toBe('A category named "kitchen" already exists')
    expect(m.categoryNameError('Kitchen', cs, 'a')).toBeNull()
    expect(m.categoryNameError('   ', cs)).toBe('Name is required')
    expect(m.categoryNameError('x'.repeat(101), cs)).toBe('Name is too long (max 100)')
  })
  it('itemNameError', () => {
    const items = current.items
    expect(m.itemNameError('Red Mug', items, 'c1')).toMatch(/lowercase/)
    expect(m.itemNameError('red-mug', items, 'c1')).toBe('An item named "red-mug" already exists in this category')
    expect(m.itemNameError('red-mug', items, 'c2')).toBeNull()
    expect(m.itemNameError('red-mug', items, 'c1', 'i1')).toBeNull()
  })
  it('validateItem', () => {
    for (const bad of ['0', '-1', 'abc', '']) expect(m.validateItem(input({ length: bad }), [], 'c1').errors.length).toBe('Must be a positive number')
    expect(m.validateItem(input({ dimension_unit: 'mm' }), [], 'c1').errors.dimension_unit).toBe('Must be one of cm, in')
    expect(m.validateItem(input({ weight_unit: 'oz' }), [], 'c1').errors.weight_unit).toBe('Must be one of kg, g, lb')
    expect(m.validateItem(input(), [], 'c1')).toEqual({ errors: {}, dims: { length: 2, width: 3, height: 4, dimension_unit: 'cm', weight: 5, weight_unit: 'g' } })
  })
})

describe('categories', () => {
  it('rejects duplicate without Drive call', async () => {
    await expect(m.createCategory('Kitchen')).rejects.toThrow(/already exists/)
    expect(d.createFolder).not.toHaveBeenCalled()
  })
  it('creates and sorts', async () => {
    await m.createCategory('Bath')
    expect(d.createFolder).toHaveBeenCalledWith('Bath', 'root')
    expect(current.categories.map((c) => c.name)).toEqual(['Bath', 'garden', 'kitchen'])
  })
  it('trashes itself when an older duplicate exists', async () => {
    vi.mocked(d.listFiles).mockResolvedValue([{ id: 'old', name: 'Garden2', createdTime: '2026-01-01' }])
    await expect(m.createCategory('Garden2')).rejects.toThrow()
    expect(d.trash).toHaveBeenCalledWith('new')
    expect(current.categories).toHaveLength(2)
  })
  it('same-timestamp tie: smaller id wins, only one trashed', async () => {
    vi.mocked(d.listFiles).mockResolvedValue([{ id: 'aaa', name: 'G', createdTime: '2026-01-02' }])
    await expect(m.createCategory('G')).rejects.toThrow() // 'new' > 'aaa' -> ours loses
    vi.mocked(d.listFiles).mockResolvedValue([{ id: 'zzz', name: 'H', createdTime: '2026-01-02' }])
    await expect(m.createCategory('H')).resolves.toBeTruthy() // ours wins
  })
  it('serialises concurrent creates', async () => {
    const r = await Promise.allSettled([m.createCategory('Garden2'), m.createCategory('garden2')])
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'rejected'])
    expect(d.createFolder).toHaveBeenCalledTimes(1)
  })
  it('renames', async () => {
    await m.renameCategory('c1', 'Zed')
    expect(d.updateFile).toHaveBeenCalledWith('c1', { name: 'Zed' })
    expect(current.categories.map((c) => c.name)).toEqual(['garden', 'Zed'])
  })
  it('delete trashes and drops items', async () => {
    await m.deleteCategory('c1')
    expect(d.trash).toHaveBeenCalledWith('c1')
    expect(current.categories.map((c) => c.id)).toEqual(['c2'])
    expect(current.items).toEqual([])
  })
})

describe('items', () => {
  it('rejects invalid before Drive', async () => {
    await expect(m.createItem('c1', input({ name: 'Bad Name' }))).rejects.toThrow()
    await expect(m.createItem('c1', input({ name: 'red-mug' }))).rejects.toThrow(/already exists/)
    await expect(m.createItem('c1', input({ weight: '0' }))).rejects.toThrow()
    expect(d.createFolder).not.toHaveBeenCalled()
  })
  it('creates folder then details.json', async () => {
    const it = await m.createItem('c1', input())
    expect(d.createFolder).toHaveBeenCalledWith('blue-mug', 'c1')
    const call = vi.mocked(d.createJsonFile).mock.calls[0]
    expect(call.slice(0, 2)).toEqual(['details.json', 'new'])
    expect(Object.keys(call[2] as object)).toEqual(['height', 'width', 'length', 'dimension_unit', 'weight', 'weight_unit', 'image_src'])
    expect(it).toMatchObject({ detailsId: 'dnew', images: [], issues: [] })
    expect(current.items.map((i) => i.id)).toContain('new')
  })
  it('rolls back when details.json fails', async () => {
    vi.mocked(d.createJsonFile).mockRejectedValue(new Error('boom'))
    await expect(m.createItem('c1', input())).rejects.toThrow('boom')
    expect(d.trash).toHaveBeenCalledWith('new')
    expect(current.items).toHaveLength(1)
  })
  it('rename+move is one PATCH', async () => {
    current.items[0].issues = ['bad-name']
    await m.updateItem('i1', { ...same(), name: 'new-name' }, 'c2')
    expect(d.updateFile).toHaveBeenCalledTimes(1)
    expect(d.updateFile).toHaveBeenCalledWith('i1', { name: 'new-name', addParents: 'c2', removeParents: 'c1' })
    expect(current.items[0]).toMatchObject({ categoryId: 'c2', name: 'new-name', issues: [] })
    expect(d.writeJsonFile).not.toHaveBeenCalled()
  })
  it('move checks uniqueness in target', async () => {
    current.items.push({ id: 'i2', name: 'red-mug', categoryId: 'c2', images: [], issues: [] })
    await expect(m.updateItem('i1', same(), 'c2')).rejects.toThrow(/already exists/)
    expect(d.updateFile).not.toHaveBeenCalled()
  })
  it('details change merges and keeps image_src', async () => {
    await m.updateItem('i1', { ...same(), weight: '9' }, 'c1')
    expect(d.updateFile).not.toHaveBeenCalled()
    expect(d.writeJsonFile).toHaveBeenCalledWith('d1', expect.objectContaining({ note: 'keep', image_src: ['img1', 'img2'], weight: 9 }))
    expect(current.items[0].details?.weight).toBe(9)
  })
  it('creates details.json when missing', async () => {
    current.items[0] = { ...current.items[0], detailsId: undefined, details: undefined, issues: ['missing-details'] }
    await m.updateItem('i1', input({ name: 'red-mug' }), 'c1')
    expect(d.createJsonFile).toHaveBeenCalledWith('details.json', 'i1', expect.anything())
    expect(d.writeJsonFile).not.toHaveBeenCalled()
    expect(current.items[0].issues).toEqual([])
  })
  it('unchanged form makes no Drive calls', async () => {
    await m.updateItem('i1', same(), 'c1')
    expect(vi.mocked(d.updateFile).mock.calls.length + vi.mocked(d.writeJsonFile).mock.calls.length + vi.mocked(d.getContent).mock.calls.length).toBe(0)
  })
  it('deleteItem trashes and drops', async () => {
    await m.deleteItem('i1')
    expect(d.trash).toHaveBeenCalledWith('i1')
    expect(current.items).toEqual([])
  })
})
