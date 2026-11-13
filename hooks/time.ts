// Time accounting: splits a window of time between the kinds of work that filled it.
// Pure functions: no engine calls.
import type { Board, Entry, Range, StationId } from '../types'

export type Window = { from: number; to: number }

/** The window a range covers: the current (or last) turn, the last five minutes, or the whole session. */
export function windowOf(board: Board, range: Range, now: number): Window {
  if (range === '5m') return { from: now - 5 * 60_000, to: now }
  if (range === 'all') {
    const first = board.firstAt ?? board.entries[0]?.startedAt ?? now - 60_000
    return { from: Math.min(first, now - 10_000), to: now }
  }
  const turn = board.turns[board.turns.length - 1]
  if (turn === undefined) return { from: now - 60_000, to: now }
  const to = turn.endedAt ?? now
  return { from: turn.startedAt, to: Math.max(to, turn.startedAt + 2_000) }
}

export const endOf = (e: Entry, now: number): number => e.endedAt ?? now

/** Does an entry take time (not a moment like a message arriving)? */
export const hasSpan = (e: Entry, now: number): boolean => endOf(e, now) - e.startedAt > 0

/** What a slice of time is spent on: a station, waiting on the person, or nothing at all. */
export type Category = StationId | 'waiting' | 'idle'

export type Breakdown = {
  span: number
  /** Wall time attributed to each category; slices with several calls are shared out evenly, so the parts sum to `span`. */
  parts: Partial<Record<Category, number>>
  /** Wall time with two or more tool calls of the main loop running at once. */
  parallel: number
  /** Wall time with anything at all running. */
  busy: number
  /** The most tool calls running at once. */
  peak: number
}

const categoryOf = (e: Entry): Category => (e.mark === 'ask' ? 'waiting' : e.station)

/**
 * Calls of the main loop only: a subagent's own calls happen inside its Agent call, which already holds the time.
 * Background tasks count while their entry is open.
 */
export function breakdown(entries: readonly Entry[], w: Window, now: number): Breakdown {
  type Edge = { t: number; delta: 1 | -1; cat: Category; tool: boolean }
  const edges: Edge[] = []
  for (const e of entries) {
    if (e.from === 'agents' || e.mark === 'switch' || e.mark === 'done') continue
    const s = Math.max(e.startedAt, w.from)
    const t = Math.min(endOf(e, now), w.to)
    if (t <= s) continue
    const cat = categoryOf(e)
    const tool = cat !== 'model' && cat !== 'waiting'
    edges.push({ t: s, delta: 1, cat, tool }, { t, delta: -1, cat, tool })
  }
  edges.sort((a, b) => a.t - b.t || a.delta - b.delta)

  const active = new Map<Category, number>()
  const parts: Partial<Record<Category, number>> = {}
  let tools = 0
  let parallel = 0
  let busy = 0
  let peak = 0
  let at = w.from
  const add = (cat: Category, ms: number): void => {
    parts[cat] = (parts[cat] ?? 0) + ms
  }
  const spend = (until: number): void => {
    const ms = until - at
    if (ms <= 0) return
    const cats = [...active.keys()]
    if (cats.length === 0) add('idle', ms)
    else {
      busy += ms
      // Weighted by how many calls of each kind run: three file reads and one model step share 3 : 1.
      const total = [...active.values()].reduce((a, b) => a + b, 0)
      for (const [cat, n] of active) add(cat, (ms * n) / total)
    }
    if (tools >= 2) parallel += ms
  }
  for (const edge of edges) {
    spend(edge.t)
    at = Math.max(at, edge.t)
    const n = (active.get(edge.cat) ?? 0) + edge.delta
    if (n <= 0) active.delete(edge.cat)
    else active.set(edge.cat, n)
    if (edge.tool) tools += edge.delta
    peak = Math.max(peak, tools)
  }
  spend(w.to)
  return { span: w.to - w.from, parts, parallel, busy, peak }
}

/** A tick step for an axis `span` long that leaves about `want` ticks. */
export function tickStep(span: number, want = 5): number {
  const steps = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]
  return steps.find(s => span / s <= want) ?? 3_600_000
}

export function tickLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
