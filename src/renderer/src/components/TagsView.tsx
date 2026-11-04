import { Pin, PinOff, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useStore } from '../lib/store'

/** Every tag, filterable. Pin the ones you use often to keep them in the sidebar. */
export function TagsView() {
  const tags = useStore((s) => s.tags)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const setView = useStore((s) => s.setView)
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState<'name' | 'count'>('name')

  const pinned = new Set(prefs.pinnedTags.map((t) => t.toLowerCase()))
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = tags.filter((t) => !f || t.name.toLowerCase().includes(f))
    return order === 'count'
      ? [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      : list
  }, [tags, filter, order])

  const togglePin = (name: string) =>
    setPrefs({
      pinnedTags: pinned.has(name.toLowerCase())
        ? prefs.pinnedTags.filter((t) => t.toLowerCase() !== name.toLowerCase())
        : [...prefs.pinnedTags, name]
    })

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Tags">
      <header className="flex h-12 shrink-0 items-center gap-3 px-5">
        <h1 className="text-[16px] font-semibold tracking-tight">Tags</h1>
        <span className="text-[12.5px] text-fg-3 tabular-nums">{tags.length}</span>
        <label className="relative ml-auto flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-fg-3" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tags"
            aria-label="Filter tags"
            className="h-7 w-56 rounded-md border border-line bg-input pr-2 pl-8 text-[12.5px] outline-none placeholder:text-fg-3 focus:border-accent"
          />
        </label>
        <select
          aria-label="Order tags"
          value={order}
          onChange={(e) => setOrder(e.target.value as 'name' | 'count')}
          className="h-7 rounded-md border border-line bg-input px-2 text-[12.5px] text-fg-2 outline-none"
        >
          <option value="name">A to Z</option>
          <option value="count">Most used</option>
        </select>
      </header>
      <p className="px-5 pb-3 text-[12.5px] text-fg-3">
        Pin the tags you use most to keep them in the sidebar. Everything else stays one click, or a{' '}
        <code className="font-mono">tag:</code> search, away.
      </p>
      <ul className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-1 overflow-y-auto border-t border-line p-4">
        {shown.map((t) => {
          const isPinned = pinned.has(t.name.toLowerCase())
          return (
            <li key={t.name} className="group flex items-center gap-1 rounded-md hover:bg-hover">
              <button
                type="button"
                onClick={() => setView({ kind: 'tag', tag: t.name })}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-[13px]"
              >
                <span className="truncate">{t.name}</span>
                <span className="text-[11.5px] text-fg-3 tabular-nums">{t.count}</span>
              </button>
              <button
                type="button"
                aria-label={isPinned ? `Unpin ${t.name}` : `Pin ${t.name}`}
                title={isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                onClick={() => togglePin(t.name)}
                className={`mr-1 rounded p-1 ${
                  isPinned ? 'text-accent' : 'text-transparent group-hover:text-fg-3 hover:!text-fg'
                }`}
              >
                {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            </li>
          )
        })}
        {shown.length === 0 && <li className="p-4 text-[13px] text-fg-3">No tags match.</li>}
      </ul>
    </section>
  )
}
