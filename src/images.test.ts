import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Catalog } from './catalog'

vi.mock('./drive', async (orig) => ({
  ...(await orig<typeof import('./drive')>()),
  startUpload: vi.fn(), putUpload: vi.fn(), shareAnyone: vi.fn(), getContent: vi.fn(),
  writeJsonFile: vi.fn(), createJsonFile: vi.fn(), trash: vi.fn(),
}))
let current: Catalog
vi.mock('./catalog', async (orig) => ({
  ...(await orig<typeof import('./catalog')>()),
  getCatalog: vi.fn(() => ({ catalog: current, busy: null, error: null })),
  applyLocal: vi.fn(async (fn: (c: Catalog) => Catalog) => { current = fn(current) }),
}))

import * as d from './drive'
import * as im from './images'

const f = (n: string, type = 'image/jpeg', body = 'xx') => new File([body], n, { type })
let file: Record<string, unknown>
const ids = (i = 0) => current.items[i].images.map((m) => m.id)
const written = () => vi.mocked(d.writeJsonFile).mock.calls.map((c) => (c[1] as { image_src: string[] }).image_src)

beforeEach(() => {
  vi.resetAllMocks()
  file = { length: 1, width: 2, height: 3, dimension_unit: 'cm', weight: 1, weight_unit: 'kg', image_src: ['https://drive.google.com/uc?export=view&id=a'], note: 'keep' }
  current = {
    v: 1, rootId: 'root', changesToken: 't', builtAt: 0, thumbsAt: 0,
    categories: [{ id: 'c1', name: 'kitchen' }],
    items: [
      { id: 'i1', name: 'red-mug', categoryId: 'c1', detailsId: 'd1', details: { length: 1, width: 2, height: 3, dimension_unit: 'cm', weight: 1, weight_unit: 'kg', image_src: ['a'] }, images: [{ id: 'a', name: 'a.jpg' }, { id: 'b', name: 'b.jpg' }], issues: [] },
      { id: 'i2', name: 'blue-mug', categoryId: 'c1', images: [], issues: ['missing-details'] },
    ],
  }
  vi.mocked(d.getContent).mockImplementation(async () => file)
  vi.mocked(d.writeJsonFile).mockImplementation(async (_id, data) => { file = data as typeof file; return { id: 'd1', name: 'details.json', modifiedTime: 'm' } })
  vi.mocked(d.createJsonFile).mockResolvedValue({ id: 'dnew', name: 'details.json', modifiedTime: 'm' })
  vi.mocked(d.startUpload).mockImplementation(async (x) => 's-' + x.name)
  vi.mocked(d.putUpload).mockImplementation(async (_s, x) => ({ id: 'f-' + (x as File).name, name: (x as File).name }))
  vi.mocked(d.shareAnyone).mockResolvedValue({ id: 'perm' })
  vi.mocked(d.trash).mockResolvedValue({ id: 'x', name: '' })
})

describe('images', () => {
  it('imageUrl', () => {
    expect(im.imageUrl('x', 'thumb')).toBe('https://lh3.googleusercontent.com/d/x=s220')
    expect(im.imageUrl('x', 'view')).toBe('https://lh3.googleusercontent.com/d/x=s1600')
    expect(im.imageUrl('x', 'export')).toBe('https://lh3.googleusercontent.com/d/x')
  })
  it('uploads, shares, writes once, normalises ids', async () => {
    const jobs = im.newJobs([f('p1.jpg'), f('p2.jpg')])
    const onChange = vi.fn()
    await im.runUploads('i1', jobs, onChange)
    expect(d.startUpload).toHaveBeenCalledTimes(2)
    expect(vi.mocked(d.putUpload).mock.calls.every((c) => c[3] === false)).toBe(true)
    expect(vi.mocked(d.shareAnyone).mock.calls.map((c) => c[0]).sort()).toEqual(['f-p1.jpg', 'f-p2.jpg'])
    expect(d.writeJsonFile).toHaveBeenCalledTimes(1)
    expect(d.writeJsonFile).toHaveBeenCalledWith('d1', expect.objectContaining({ note: 'keep', length: 1, image_src: ['a', 'f-p1.jpg', 'f-p2.jpg'] }))
    expect(jobs.map((j) => j.status)).toEqual(['done', 'done'])
    expect(jobs.every((j) => j.listed)).toBe(true)
    expect(ids()).toEqual(['a', 'f-p1.jpg', 'f-p2.jpg', 'b'])
    expect(ids()).toEqual(expect.arrayContaining(['a', 'f-p1.jpg', 'f-p2.jpg']))
    expect(onChange).toHaveBeenCalled()
  })
  it('failed file retried without duplicates', async () => {
    const jobs = im.newJobs([f('p1.jpg'), f('p2.jpg')])
    vi.mocked(d.putUpload).mockImplementationOnce(async (_s, x) => ({ id: 'f-' + (x as File).name, name: '' }))
      .mockRejectedValueOnce(new d.DriveError(503, '', 'down'))
    await im.runUploads('i1', jobs, () => {})
    expect(jobs.map((j) => j.status)).toEqual(['done', 'error'])
    expect(jobs[1].error).toBe('down')
    expect(written()).toEqual([['a', 'f-p1.jpg']])
    await im.runUploads('i1', jobs, () => {})
    expect(d.startUpload).toHaveBeenCalledTimes(2)
    expect(d.putUpload).toHaveBeenCalledTimes(3)
    expect(vi.mocked(d.putUpload).mock.calls[2][3]).toBe(true)
    expect(written()[1]).toEqual(['a', 'f-p1.jpg', 'f-p2.jpg'])
  })
  it('404 clears session', async () => {
    const jobs = im.newJobs([f('p1.jpg')])
    vi.mocked(d.putUpload).mockRejectedValueOnce(new d.DriveError(404, '', 'gone'))
    await im.runUploads('i1', jobs, () => {})
    expect(jobs[0].session).toBeUndefined()
    await im.runUploads('i1', jobs, () => {})
    expect(d.startUpload).toHaveBeenCalledTimes(2)
    expect(jobs[0].status).toBe('done')
  })
  it('share failure retried without re-upload', async () => {
    const jobs = im.newJobs([f('p1.jpg')])
    vi.mocked(d.shareAnyone).mockRejectedValueOnce(new Error('blocked'))
    await im.runUploads('i1', jobs, () => {})
    expect(jobs[0].status).toBe('error')
    expect(d.writeJsonFile).not.toHaveBeenCalled()
    await im.runUploads('i1', jobs, () => {})
    expect(d.putUpload).toHaveBeenCalledTimes(1)
    expect(d.shareAnyone).toHaveBeenCalledTimes(2)
    expect(written()).toEqual([['a', 'f-p1.jpg']])
  })
  it('rejects non-image and empty', async () => {
    const jobs = im.newJobs([f('t.txt', 'text/plain'), f('e.jpg', 'image/jpeg', '')])
    await im.runUploads('i1', jobs, () => {})
    expect(jobs.map((j) => j.error)).toEqual(['Not an image', 'Empty file'])
    expect(d.startUpload).not.toHaveBeenCalled()
  })
  it('creates details.json when missing', async () => {
    await im.runUploads('i2', im.newJobs([f('p1.jpg')]), () => {})
    expect(d.createJsonFile).toHaveBeenCalledWith('details.json', 'i2', { image_src: ['f-p1.jpg'] })
    expect(current.items[1].detailsId).toBe('dnew')
    expect(current.items[1].issues).not.toContain('missing-details')
  })
  it('malformed details.json keeps cached dims', async () => {
    vi.mocked(d.getContent).mockRejectedValue(new SyntaxError('bad'))
    await im.runUploads('i1', im.newJobs([f('p1.jpg')]), () => {})
    expect(d.writeJsonFile).toHaveBeenCalledWith('d1', expect.objectContaining({ length: 1, weight_unit: 'kg' }))
  })
  it('moveImage swaps and persists; no-op at edge', async () => {
    file.image_src = ['a']
    await im.moveImage('i1', 'b', -1)
    expect(written()).toEqual([['b', 'a']])
    expect(ids()).toEqual(['b', 'a'])
    await im.moveImage('i1', 'b', -1)
    expect(d.writeJsonFile).toHaveBeenCalledTimes(1)
  })
  it('deleteImage writes then trashes', async () => {
    await im.deleteImage('i1', 'a')
    expect(written()).toEqual([[]])
    expect(vi.mocked(d.writeJsonFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.trash).mock.invocationCallOrder[0])
    expect(d.trash).toHaveBeenCalledWith('a')
    expect(ids()).toEqual(['b'])
  })
  it('only shares image files', async () => {
    await im.runUploads('i1', im.newJobs([f('p1.jpg')]), () => {})
    for (const c of vi.mocked(d.shareAnyone).mock.calls) expect(c[0]).toMatch(/^f-/)
  })
})
