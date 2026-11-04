import { ChevronDown, Command, FilePlus2, Link2, Plus, Search, Sparkles, X } from 'lucide-react'
import { forwardRef } from 'react'
import { isListView, useStore } from '../lib/store'
import { Button, Menu } from './ui'

export const TitleBar = forwardRef<
  HTMLInputElement,
  {
    onImport: () => void
    onAdd: () => void
    onSaveSearch: (query: string) => void
    onPalette: () => void
  }
>(function TitleBar({ onImport, onAdd, onSaveSearch, onPalette }, searchRef) {
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const mac = useStore((s) => s.info?.platform === 'darwin')

  return (
    <header className="drag flex h-12 shrink-0 items-center gap-3 bg-sidebar pr-3">
      {/* Room for the macOS traffic lights, then the sidebar's width so the search lines up with the list. */}
      <div className={`flex w-[216px] shrink-0 items-center ${mac ? 'pl-[84px]' : 'pl-4'}`}>
        <span className="text-[13.5px] font-semibold tracking-tight text-fg-2">PaperManager</span>
      </div>

      <label className="no-drag relative flex h-8 max-w-[600px] flex-1 items-center">
        <Search size={14} className="pointer-events-none absolute left-3 text-fg-3" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => {
            // Results show in the paper list, so leave views that don't have one.
            const s = useStore.getState()
            if (!isListView(s.view) || s.reader) s.setView({ kind: 'all' })
            setQuery(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          placeholder="Search your library"
          aria-label="Search"
          title="Words search titles, authors, abstracts, tags and the PDF text. Filters: tag: -tag: author: journal: year: status: is: collection:"
          className="h-8 w-full rounded-lg border border-transparent bg-raised pr-16 pl-9 text-[13px] shadow-[0_0_0_1px_var(--line)] outline-none placeholder:text-fg-3 focus:shadow-[0_0_0_1.5px_var(--accent)]"
        />
        <span className="absolute right-2 flex items-center gap-0.5">
          {query ? (
            <>
              <button
                type="button"
                aria-label="Save as smart collection"
                title="Save this search as a smart collection"
                onClick={() => onSaveSearch(query)}
                className="flex size-6 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-accent"
              >
                <Sparkles size={13} />
              </button>
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="flex size-6 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-fg"
              >
                <X size={13} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onPalette}
              aria-label="Open command palette"
              title="Commands and quick jump (⌘K)"
              className="flex h-5 items-center gap-0.5 rounded border border-line px-1.5 text-[11px] text-fg-3 hover:text-fg"
            >
              <Command size={10} />K
            </button>
          )}
        </span>
      </label>

      <div className="ml-auto flex items-center gap-2">
        <Menu
          label="Add"
          items={[
            {
              label: 'Import PDFs…',
              icon: <FilePlus2 size={14} />,
              hint: '⌘O',
              onSelect: onImport
            },
            { label: 'Add by identifier…', icon: <Link2 size={14} />, hint: '⌘⇧N', onSelect: onAdd }
          ]}
          trigger={(p) => (
            <Button variant="primary" {...p} aria-label="Add papers">
              <Plus size={14} /> Add <ChevronDown size={12} />
            </Button>
          )}
        />
      </div>
    </header>
  )
})
