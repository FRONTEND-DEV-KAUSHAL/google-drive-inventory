import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError, createFolder, getFile, listFiles } from './drive'
import { chooseInventory, resolveInventory } from './inventory'

vi.mock('./drive', async (orig) => ({
  ...(await orig<typeof import('./drive')>()),
  listFiles: vi.fn(),
  getFile: vi.fn(),
  createFolder: vi.fn(),
}))

const store = new Map<string, string>()
const list = vi.mocked(listFiles)
const get = vi.mocked(getFile)
const create = vi.mocked(createFolder)

beforeEach(() => {
  store.clear()
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

describe('resolveInventory', () => {
  it('creates when none exist', async () => {
    list.mockResolvedValue([])
    create.mockResolvedValue({ id: 'new', name: 'Inventory' })
    expect(await resolveInventory()).toEqual({ id: 'new' })
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith('Inventory', 'root')
    expect(store.get('inventoryRootId')).toBe('new')
  })

  it('uses the single existing folder', async () => {
    list.mockResolvedValue([{ id: 'a', name: 'Inventory' }])
    expect(await resolveInventory()).toEqual({ id: 'a' })
    expect(create).not.toHaveBeenCalled()
    expect(store.get('inventoryRootId')).toBe('a')
  })

  it('returns choices oldest first when several exist', async () => {
    const n = { id: 'new', name: 'Inventory', createdTime: '2025-01-01' }
    const o = { id: 'old', name: 'Inventory', createdTime: '2024-01-01' }
    list.mockResolvedValue([n, o])
    expect(await resolveInventory()).toEqual({ choices: [o, n] })
    expect(create).not.toHaveBeenCalled()
    expect(store.has('inventoryRootId')).toBe(false)
  })

  it('fast path with saved id', async () => {
    store.set('inventoryRootId', 's')
    get.mockResolvedValue({ id: 's', name: '', trashed: false })
    expect(await resolveInventory()).toEqual({ id: 's' })
    expect(list).not.toHaveBeenCalled()
  })

  it('drops a trashed saved id and lists', async () => {
    store.set('inventoryRootId', 's')
    get.mockResolvedValue({ id: 's', name: '', trashed: true })
    list.mockResolvedValue([])
    create.mockResolvedValue({ id: 'new', name: 'Inventory' })
    expect(await resolveInventory()).toEqual({ id: 'new' })
    expect(list).toHaveBeenCalled()
  })

  it('drops a saved id that 404s and lists', async () => {
    store.set('inventoryRootId', 's')
    get.mockRejectedValue(new DriveError(404, 'notFound', 'nf'))
    list.mockResolvedValue([{ id: 'a', name: 'Inventory' }])
    expect(await resolveInventory()).toEqual({ id: 'a' })
    expect(store.get('inventoryRootId')).toBe('a')
  })

  it('dedupes concurrent calls', async () => {
    list.mockResolvedValue([])
    create.mockResolvedValue({ id: 'new', name: 'Inventory' })
    const [a, b] = await Promise.all([resolveInventory(), resolveInventory()])
    expect(create).toHaveBeenCalledOnce()
    expect(a).toEqual({ id: 'new' })
    expect(b).toEqual({ id: 'new' })
  })
})

describe('chooseInventory', () => {
  it('saves the id', () => {
    chooseInventory('x')
    expect(store.get('inventoryRootId')).toBe('x')
  })
})
