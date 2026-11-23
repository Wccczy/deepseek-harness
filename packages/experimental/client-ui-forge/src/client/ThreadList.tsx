/**
 * The thread list of a change request beside its changes: every thread grouped by file in file tree order, narrowed
 * by whether it is resolved, each opening the place it shows at, and the review drafts a plugin contributes. A wide
 * changes view docks the list beside the files; a narrower one floats it over them, and the narrowest gives it their
 * whole width.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconRightUpOutlineRegular, SegmentedTabs, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeDiffFile } from '../types.ts'
import { FileLabel } from './FileLabel.tsx'
import { SegmentedChoice } from './ReviewControls.tsx'
import { Avatar } from './ReviewThreads.tsx'
import { anchorRange, inFileOrder, passesFilter, THREAD_FILTERS, type ThreadFilter, type ThreadPlace } from './review-threads.ts'
import type { NS } from './locales.ts'
import type { PlacedThread } from './thread-state.ts'
import css from './ThreadList.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Tab of the thread list pane. */
export type ThreadListTab = 'threads' | 'drafts'

const MIN_WIDTH = 260
const MAX_WIDTH = 560
/** Width the file tree and the code column keep beside the pane, which lowers the pane's maximum width. */
const BESIDE_WIDTH = 600

/** Props of the thread list. */
export interface ThreadListProps extends PropsLocale<typeof NS> {
  /** Every thread read, in host order, with where the current changes show it. */
  readonly entries: readonly PlacedThread[]
  /** Changed files in file tree order; threads on other paths follow them. */
  readonly files: readonly ForgeDiffFile[]
  /** Whether the host has more threads than were read. */
  readonly truncated: boolean
  /** Web page of the change request. */
  readonly url: string
  /** The active filter. */
  readonly filter: ThreadFilter
  /** Choose a filter. */
  readonly choose: (filter: ThreadFilter) => void
  /** The shown tab. */
  readonly tab: ThreadListTab
  /** Choose the tab to show. */
  readonly chooseTab: (tab: ThreadListTab) => void
  /** Width of the pane in pixels. */
  readonly width: number
  /** Receive the width the reader chose, which the pane has already bounded by its minimum and maximum. */
  readonly resize: (width: number) => void
  /** Whether the reader just opened the list, so a list that covers the files takes the focus. */
  readonly claim: boolean
  /** Report that the list handled `claim`. */
  readonly claimed: () => void
  /** Open the place of a thread; `covering` says the list covers the files, so the owner closes it first. */
  readonly open: (entry: PlacedThread, covering: boolean) => void
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Close the list at the reader's request. */
  readonly close: () => void
  /** The body of the drafts tab, from `forge.changes.threads.panel`. */
  readonly panels?: ReactNode | undefined
}

function meta(thread: ForgeReviewThread, place: ThreadPlace, t: Translate): string {
  const replies = thread.comments.length - 1
  const parts: string[] = []
  if (thread.subject === 'file') parts.push(t('thread.fileLevel'))
  else if (place.kind === 'line') parts.push(anchorRange(place.side, place))
  else if (thread.original !== null) {
    parts.push(t('thread.originally', { range: anchorRange(thread.side, thread.original) }), t('thread.onCommit', { commit: thread.original.commit.slice(0, 7) }))
  }
  if (replies > 0) parts.push(t('thread.replies', { count: replies }))
  return parts.join(' · ')
}

/** Whether the list floats over the files or takes their width, which its narrow-view styles decide. */
function covers(pane: HTMLElement | null): pane is HTMLElement {
  return pane !== null && getComputedStyle(pane).position === 'absolute'
}

/**
 * The first comment as one line of plain text: without raw HTML, strong, strikethrough, and code marks, quote or
 * heading marks, and link targets.
 */
function plainExcerpt(body: string): string {
  return body.replace(/<[^>]*>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:#{1,6}|>)\s*/gm, '')
    .replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim()
}

function Item({ entry, open, t }: {
  readonly entry: PlacedThread
  readonly open: (entry: PlacedThread) => void
  readonly t: Translate
}): ReactNode {
  const { thread, place } = entry
  const first = thread.comments[0]
  return <button type="button" className={css.item} data-forge-thread-item={thread.id} onClick={() => { open(entry) }}>
    <Avatar author={first?.author ?? null} size={22} />
    <span className={css.itemMain}>
      <span className={css.meta}>{meta(thread, place, t)}</span>
      <span className={css.excerpt}>{plainExcerpt(first?.body ?? '')}</span>
      <span className={css.tags}>
        {place.kind === 'outdated' && <Tag tone="warning">{t('thread.outdatedTag')}</Tag>}
        {place.kind === 'elsewhere' && <Tag tone="neutral">{t('thread.elsewhereTag')}</Tag>}
        {thread.resolved && <Tag tone="success">{t('thread.filter.resolved')}</Tag>}
        {first?.author?.bot === true && <Tag tone="outline">{t('thread.bot')}</Tag>}
      </span>
    </span>
  </button>
}

/**
 * Render the thread list.
 * @param props - threads, their places, the file order, the filter, the shown tab, the pane's width, and the list's actions.
 * @returns the list pane and the scrim behind it where it floats over the files.
 */
export function ThreadList(props: ThreadListProps): ReactNode {
  const { entries, files, filter, t } = props
  const threads = useMemo(() => entries.map(entry => entry.thread), [entries])
  const counts = useMemo(() => Object.fromEntries(THREAD_FILTERS.map(item => [item,
    threads.filter(thread => passesFilter(thread, item)).length])) as Record<ThreadFilter, number>, [threads])
  const groups = useMemo(() => {
    const known = new Map(files.map((file, index) => [file.path, { file, index }]))
    const byPath = new Map<string, PlacedThread[]>()
    for (const entry of entries) {
      if (!passesFilter(entry.thread, filter)) continue
      const list = byPath.get(entry.thread.path)
      if (list === undefined) byPath.set(entry.thread.path, [entry])
      else list.push(entry)
    }
    const position = (path: string): number => known.get(path)?.index ?? files.length
    return [...byPath].sort(([a], [b]) => position(a) - position(b) || a.localeCompare(b))
      .map(([path, list]) => [path, inFileOrder(list, known.get(path)?.file)] as const)
  }, [entries, files, filter])
  const ids = useId()
  const pane = useRef<HTMLElement>(null)
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const [maximum, setMaximum] = useState(MAX_WIDTH)
  useLayoutEffect(() => {
    const parent = pane.current?.parentElement
    if (parent === null || parent === undefined) return
    const measure = (): void => {
      const available = parent.clientWidth
      // A retained tab has no measurable width while its Session or pane is hidden.
      if (available === 0) return
      setMaximum(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - BESIDE_WIDTH)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => { observer.disconnect() }
  }, [])
  useLayoutEffect(() => {
    if (!props.claim) return
    props.claimed()
    if (covers(pane.current)) pane.current.focus({ preventScroll: true })
  }, [props.claim])
  const shown = Math.round(Math.max(MIN_WIDTH, Math.min(props.width, maximum)))
  const resizeTo = (next: number): void => { props.resize(Math.round(Math.max(MIN_WIDTH, Math.min(maximum, next)))) }
  const escape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    props.close()
  }
  const open = (entry: PlacedThread): void => { props.open(entry, covers(pane.current)) }
  return <>
    <div className={css.scrim} aria-hidden="true" onClick={props.close} />
    <aside ref={pane} id={`${ids}-pane`} className={css.pane} tabIndex={-1} data-forge-thread-list=""
      style={{ '--forge-thread-list-width': `${shown}px` } as CSSProperties}
      aria-label={t('thread.listAria', { count: threads.length })} onKeyDown={escape}>
      {/* The pane ends at the docked edge, so a drag to the left widens it. */}
      <div className={css.resize} role="separator" tabIndex={0} aria-label={t('thread.resizeAria')}
        aria-orientation="vertical" aria-controls={`${ids}-pane`} aria-valuemin={MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={shown}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointer: event.pointerId, x: event.clientX, width: shown }
        }}
        onPointerMove={(event) => {
          const active = drag.current
          if (active?.pointer === event.pointerId) resizeTo(active.width - (event.clientX - active.x))
        }}
        onPointerUp={(event) => {
          const active = drag.current
          if (active?.pointer !== event.pointerId) return
          resizeTo(active.width - (event.clientX - active.x))
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          resizeTo(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maximum : shown + (event.key === 'ArrowLeft' ? 20 : -20))
        }} />
      <div className={css.header}>
        <button type="button" className={css.back} onClick={props.close}><IconChevronLeftOutlineRegular size={14} />{t('thread.back')}</button>
        <SegmentedTabs<ThreadListTab> className={css.tabs} size="sm" label={t('thread.tabsAria')} value={props.tab} onChange={props.chooseTab}
          items={[
            {
              value: 'threads', id: `${ids}-threads-tab`, panelId: `${ids}-threads-panel`,
              label: <>{t('thread.tab.threads')}<span className={css.total}>{threads.length}</span></>,
            },
            { value: 'drafts', id: `${ids}-drafts-tab`, panelId: `${ids}-drafts-panel`, label: t('thread.tab.drafts') },
          ]} />
        <Tooltip label={t('thread.close')} side="bottom" delayMs={500} portal>
          <button type="button" className={css.close} aria-label={t('thread.close')} onClick={props.close}><IconCloseOutlineRegular size={14} /></button>
        </Tooltip>
      </div>
      <div id={`${ids}-threads-panel`} role="tabpanel" aria-labelledby={`${ids}-threads-tab`} className={css.panel} hidden={props.tab !== 'threads'}>
        <div className={css.filters}>
          <SegmentedChoice label={t('thread.filterAria')} value={filter} choose={props.choose}
            segments={THREAD_FILTERS.map(item => ({ value: item, label: t(`thread.filter.${item}`), count: counts[item], disabledTip: null }))} />
        </div>
        <div className={css.rows}>
          {threads.length === 0 ? <div className={css.note}>{t('thread.empty')}</div>
            : groups.length === 0 ? <div className={css.note}>{t('thread.none')}</div>
              : groups.map(([path, list]) => <section key={path} className={css.group} data-forge-thread-group={path}>
                <h3 className={css.path}><FileLabel path={path} /></h3>
                {list.map(entry => <Item key={entry.thread.id} entry={entry} open={open} t={t} />)}
              </section>)}
        </div>
        <div className={css.footer}>
          {props.truncated && <>{t('thread.truncated', { count: threads.length })}{' · '}</>}
          <button type="button" className={css.link} onClick={() => { props.openLink(props.url) }}>
            <IconRightUpOutlineRegular size={14} />{t('thread.openAll')}
          </button>
        </div>
      </div>
      <div id={`${ids}-drafts-panel`} role="tabpanel" aria-labelledby={`${ids}-drafts-tab`} className={css.panel} hidden={props.tab !== 'drafts'}>
        <div className={css.drafts}>{props.panels}</div>
      </div>
    </aside>
  </>
}
