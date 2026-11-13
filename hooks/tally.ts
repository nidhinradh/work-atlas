// What the board keeps and what it adds up, so that every figure is of the whole of what it names.
//
// A window of the current turn or of the last five minutes is drawn from the calls themselves, so every call of the
// current turn and of the last five minutes is kept. The session is longer than any list worth keeping, so its figures
// are sums, added to as each call ends: they do not depend on which calls are still on the board.
// Pure functions: no engine calls.
import type { Board, Entry, History, Spent, StationId, StationTotals } from '../types'
import { breakdown } from './time'

/** The calls kept beyond the windows that need them: enough for the log and the session's timeline to have a past. */
export const KEEP = 400
/** How far back the shorter of the windows reaches, with a little over so that a call on its edge is still there. */
export const RECENT_MS = 5 * 60_000 + 15_000
/** No board is asked to hold more than this, whatever happens in a turn; past it the drawing says so. */
export const HARD_KEEP = 6000
const SLOWEST = 10

/**
 * The calls to keep: every one of the current turn and of the last five minutes, every one still running, and the
 * newest `KEEP` besides.
 */
export function kept(entries: Entry[], now: number, turnStartedAt: number | undefined): Entry[] {
  const fromIndex = entries.length - KEEP
  if (fromIndex <= 0) return entries
  const since = Math.min(now - RECENT_MS, turnStartedAt ?? Infinity)
  const out = entries.filter((e, i) => i >= fromIndex || e.startedAt >= since || e.status === 'run')
  return out.length > HARD_KEEP ? out.slice(out.length - HARD_KEEP) : out
}

/** Whether a call is one the totals count: a call that takes time, not a message arriving or a mark of the map's. */
const counts = (e: Entry): boolean => e.mark !== 'switch' && e.mark !== 'done' && e.from !== 'inbound'

const isFault = (e: Entry): boolean => e.status === 'err' || e.status === 'block'

function add(stats: Board['stats'], e: Entry): NonNullable<Board['stats']> {
  const was: StationTotals = stats?.[e.station] ?? { calls: 0, fails: 0, total: 0, max: 0 }
  const took = Math.max(0, (e.endedAt ?? e.startedAt) - e.startedAt)
  return { ...stats, [e.station]: { calls: was.calls + 1, fails: was.fails + (isFault(e) ? 1 : 0), total: was.total + took, max: Math.max(was.max, took) } }
}

const tookOf = (e: Entry): number => (e.endedAt ?? e.startedAt) - e.startedAt

function slower(slow: Entry[] | undefined, e: Entry): Entry[] {
  if (e.mark !== undefined || tookOf(e) <= 0) return slow ?? []
  return [...(slow ?? []), e].sort((a, z) => tookOf(z) - tookOf(a)).slice(0, SLOWEST)
}

/**
 * The session's totals with the calls given added: each a call that has just ended, counted once. Where the board has
 * no totals yet (a session that began before this version), they start from the ended calls still on it.
 */
export function tallied(b: Board, ended: readonly Entry[]): Pick<Board, 'stats' | 'slow'> {
  let stats = b.stats
  let slow = b.slow
  if (stats === undefined) {
    const ids = new Set(ended.map(e => e.id))
    for (const e of b.entries) {
      if (e.endedAt === undefined || ids.has(e.id) || !counts(e)) continue
      stats = add(stats, e)
      slow = slower(slow, e)
    }
  }
  for (const e of ended) {
    if (!counts(e)) continue
    stats = add(stats, e)
    slow = slower(slow, e)
  }
  return { stats: stats ?? {}, slow: slow ?? [] }
}

const EMPTY: Spent = { parts: {}, busy: 0, parallel: 0, peak: 0 }

/** Where a stretch of the session went, added to what earlier stretches came to. */
function plus(spent: Spent, parts: Record<string, number>, busy: number, parallel: number, peak: number): Spent {
  const out: Record<string, number> = { ...spent.parts }
  for (const [k, v] of Object.entries(parts)) out[k] = (out[k] ?? 0) + (v ?? 0)
  return { parts: out, busy: spent.busy + busy, parallel: spent.parallel + parallel, peak: Math.max(spent.peak, peak) }
}

/** A turn has ended: where its time went joins the session's. Called while the turn's calls are all on the board. */
export function spentAfterTurn(b: Board, turnStartedAt: number, now: number): Spent {
  const of = breakdown(b.entries.filter(e => e.startedAt >= turnStartedAt), { from: turnStartedAt, to: now }, now)
  return plus(b.spent ?? seed(b, turnStartedAt), of.parts as Record<string, number>, of.busy, of.parallel, of.peak)
}

/** A message has come: the time since the last answer was spent waiting on the person. */
export function spentWaiting(b: Board, now: number): Spent | undefined {
  const last = b.turns[b.turns.length - 1]
  if (last?.endedAt === undefined || b.spent === undefined) return b.spent
  return plus(b.spent, { waiting: Math.max(0, now - last.endedAt) }, 0, 0, 0)
}

/** For a session that began before this version: what the calls still on the board say of the time before `until`. */
function seed(b: Board, until: number): Spent {
  const first = b.entries[0]?.startedAt
  if (first === undefined || first >= until) return EMPTY
  const of = breakdown(b.entries.filter(e => e.startedAt < until), { from: first, to: until }, until)
  return plus(EMPTY, of.parts as Record<string, number>, of.busy, of.parallel, of.peak)
}

// ---- the shape of what is no longer kept ----------------------------------------------------------

const FIRST_SLICE_MS = 10_000
/** No record holds more slices than this: past it, slices are joined in pairs. */
export const MAX_SLICES = 1440

/** The record with its slices joined in pairs: twice as wide, half as many, the same time covered. */
function widened(h: History): History {
  const pairs = (xs: number[], join: (a: number, b: number) => number): number[] => {
    const out: number[] = []
    for (let i = 0; i < xs.length; i += 2) out.push(join(xs[i] ?? 0, xs[i + 1] ?? 0))
    return out
  }
  const each = (lanes: History['busy'], join: (a: number, b: number) => number): History['busy'] =>
    Object.fromEntries(Object.entries(lanes).map(([k, xs]) => [k, pairs(xs ?? [], join)])) as History['busy']
  return { ...h, sliceMs: h.sliceMs * 2, busy: each(h.busy, (a, b) => a + b), faults: each(h.faults, Math.max), peak: pairs(h.peak, Math.max) }
}

function roomFor(h: History, until: number): History {
  let out = h
  while ((until - out.from) / out.sliceMs >= MAX_SLICES) out = widened(out)
  return out
}

const put = (xs: number[] | undefined, i: number, value: (was: number) => number): number[] => {
  const out = xs !== undefined ? [...xs] : []
  while (out.length <= i) out.push(0)
  out[i] = value(out[i] ?? 0)
  return out
}

/**
 * The record with the calls given added: each a call leaving the board, added once. A call that took no time (a
 * message arriving) counts as a moment, so that it still shows.
 */
export function folded(b: Board, dropped: readonly Entry[]): History | undefined {
  if (dropped.length === 0) return b.history
  const from = b.firstAt ?? b.entries[0]?.startedAt ?? dropped[0]!.startedAt
  let h: History = b.history ?? { sliceMs: FIRST_SLICE_MS, from, busy: {}, faults: {}, peak: [] }
  for (const e of dropped) {
    if (e.mark === 'switch' || e.endedAt === undefined || e.startedAt < h.from) continue
    const end = Math.max(e.endedAt, e.startedAt + 1)
    h = roomFor(h, end)
    const first = Math.floor((e.startedAt - h.from) / h.sliceMs)
    const last = Math.floor((end - 1 - h.from) / h.sliceMs)
    let busy = h.busy[e.station]
    for (let i = first; i <= last; i++) {
      const s0 = h.from + i * h.sliceMs
      const ms = Math.min(end, s0 + h.sliceMs) - Math.max(e.startedAt, s0)
      busy = put(busy, i, was => was + ms)
    }
    h = { ...h, busy: { ...h.busy, [e.station]: busy ?? [] } }
    if (isFault(e)) h = { ...h, faults: { ...h.faults, [e.station]: put(h.faults[e.station], first, () => 1) } }
  }
  return h
}

/**
 * The record's `peak` brought up to `now`: the most tool calls running at once in each slice, worked out from the
 * calls since it was last worked out, all of which are still on the board (a turn's calls are kept while it runs).
 */
export function peaked(b: Board, now: number): History | undefined {
  const from = b.firstAt ?? b.entries[0]?.startedAt
  if (from === undefined) return b.history
  let h: History = roomFor(b.history ?? { sliceMs: FIRST_SLICE_MS, from, busy: {}, faults: {}, peak: [] }, now)
  const since = h.peakUntil ?? h.from
  const edges: [number, number][] = []
  for (const e of b.entries) {
    if (e.station === 'model' || e.mark !== undefined || e.from === 'inbound') continue
    const end = e.endedAt ?? now
    if (end <= since || end <= e.startedAt) continue
    edges.push([Math.max(e.startedAt, since), 1], [end, -1])
  }
  edges.sort((a, z) => a[0] - z[0] || a[1] - z[1])
  let peak = h.peak
  let running = 0
  let at = since
  const mark = (until: number): void => {
    if (running === 0 || until <= at) return
    const first = Math.floor((at - h.from) / h.sliceMs)
    const last = Math.floor((until - 1 - h.from) / h.sliceMs)
    for (let i = Math.max(0, first); i <= last; i++) peak = put(peak, i, was => Math.max(was, running))
  }
  for (const [t, delta] of edges) {
    mark(t)
    at = Math.max(at, t)
    running += delta
  }
  h = { ...h, peak, peakUntil: now }
  return h
}

/** The stations a record has anything for. */
export const stationsIn = (h: History | undefined): StationId[] => (h === undefined ? [] : (Object.keys(h.busy) as StationId[]).filter(id => (h.busy[id] ?? []).some(ms => ms > 0)))
