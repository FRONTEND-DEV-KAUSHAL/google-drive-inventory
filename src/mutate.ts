import { FOLDER_MIME, createFolder, createJsonFile, getContent, listFiles, trash, updateFile, writeJsonFile, type DriveFile } from './drive'
import { SLUG, applyLocal, byName, getCatalog, parseDetails, type Catalog, type Details, type Item } from './catalog'

export const DIM_UNITS = ['cm', 'in'] as const
export const WEIGHT_UNITS = ['kg', 'g', 'lb'] as const
export type ItemInput = { name: string; length: string; width: string; height: string; dimension_unit: string; weight: string; weight_unit: string }
export type FieldErrors = Partial<Record<keyof ItemInput, string>>
type Dims = Omit<Details, 'image_src'>
const NUMS = ['length', 'width', 'height', 'weight'] as const

export function categoryNameError(name: string, categories: { id: string; name: string }[], exceptId?: string): string | null {
  const n = name.trim()
  if (!n) return 'Name is required'
  if (n.length > 100) return 'Name is too long (max 100)'
  const c = categories.find((c) => c.id !== exceptId && c.name.trim().toLowerCase() === n.toLowerCase())
  return c ? `A category named "${c.name}" already exists` : null
}

const nameTaken = (items: Item[], categoryId: string, name: string, exceptId?: string) =>
  items.some((i) => i.categoryId === categoryId && i.id !== exceptId && i.name.toLowerCase() === name.toLowerCase())

export function itemNameError(name: string, items: Item[], categoryId: string, exceptId?: string): string | null {
  if (!SLUG.test(name)) return 'Use lowercase letters, numbers and single hyphens, e.g. red-mug'
  return nameTaken(items, categoryId, name, exceptId) ? `An item named "${name}" already exists in this category` : null
}

export function validateItem(input: ItemInput, items: Item[], categoryId: string, exceptId?: string): { errors: FieldErrors; dims?: Dims } {
  const errors: FieldErrors = {}
  const nameErr = itemNameError(input.name.trim(), items, categoryId, exceptId)
  if (nameErr) errors.name = nameErr
  const v: Record<string, number> = {}
  for (const k of NUMS) {
    const s = input[k].trim()
    v[k] = Number(s)
    if (!(s !== '' && Number.isFinite(v[k]) && v[k] > 0)) errors[k] = 'Must be a positive number'
  }
  if (!(DIM_UNITS as readonly string[]).includes(input.dimension_unit)) errors.dimension_unit = 'Must be one of cm, in'
  if (!(WEIGHT_UNITS as readonly string[]).includes(input.weight_unit)) errors.weight_unit = 'Must be one of kg, g, lb'
  if (Object.keys(errors).length) return { errors }
  return { errors, dims: { length: v.length, width: v.width, height: v.height, dimension_unit: input.dimension_unit, weight: v.weight, weight_unit: input.weight_unit } }
}

export function toInput(item?: Item): ItemInput {
  const d = item?.details
  const s = (v: unknown) => String(v ?? '')
  return {
    name: item?.name ?? '',
    length: s(d?.length), width: s(d?.width), height: s(d?.height),
    dimension_unit: d?.dimension_unit ?? 'cm',
    weight: s(d?.weight),
    weight_unit: d?.weight_unit ?? 'kg',
  }
}

const cat = (): Catalog => {
  const c = getCatalog().catalog
  if (!c) throw new Error('Inventory not loaded')
  return c
}
// Per-parent mutex: ops on the same parent run one after another; each re-validates inside the lock.
// ponytail: settled promises stay in the map; fine for a single-user tab.
const locks = new Map<string, Promise<unknown>>()
export function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  locks.set(key, p)
  return p
}
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
// Drive allows duplicate names: after create, if an earlier same-name folder exists in the parent, trash ours.
// Winner = earliest createdTime, ties broken by smallest id, so exactly one survives.
async function keepOldest(created: DriveFile, parentId: string) {
  const same = await listFiles(`'${parentId}' in parents and name='${q(created.name)}' and mimeType='${FOLDER_MIME}'`, 'files(id,createdTime)')
  const key = (f: DriveFile) => [f.createdTime ?? '', f.id] as const
  const [ct, ci] = key(created)
  if (same.some((f) => f.id !== created.id && (key(f)[0] < ct || (key(f)[0] === ct && f.id < ci)))) {
    await trash(created.id)
    throw new Error(`"${created.name}" already exists in Drive. Use Rescan to see it.`)
  }
}
const fail = (msg: string | null) => {
  if (msg) throw new Error(msg)
}

export async function createCategory(name: string) {
  return locked(cat().rootId, async () => {
    const c = cat()
    fail(categoryNameError(name, c.categories))
    const f = await createFolder(name.trim(), c.rootId)
    await keepOldest(f, c.rootId)
    const out = { id: f.id, name: f.name }
    await applyLocal((x) => ({ ...x, categories: [...x.categories, out].sort(byName) }))
    return out
  })
}

export async function renameCategory(id: string, name: string) {
  return locked(cat().rootId, async () => {
    fail(categoryNameError(name, cat().categories, id))
    const n = name.trim()
    await updateFile(id, { name: n })
    await applyLocal((x) => ({ ...x, categories: x.categories.map((c) => (c.id === id ? { ...c, name: n } : c)).sort(byName) }))
  })
}

export async function deleteCategory(id: string) {
  await trash(id)
  await applyLocal((x) => ({ ...x, categories: x.categories.filter((c) => c.id !== id), items: x.items.filter((i) => i.categoryId !== id) }))
}

export async function createItem(categoryId: string, input: ItemInput) {
  return locked(categoryId, async () => {
    const { errors, dims } = validateItem(input, cat().items, categoryId)
    fail(Object.values(errors)[0] ?? null)
    const d0 = dims!
    const f = await createFolder(input.name.trim(), categoryId)
    await keepOldest(f, categoryId)
    const details: Details = { height: d0.height, width: d0.width, length: d0.length, dimension_unit: d0.dimension_unit, weight: d0.weight, weight_unit: d0.weight_unit, image_src: [] }
    let d: DriveFile
    try {
      d = await createJsonFile('details.json', f.id, details)
    } catch (e) {
      await trash(f.id).catch(() => {}) // rollback: no half-created item
      throw e
    }
    const item: Item = { id: f.id, name: f.name, categoryId, detailsId: d.id, detailsModified: d.modifiedTime, details, images: [], issues: [] }
    await applyLocal((x) => ({ ...x, items: [...x.items, item].sort(byName) }))
    return item
  })
}

export async function updateItem(id: string, input: ItemInput, categoryId: string) {
  return locked(categoryId, async () => {
    const item = cat().items.find((i) => i.id === id)
    if (!item) throw new Error('Item not found')
    const name = input.name.trim()
    const sameName = name === item.name // may be a hand-made non-slug name: don't re-validate it
    const moving = categoryId !== item.categoryId
    const { errors, dims } = validateItem({ ...input, name: sameName ? 'x' : name }, sameName ? [] : cat().items, categoryId, id)
    fail(Object.values(errors)[0] ?? null)
    if (sameName && moving && nameTaken(cat().items, categoryId, name, id)) fail(`An item named "${name}" already exists in this category`)
    const dm = dims!
    const old = item.details
    const changedDims = !item.detailsId || NUMS.some((k) => Number(old?.[k]) !== dm[k]) || old?.dimension_unit !== dm.dimension_unit || old?.weight_unit !== dm.weight_unit
    const renamed = !sameName
    if (!renamed && !moving && !changedDims) return

    if (renamed || moving) {
      await updateFile(id, {
        name: renamed ? name : undefined,
        addParents: moving ? categoryId : undefined,
        removeParents: moving ? item.categoryId : undefined,
      })
    }
    let { detailsId, detailsModified, details } = item
    if (changedDims) {
      let next: Record<string, unknown>
      let d: DriveFile
      if (item.detailsId) {
        const raw = await getContent(item.detailsId).catch(() => ({}))
        const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
        const image_src = parseDetails(raw).details?.image_src ?? item.details?.image_src ?? []
        next = { ...base, ...dm, image_src }
        d = await writeJsonFile(item.detailsId, next)
      } else {
        next = { ...dm, image_src: item.details?.image_src ?? [] }
        d = await createJsonFile('details.json', id, next)
      }
      detailsId = d.id
      detailsModified = d.modifiedTime
      details = parseDetails(next).details
    }
    await applyLocal((x) => ({
      ...x,
      items: x.items
        .map((i) =>
          i.id !== id ? i : {
            ...item, name, categoryId, detailsId, detailsModified, details,
            issues: item.issues.filter((s) => !(s === 'bad-name' && SLUG.test(name)) && !(changedDims && (s === 'missing-details' || s === 'malformed-details' || s === 'details-unreadable'))),
          },
        )
        .sort(byName),
    }))
  })
}

export async function deleteItem(id: string) {
  await trash(id)
  await applyLocal((x) => ({ ...x, items: x.items.filter((i) => i.id !== id) }))
}
