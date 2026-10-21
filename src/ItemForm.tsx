import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Catalog, Item } from './catalog'
import { DIM_UNITS, WEIGHT_UNITS, createItem, toInput, updateItem, validateItem } from './mutate'
import type { ItemInput } from './mutate'
import { ask, Spinner, toast } from './ui'

export default function ItemForm({
  catalog,
  categoryId,
  item,
  onDone,
}: {
  catalog: Catalog
  categoryId: string
  item?: Item
  onDone: (itemId: string | null) => void
}) {
  const [v, setV] = useState<ItemInput>(() => toInput(item))
  const [target, setTarget] = useState(categoryId)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const { errors } = validateItem(v, catalog.items, target, item?.id)
  if (item && v.name.trim() === item.name) delete errors.name
  const catName = catalog.categories.find((c) => c.id === categoryId)?.name ?? ''
  const invalid = Object.keys(errors).length > 0

  const field = (k: keyof ItemInput) => ({
    value: v[k],
    onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }),
  })
  const msg = (k: keyof ItemInput) =>
    errors[k] && (touched || v[k] !== '') ? <small className="error">{errors[k]}</small> : null
  const num = (k: keyof ItemInput, label: string) => (
    <label>
      {label}
      <input type="number" inputMode="decimal" min="0" step="any" {...field(k)} />
      {msg(k)}
    </label>
  )

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (invalid || saving) return
    if (
      item?.issues.includes('malformed-details') &&
      !(await ask({
        title: 'Overwrite malformed details?',
        body: 'details.json for this item is malformed. Overwrite it with the values in this form? Unknown fields are kept.',
        confirm: 'Overwrite',
        danger: true,
      }))
    )
      return
    setSaving(true)
    try {
      if (item) {
        await updateItem(item.id, v, target)
        toast('Item saved')
        onDone(item.id)
      } else {
        const n = await createItem(categoryId, v)
        toast('Item created')
        onDone(n.id)
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="form" onSubmit={submit} aria-busy={saving}>
      <h2>{item ? `Edit ${item.name}` : `New item in ${catName}`}</h2>
      <label>
        Name
        <input placeholder="red-mug" {...field('name')} />
        <small>lowercase letters, numbers, hyphens</small>
        {msg('name')}
      </label>
      <div className="row">
        {num('length', 'Length')}
        {num('width', 'Width')}
        {num('height', 'Height')}
        <label>
          Unit
          <select {...field('dimension_unit')}>
            {DIM_UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        {num('weight', 'Weight')}
        <label>
          Weight unit
          <select {...field('weight_unit')}>
            {WEIGHT_UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </div>
      {item && (
        <label>
          Category
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {catalog.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={saving || invalid}>
          {saving && <Spinner />}
          {saving ? 'Saving…' : item ? 'Save changes' : 'Create item'}
        </button>
        <button type="button" className="ghost" disabled={saving} onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  )
}
