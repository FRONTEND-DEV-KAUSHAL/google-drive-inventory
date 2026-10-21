import { memo, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { filterItems, getCatalog, openCatalog, rescan, subscribe } from './catalog'
import type { Catalog, Image, Issue, Item } from './catalog'
import Gallery, { Img } from './Gallery'
import ItemForm from './ItemForm'
import { AlertTriangle, ArrowLeft, ExternalLink, FolderPlus, ImageOff, Layers, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { categoryNameError, createCategory, deleteCategory, deleteItem, renameCategory } from './mutate'
import { ask } from './ui'

const ISSUE_TEXT: Record<Issue, string> = {
  'bad-name': 'Folder name is not a lowercase-kebab slug',
  'missing-details': 'No details.json',
  'malformed-details': 'details.json is malformed',
  'details-unreadable': 'details.json could not be read',
}

const subHash = (f: () => void) => {
  addEventListener('hashchange', f)
  return () => removeEventListener('hashchange', f)
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function Thumb({ img }: { img?: Image }) {
  return (
    <div className="media">
      {img ? <Img key={img.id} img={img} purpose="thumb" /> : <ImageOff className="media-empty" size={28} aria-label="No image" />}
    </div>
  )
}

// memo: scan progress ticks re-render Browse; the grid only re-renders when its items change.
const Grid = memo(function Grid({ items }: { items: Item[] }) {
  return (
    <ul className="grid">
      {items.map((it) => (
        <li key={it.id}>
          <a className="card" href={`#/i/${it.id}`}>
            <Thumb img={it.images[0]} />
            <span className="card-body">
              <span className="card-title">{it.name}</span>
              <small>{plural(it.images.length, 'photo')}</small>
            </span>
            {it.issues.length > 0 && (
              <span className="flag" title={it.issues.map((i) => ISSUE_TEXT[i]).join(', ')}>
                <AlertTriangle size={12} aria-label="Has issues" />
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  )
})

export const GridSkeleton = ({ n = 12 }: { n?: number }) => (
  <ul className="grid" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => (
      <li key={i}>
        <div className="card">
          <div className="media skel" />
          <span className="card-body">
            <span className="skel line" />
            <span className="skel line short" />
          </span>
        </div>
      </li>
    ))}
  </ul>
)

// Shown while auth, folder lookup, or first scan is in progress: same layout as the real page, no jump.
export function ShellSkeleton({ status }: { status?: string }) {
  return (
    <div className="layout" aria-busy="true">
      <aside className="sidebar">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="skel nav-skel" />
        ))}
      </aside>
      <main>
        <div className="page-head">
          <span className="skel title-skel" />
        </div>
        {status && <p className="status-line">{status}</p>}
        <GridSkeleton />
      </main>
    </div>
  )
}

function Sidebar({ catalog, categoryId, counts, busy, footer }: { catalog: Catalog; categoryId?: string; counts: Map<string, number>; busy: boolean; footer: ReactNode }) {
  return (
    <aside className="sidebar">
      <nav aria-label="Categories">
        <a href="#/" className={categoryId ? '' : 'active'}>
          <Layers size={16} /> <span className="nav-label">All items</span> <span className="count">{catalog.items.length}</span>
        </a>
        {catalog.categories.map((c) => (
          <a key={c.id} href={`#/c/${c.id}`} className={c.id === categoryId ? 'active' : ''}>
            <span className="nav-label">{c.name}</span> <span className="count">{counts.get(c.id) ?? 0}</span>
          </a>
        ))}
      </nav>
      <button
        className="ghost new-cat"
        disabled={busy}
        onClick={() =>
          ask({
            title: 'New category',
            input: '',
            placeholder: 'e.g. Kitchen',
            confirm: 'Create',
            validate: (n) => categoryNameError(n, getCatalog().catalog?.categories ?? []),
            run: async (n) => {
              const c = await createCategory(n)
              location.hash = `#/c/${c.id}`
            },
            done: 'Category created',
          })
        }
      >
        <FolderPlus size={16} /> New category
      </button>
      {footer}
    </aside>
  )
}

export default function Browse({ rootId }: { rootId: string }) {
  const { catalog, busy, error } = useSyncExternalStore(subscribe, getCatalog)
  const hash = useSyncExternalStore(subHash, () => location.hash)
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q)
  const [limit, setLimit] = useState(100)
  const [, kind, id] = hash.match(/^#\/(c|i|new|e)\/(.+)$/) ?? []
  const categoryId = kind === 'c' ? id : undefined

  useEffect(() => {
    openCatalog(rootId)
  }, [rootId])
  useEffect(() => setLimit(100), [dq, categoryId])
  useEffect(() => {
    scrollTo({ top: 0 }) // braces: Chrome's scrollTo returns a Promise, not a cleanup fn
  }, [kind, id])

  const filtered = useMemo(() => (catalog ? filterItems(catalog.items, dq, categoryId) : []), [catalog, dq, categoryId])
  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of catalog?.items ?? []) m.set(it.categoryId, (m.get(it.categoryId) ?? 0) + 1)
    return m
  }, [catalog])

  const pct = busy?.total ? Math.round((busy.done / busy.total) * 100) : null
  const progress = busy && (
    <div className="topprogress" role="progressbar" aria-label="Syncing with Drive" aria-valuenow={pct ?? undefined}>
      <span className={pct === null ? 'indeterminate' : ''} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  )
  const syncText = busy ? (busy.total ? `Reading details ${busy.done}/${busy.total}` : 'Listing Drive…') : null

  if (!catalog) {
    return (
      <>
        {progress}
        {error ? (
          <div className="empty">
            <AlertTriangle size={28} />
            <h3>Couldn't load your inventory</h3>
            <p>{error}</p>
            <button className="primary" onClick={() => openCatalog(rootId)}>
              <RefreshCw size={16} /> Try again
            </button>
          </div>
        ) : (
          <ShellSkeleton status={syncText ?? 'Loading inventory…'} />
        )}
      </>
    )
  }

  const statusBar = (
    <div className="syncbar">
      <span className={error ? 'error' : ''} title={`Indexed ${new Date(catalog.builtAt).toLocaleString()}`}>
        {error ?? syncText ?? <>Synced {new Date(catalog.builtAt).toLocaleTimeString([], { timeStyle: 'short' })}</>}
      </span>
      <button className="ghost sm" onClick={() => rescan()} disabled={!!busy} aria-label="Rescan Drive">
        <RefreshCw size={14} className={busy ? 'spin' : ''} /> {error ? 'Retry' : 'Rescan'}
      </button>
    </div>
  )

  let page
  if (kind === 'new' || kind === 'e') {
    const item = kind === 'e' ? catalog.items.find((i) => i.id === id) : undefined
    const cid = kind === 'e' ? item?.categoryId : id
    const ok = kind === 'e' ? !!item : catalog.categories.some((c) => c.id === id)
    page =
      ok && cid ? (
        <ItemForm
          key={id}
          catalog={catalog}
          categoryId={cid}
          item={item}
          onDone={(nid) => (location.hash = nid ? `#/i/${nid}` : item ? `#/i/${item.id}` : `#/c/${id}`)}
        />
      ) : (
        <NotFound what={kind === 'e' ? 'Item' : 'Category'} />
      )
  } else if (kind === 'i') {
    const item = catalog.items.find((i) => i.id === id)
    page = item ? <Detail catalog={catalog} item={item} busy={!!busy} /> : <NotFound what="Item" />
  } else {
    const cat = catalog.categories.find((c) => c.id === categoryId)
    page = (
      <>
        <div className="page-head">
          <div>
            <h2>{cat?.name ?? 'All items'}</h2>
            <small>{plural(filtered.length, 'item')}</small>
          </div>
          {cat && (
            <div className="actions">
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() =>
                  ask({
                    title: 'Rename category',
                    input: cat.name,
                    confirm: 'Rename',
                    validate: (n) => categoryNameError(n, catalog.categories, cat.id),
                    run: (n) => renameCategory(cat.id, n),
                    done: 'Category renamed',
                  })
                }
              >
                <Pencil size={16} /> Rename
              </button>
              <button
                className="ghost danger"
                disabled={!!busy}
                onClick={() => {
                  const n = counts.get(cat.id) ?? 0
                  ask({
                    title: `Delete "${cat.name}"?`,
                    body: `The category and its ${plural(n, 'item')} move to Drive trash. You can restore them from Drive.`,
                    confirm: 'Delete category',
                    danger: true,
                    run: async () => {
                      await deleteCategory(cat.id)
                      location.hash = '#/'
                    },
                    done: 'Category moved to trash',
                  })
                }}
              >
                <Trash2 size={16} /> Delete
              </button>
              <a className="btn primary" href={`#/new/${cat.id}`}>
                <Plus size={16} /> New item
              </a>
            </div>
          )}
        </div>
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input type="search" aria-label="Search items" placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {filtered.length === 0 ? (
          <div className="empty">
            <ImageOff size={28} />
            <h3>{dq ? 'No matching items' : 'No items yet'}</h3>
            {cat && !dq && (
              <a className="btn primary" href={`#/new/${cat.id}`}>
                <Plus size={16} /> Add the first item
              </a>
            )}
          </div>
        ) : (
          <div className={q !== dq ? 'stale' : undefined}>
            <Grid items={shown} />
          </div>
        )}
        {filtered.length > limit && (
          <button className="more" onClick={() => setLimit(limit + 100)}>
            Show more ({filtered.length - limit} left)
          </button>
        )}
      </>
    )
  }

  return (
    <>
      {progress}
      <div className="layout">
        <Sidebar catalog={catalog} categoryId={categoryId ?? (kind === 'i' || kind === 'e' ? catalog.items.find((i) => i.id === id)?.categoryId : id)} counts={counts} busy={!!busy} footer={statusBar} />
        <main key={hash} className="page">
          {page}
        </main>
      </div>
    </>
  )
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="empty">
      <AlertTriangle size={28} />
      <h3>{what} not found</h3>
      <p>It may have been moved or deleted in Drive. Try a rescan.</p>
      <a className="btn" href="#/">
        <ArrowLeft size={16} /> All items
      </a>
    </div>
  )
}

function Detail({ catalog, item, busy }: { catalog: Catalog; item: Item; busy: boolean }) {
  const d = item.details
  const v = (n?: number) => n ?? '—'
  return (
    <>
      <a className="back" href={`#/c/${item.categoryId}`}>
        <ArrowLeft size={16} /> {catalog.categories.find((c) => c.id === item.categoryId)?.name ?? 'Back'}
      </a>
      <div className="page-head">
        <h2>{item.name}</h2>
        <div className="actions">
          <a className="btn ghost" href={`https://drive.google.com/drive/folders/${item.id}`} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> Drive
          </a>
          <button
            className="ghost danger"
            disabled={busy}
            onClick={() =>
              ask({
                title: `Delete "${item.name}"?`,
                body: 'The item folder and its images move to Drive trash.',
                confirm: 'Delete item',
                danger: true,
                run: async () => {
                  await deleteItem(item.id)
                  location.hash = `#/c/${item.categoryId}`
                },
                done: 'Item moved to trash',
              })
            }
          >
            <Trash2 size={16} /> Delete
          </button>
          <a className="btn primary" href={`#/e/${item.id}`}>
            <Pencil size={16} /> Edit
          </a>
        </div>
      </div>
      {item.issues.length > 0 && (
        <ul className="issues">
          {item.issues.map((i) => (
            <li key={i}>
              <AlertTriangle size={14} /> {ISSUE_TEXT[i]}
            </li>
          ))}
        </ul>
      )}
      <div className="specs">
        <p>
          <span>Dimensions</span>
          {v(d?.length)} × {v(d?.width)} × {v(d?.height)} {d?.dimension_unit ?? ''}
        </p>
        <p>
          <span>Weight</span>
          {v(d?.weight)} {d?.weight_unit ?? ''}
        </p>
        <p>
          <span>Photos</span>
          {item.images.length}
        </p>
      </div>
      <Gallery key={item.id} item={item} disabled={busy} />
    </>
  )
}
