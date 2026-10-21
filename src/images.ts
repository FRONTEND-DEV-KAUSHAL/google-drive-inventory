import { createJsonFile, DriveError, getBlob, getContent, putUpload, shareAnyone, startUpload, trash, writeJsonFile } from './drive'
import { applyLocal, getCatalog, parseDetails, pool, srcId, type Image, type Item } from './catalog'
import { locked } from './mutate'

// The ONE public-URL formatter (Phase 6 export uses 'export'). lh3 form is unofficial: verify unauthenticated, change here only.
const PUBLIC = (id: string) => `https://lh3.googleusercontent.com/d/${id}`
export const imageUrl = (id: string, purpose: 'thumb' | 'view' | 'export') =>
  purpose === 'thumb' ? `${PUBLIC(id)}=s220` : purpose === 'view' ? `${PUBLIC(id)}=s1600` : PUBLIC(id)

// Signed-in fallback when the public URL fails (unshared file, not yet propagated, cookie-blocking browsers).
// ponytail: full-size download, cached for the session and never revoked; fine for a personal app.
const blobs = new Map<string, Promise<string>>()
export const imageBlobUrl = (id: string) => {
  let p = blobs.get(id)
  if (!p) {
    p = getBlob(id).then((b) => URL.createObjectURL(b))
    p.catch(() => blobs.delete(id))
    blobs.set(id, p)
  }
  return p
}

export type UploadJob = {
  file: File
  status: 'queued' | 'uploading' | 'sharing' | 'done' | 'error'
  sent: number // bytes sent, for <progress max={file.size}>
  error?: string
  session?: string // resumable session URI; reused on retry
  fileId?: string // set once Drive has the file; never re-uploaded after this
  shared?: boolean
  listed?: boolean // in image_src
}
export const newJobs = (files: Iterable<File> | ArrayLike<File>): UploadJob[] =>
  Array.from(files, (file) => ({ file, status: 'queued' as const, sent: 0 }))

const findItem = (id: string): Item => {
  const it = getCatalog().catalog?.items.find((i) => i.id === id)
  if (!it) throw new Error('Item not found')
  return it
}
const msg = (e: unknown) => String((e as Error)?.message ?? e)

// Same ordering rule as catalog.assemble: listed ids first by index, unlisted keep their place after.
const sortByIds = (imgs: Image[], ids: string[]) => {
  const k = (m: Image) => { const i = ids.indexOf(m.id); return i < 0 ? Infinity : i }
  return [...imgs].sort((a, b) => k(a) - k(b))
}

async function setImageSrc(itemId: string, fn: (ids: string[]) => string[], images: (cur: Image[]) => Image[] = (c) => c) {
  const item = findItem(itemId)
  return locked(item.categoryId, async () => {
    const it = findItem(itemId)
    const raw: unknown = it.detailsId
      ? await getContent(it.detailsId).catch((e) => {
          if (e instanceof SyntaxError) return it.details ?? {} // malformed: keep cached dims
          throw e // network errors never overwrite blindly
        })
      : {}
    const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const cur = (parseDetails(raw).details?.image_src ?? []).map(srcId)
    const ids = fn(cur)
    const next = { ...base, image_src: ids }
    const d = it.detailsId ? await writeJsonFile(it.detailsId, next) : await createJsonFile('details.json', itemId, next)
    await applyLocal((c) => ({
      ...c,
      items: c.items.map((x) =>
        x.id !== itemId
          ? x
          : {
              ...x,
              detailsId: d.id,
              detailsModified: d.modifiedTime,
              details: parseDetails(next).details,
              issues: x.issues.filter((s) => s !== 'missing-details'),
              images: sortByIds(images(x.images), ids),
            },
      ),
    }))
  })
}

export async function runUploads(itemId: string, jobs: UploadJob[], onChange: () => void) {
  findItem(itemId)
  await pool(jobs.filter((j) => j.status !== 'done'), 2, async (j) => {
    try {
      if (!j.file.type.startsWith('image/')) throw new Error('Not an image')
      if (j.file.size === 0) throw new Error('Empty file')
      if (!j.fileId) {
        j.status = 'uploading'
        onChange()
        const resume = !!j.session
        j.session ??= await startUpload(j.file, itemId)
        try {
          j.fileId = (await putUpload(j.session, j.file, (n) => { j.sent = n; onChange() }, resume)).id
          j.sent = j.file.size
        } catch (e) {
          if (e instanceof DriveError && (e.status === 404 || e.status === 410)) j.session = undefined
          throw e
        }
      }
      if (!j.shared) {
        j.status = 'sharing'
        onChange()
        await shareAnyone(j.fileId)
        j.shared = true
      }
      j.status = 'done'
      j.error = undefined
    } catch (e) {
      j.status = 'error'
      j.error = msg(e)
    } finally {
      onChange()
    }
  })
  const fresh = jobs.filter((j) => j.status === 'done' && !j.listed)
  if (!fresh.length) return
  await setImageSrc(
    itemId,
    (ids) => [...ids, ...fresh.map((j) => j.fileId!).filter((id) => !ids.includes(id))],
    (cur) => [...cur.filter((m) => !fresh.some((j) => j.fileId === m.id)), ...fresh.map((j) => ({ id: j.fileId!, name: j.file.name }))],
  )
  fresh.forEach((j) => (j.listed = true))
  onChange()
}

export async function moveImage(itemId: string, fileId: string, dir: -1 | 1) {
  const order = findItem(itemId).images.map((m) => m.id)
  const i = order.indexOf(fileId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return
  ;[order[i], order[j]] = [order[j], order[i]]
  await setImageSrc(itemId, (ids) => [...order, ...ids.filter((x) => !order.includes(x))])
}

export async function deleteImage(itemId: string, fileId: string) {
  await setImageSrc(itemId, (ids) => ids.filter((x) => x !== fileId), (cur) => cur.filter((m) => m.id !== fileId))
  await trash(fileId)
}
