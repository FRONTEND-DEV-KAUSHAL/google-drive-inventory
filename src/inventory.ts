import { DriveError, FOLDER_MIME, createFolder, getFile, listFiles, type DriveFile } from './drive'

const KEY = 'inventoryRootId'

export type InventoryResult = { id: string } | { choices: DriveFile[] }

async function run(): Promise<InventoryResult> {
  const saved = localStorage.getItem(KEY)
  if (saved) {
    try {
      const f = await getFile(saved, 'id,trashed')
      if (!f.trashed) return { id: saved }
    } catch (e) {
      if (!(e instanceof DriveError && e.status === 404)) throw e
    }
    localStorage.removeItem(KEY)
  }

  const found = await listFiles(
    `name='Inventory' and mimeType='${FOLDER_MIME}' and 'root' in parents`,
    'files(id,name,createdTime)',
  )
  found.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))
  if (found.length > 1) return { choices: found }

  const id = found.length ? found[0].id : (await createFolder('Inventory', 'root')).id
  localStorage.setItem(KEY, id)
  return { id }
}

// Dedupes StrictMode double effects / double clicks so we never create two folders.
let inflight: Promise<InventoryResult> | null = null
export const resolveInventory = () =>
  (inflight ??= run().finally(() => {
    inflight = null
  }))

export const chooseInventory = (id: string) => localStorage.setItem(KEY, id)
