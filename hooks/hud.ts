// The dashboard drawing: a single SVG, laid out for whatever width and height it is handed.
// Pure functions: no engine calls.
//
// Every section is a block that knows its height at a width; the layout picks the blocks that fit the pane's
// height, by importance, and gives what is left to the map. A wide pane puts the map beside the panels.
import type { Board, Entry, FileStat, StationId, ThemeId, View } from '../types'
import { STATIONS, formatMs, formatTokens, shortModel, stationOf } from './classify'
import { breakdown, endOf, hasSpan, tickLabel, tickStep } from './time'
import type { Breakdown, Category, Window } from './time'
import { THEMES } from './palette'
import { HARD_KEEP, stationsIn } from './tally'
import type { Palette } from './palette'

// The colours of the look being drawn. One drawing is one look, set at its start by `usePalette`; they are module
// values so that every block reads them without each being handed a palette.
let BG = ''
let PANEL = ''
let GRID = ''
let LINE = ''
let INK = ''
let DIM = ''
let FAINT = ''
let CYAN = ''
let AMBER = ''
let ERR = ''
let WAIT = ''
let GLOW = 1

function usePalette(p: Palette): void {
  BG = p.bg
  PANEL = p.panel
  GRID = p.grid
  LINE = p.line
  INK = p.ink
  DIM = p.dim
  FAINT = p.faint
  CYAN = p.accent
  AMBER = p.amber
  ERR = p.err
  WAIT = p.wait
  GLOW = p.glow
}

const FONT = `font-family="ui-monospace, 'SF Mono', Menlo, monospace"`
const PAD = 10
const GAP = 12

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()
const sec = (ms: number): string => `${(ms / 1000).toFixed(3)}s`
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
/** A path cut from the left at a folder's edge, so it keeps its file name and whole folder names. */
function tailPath(path: string, n: number): string {
  if (path.length <= n) return path
  const parts = path.split('/')
  while (parts.length > 1 && parts.join('/').length + 2 > n) parts.shift()
  const kept = parts.join('/')
  return kept.length + 2 <= n ? `…/${kept}` : tail(kept, n)
}

/** Cut from the left, so a path keeps its file name. */
const tail = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(s.length - Math.max(1, n) + 1)}`)
const head = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n) - 1)}…`)
/** How many mono characters of a font size fit a width. */
const fit = (w: number, size: number): number => Math.max(3, Math.floor(w / (size * 0.62)))

type Point = { x: number; y: number }
type Block = { h: number; draw: (x: number, y: number) => string }

function towards(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

/** An arc of a ring from angle a0 to a1 (radians, clockwise from the top), as a path. */
function arcPath(c: Point, r: number, a0: number, a1: number): string {
  const p0 = { x: c.x + r * Math.sin(a0), y: c.y - r * Math.cos(a0) }
  const p1 = { x: c.x + r * Math.sin(a1), y: c.y - r * Math.cos(a1) }
  return `M${n1(p0.x)} ${n1(p0.y)}A${n1(r)} ${n1(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${n1(p1.x)} ${n1(p1.y)}`
}

const hexagon = (c: Point, r: number): string =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k + Math.PI / 6
    return `${k === 0 ? 'M' : 'L'}${n1(c.x + r * Math.cos(a))} ${n1(c.y + r * Math.sin(a))}`
  }).join('') + 'Z'

/** Corner brackets around a box: the HUD's frame. */
function brackets(x: number, y: number, w: number, h: number, color = LINE, k = 6): string {
  const d = `M${n1(x)} ${n1(y + k)}V${n1(y)}H${n1(x + k)}M${n1(x + w - k)} ${n1(y)}H${n1(x + w)}V${n1(y + k)}M${n1(x + w)} ${n1(y + h - k)}V${n1(y + h)}H${n1(x + w - k)}M${n1(x + k)} ${n1(y + h)}H${n1(x)}V${n1(y + h - k)}`
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.2"/>`
}

/** A section's heading: its name, a rule, and a figure at the right. 14 tall. */
function title(x: number, y: number, w: number, name: string, right = '', color = CYAN): string {
  const shown = head(right.toUpperCase(), fit(w - name.length * 9.4 - 30, 11))
  return (
    `<text x="${n1(x)}" y="${n1(y + 10)}" font-size="11" letter-spacing="1.6" fill="${color}">${esc(name.toUpperCase())}</text>` +
    `<line x1="${n1(x + name.length * 9.4 + 8)}" y1="${n1(y + 6)}" x2="${n1(x + w - (shown === '' ? 0 : shown.length * 7.5 + 8))}" y2="${n1(y + 6)}" stroke="${LINE}" stroke-width="1"/>` +
    (shown === '' ? '' : `<text x="${n1(x + w)}" y="${n1(y + 10)}" text-anchor="end" font-size="11" letter-spacing="1" fill="${DIM}">${esc(shown)}</text>`)
  )
}

/** 16 × 16 line icons around the origin. */
const ICONS: Record<StationId, string> = {
  you: '<circle cx="8" cy="5" r="3"/><path d="M2 15c0-4.5 12-4.5 12 0"/>',
  model: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M6 1v2.5M10 1v2.5M6 12.5V15M10 12.5V15M1 6h2.5M1 10h2.5M12.5 6H15M12.5 10H15"/>',
  memory: '<circle cx="8" cy="3" r="1.8"/><circle cx="3" cy="13" r="1.8"/><circle cx="13" cy="13" r="1.8"/><path d="M7 4.6 4 11.4M9 4.6l3 6.8M4.8 13h6.4"/>',
  files: '<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/>',
  shell: '<path d="M2.5 4l4 4-4 4M8.5 12.5h5"/>',
  web: '<circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="2.8" ry="6.5"/><path d="M1.5 8h13"/>',
  browser: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 5.5h13"/>',
  agents: '<circle cx="8" cy="3" r="1.8"/><circle cx="3" cy="13" r="1.8"/><circle cx="13" cy="13" r="1.8"/><path d="M8 4.8V8M8 8l-4 3.4M8 8l4 3.4"/>',
  skills: '<path d="M9 1 3.5 9h4.5l-1 6L12.5 7H8z"/>',
  hooks: '<path d="M10.5 1.5v8.5a3.2 3.2 0 0 1-6.4 0V8.5"/><path d="M4.1 8.5 2.6 10M4.1 8.5 5.6 10"/>',
}

export const categoryName = (c: Category): string => (c === 'waiting' ? 'Waiting on you' : c === 'idle' ? 'Nothing running' : c === 'model' ? 'Model thinking' : stationOf(c).name)
export const categoryColor = (c: Category): string => (c === 'waiting' ? WAIT : c === 'idle' ? FAINT : stationOf(c).color)
const ORDER: readonly Category[] = ['model', 'files', 'shell', 'web', 'browser', 'agents', 'memory', 'skills', 'hooks', 'you', 'waiting', 'idle']

// ---- figures -----------------------------------------------------------------------------------

export type StationStats = { calls: number; fails: number; total: number; max: number; running: number }

export function statsOf(entries: readonly Entry[], w: Window, now: number): Map<StationId, StationStats> {
  const out = new Map<StationId, StationStats>()
  for (const e of entries) {
    if (e.mark === 'switch' || e.mark === 'done' || e.from === 'inbound') continue
    if (endOf(e, now) < w.from || e.startedAt > w.to) continue
    const s = out.get(e.station) ?? { calls: 0, fails: 0, total: 0, max: 0, running: 0 }
    const took = endOf(e, now) - e.startedAt
    out.set(e.station, {
      calls: s.calls + 1,
      fails: s.fails + (e.status === 'err' || e.status === 'block' ? 1 : 0),
      total: s.total + took,
      max: Math.max(s.max, took),
      running: s.running + (e.status === 'run' ? 1 : 0),
    })
  }
  return out
}

export type HudInput = {
  board: Board
  view: View
  window: Window
  rangeLabel: string
  now: number
  core: string
  /** The look to draw in. */
  theme: ThemeId
  /** The room to fill, in the drawing's own units: one is about a pixel at full size. */
  width: number
  height: number
}

type Ctx = HudInput & {
  bd: Breakdown
  running: Entry[]
  isDim: (id: StationId) => boolean
  /** What happened in the window: every section under the figures at the top is drawn from these. */
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  files: Record<string, FileStat>
  stats: Map<StationId, StationStats>
  /** The window's slowest calls, longest first. */
  slow: Entry[]
  /** When the oldest call still kept began: a session's timeline has no bars before it, and says so. */
  keptFrom: number
  isSession: boolean
}

/**
 * Where the session's time went: what the turns that ended came to, and what the time since comes to (the turn still
 * going, or the wait since the last answer). The whole of the session, however few of its calls are still kept.
 */
function sessionBreakdown(board: Board, now: number): Breakdown | undefined {
  if (board.spent === undefined) return undefined
  const turn = board.turns[board.turns.length - 1]
  const parts: Record<string, number> = { ...board.spent.parts }
  let { busy, parallel, peak } = board.spent
  if (turn !== undefined && turn.endedAt === undefined) {
    const live = breakdown(board.entries.filter(e => e.startedAt >= turn.startedAt), { from: turn.startedAt, to: now }, now)
    for (const [k, v] of Object.entries(live.parts)) parts[k] = (parts[k] ?? 0) + (v ?? 0)
    busy += live.busy
    parallel += live.parallel
    peak = Math.max(peak, live.peak)
  } else if (turn?.endedAt !== undefined) {
    parts.waiting = (parts.waiting ?? 0) + Math.max(0, now - turn.endedAt)
  }
  return { span: Math.max(1, Object.values(parts).reduce((a, v) => a + v, 0)), parts: parts as Breakdown['parts'], busy, parallel, peak }
}

/** The session's totals per station, with the calls still running added as they stand. */
function sessionStats(board: Board, now: number): Map<StationId, StationStats> | undefined {
  if (board.stats === undefined) return undefined
  const out = new Map<StationId, StationStats>()
  for (const s of STATIONS) {
    const t = board.stats[s.id]
    if (t !== undefined) out.set(s.id, { ...t, running: 0 })
  }
  for (const e of board.entries) {
    if (e.status !== 'run' || e.mark === 'switch' || e.from === 'inbound') continue
    const was = out.get(e.station) ?? { calls: 0, fails: 0, total: 0, max: 0, running: 0 }
    const took = now - e.startedAt
    out.set(e.station, { calls: was.calls + 1, fails: was.fails, total: was.total + took, max: Math.max(was.max, took), running: was.running + 1 })
  }
  return out
}

/** The calls given that took time, longest first, each once. */
function slowestOf(entries: readonly Entry[], now: number): Entry[] {
  const seen = new Set<string>()
  return entries
    .filter(e => e.mark === undefined && e.from !== 'inbound' && hasSpan(e, now) && !seen.has(e.id) && seen.add(e.id) !== undefined)
    .sort((a, z) => endOf(z, now) - z.startedAt - (endOf(a, now) - a.startedAt))
    .slice(0, 12)
}

/** How many calls each station took, counted from the calls given. */
function countsIn(entries: readonly Entry[]): Partial<Record<StationId, number>> {
  const out: Partial<Record<StationId, number>> = {}
  for (const e of entries) if (e.mark !== 'switch') out[e.station] = (out[e.station] ?? 0) + 1
  return out
}

/** The files touched by the calls given: what the board keeps for the session, rebuilt for a shorter window. */
function filesIn(entries: readonly Entry[]): Record<string, FileStat> {
  const out: Record<string, FileStat> = {}
  for (const e of entries) {
    if (e.file === undefined) continue
    const was = out[e.file.path] ?? { reads: 0, writes: 0, searches: 0, errs: 0, last: 0, added: 0, removed: 0 }
    out[e.file.path] = {
      reads: was.reads + (e.file.op === 'read' ? 1 : 0),
      writes: was.writes + (e.file.op === 'write' ? 1 : 0),
      searches: was.searches + (e.file.op === 'search' ? 1 : 0),
      errs: was.errs + (e.status === 'err' || e.status === 'block' ? 1 : 0),
      last: Math.max(was.last, e.endedAt ?? e.startedAt),
      added: (was.added ?? 0) + (e.file.added ?? 0),
      removed: (was.removed ?? 0) + (e.file.removed ?? 0),
    }
  }
  return out
}

const glow = (id: string, sd: number): string =>
  `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n1(sd * GLOW)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`

// ---- blocks ------------------------------------------------------------------------------------

/** A stretch of time in one short word: `40s`, `12m`, `5h`, `3d`. */
const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`)

/** Calls that failed or were refused: the session's count, never less than the failures still on the board. */
const failedOf = (board: Board): number => Math.max(board.failed ?? 0, board.entries.filter(e => (e.status === 'err' || e.status === 'block') && e.station !== 'you').length)

/** `12s ago`, `3m ago`: how long since a moment, in words. */
const ago = (ms: number): string => (ms < 1500 ? 'now' : `${span(ms)} ago`)

/**
 * The figures at the top, the most telling first: what it costs, how full the context is, how the turn goes, what
 * failed; then what changed, the tokens, the account's limit, the session. Each says what it is in plain words.
 */
function telemetry(c: Ctx, w: number, rows: 1 | 2): Block {
  const { board, now } = c
  const t = board.tokens
  const cachePct = t.input + t.cached > 0 ? Math.round((t.cached / (t.input + t.cached)) * 100) : 0
  const elapsed = board.startedAt !== undefined ? now - board.startedAt : 0
  const turn = board.turns[board.turns.length - 1]
  const turnMs = turn !== undefined ? (turn.endedAt ?? now) - turn.startedAt : 0
  const ctx = board.context ?? 0
  const ctxColor = ctx >= 90 ? ERR : ctx >= 70 ? AMBER : CYAN
  const calls = STATIONS.reduce((a, s) => a + (s.id === 'model' || s.id === 'you' ? 0 : (board.counts[s.id] ?? 0)), 0)
  const failed = failedOf(board)
  const files = Object.values(board.files)
  const edited = files.filter(f => f.writes > 0).length
  const added = files.reduce((a, f) => a + (f.added ?? 0), 0)
  const removed = files.reduce((a, f) => a + (f.removed ?? 0), 0)
  // The usage window nearest its limit.
  const limit = [...(board.limits ?? [])].sort((a, z) => z.percent - a.percent)[0]
  const isOnPlan = (board.limits ?? []).some(l => l.kind === 'five_hour' || l.kind === 'seven_day')
  const limitName = limit === undefined ? '' : limit.kind === 'five_hour' ? '5-hour limit' : limit.kind === 'seven_day' ? 'Weekly limit' : 'Spend limit'
  type Cell = { label: string; value: string; sub: string; color?: string; subColor?: string; gauge?: number }
  const all: Cell[] = [
    // The engine prices every request at API rates. On a subscription that is what the work was worth, not a charge:
    // the plan is limited by its usage windows, which have a cell of their own.
    { label: isOnPlan ? 'API value' : 'Cost', value: board.cost !== undefined ? `$${board.cost.toFixed(board.cost < 10 ? 3 : 2)}` : '—', sub: isOnPlan ? 'not billed' : 'whole session' },
    { label: 'Context used', value: `${ctx}%`, sub: '', color: ctxColor, gauge: ctx / 100 },
    { label: 'This turn', value: turn !== undefined ? formatMs(turnMs) : '—', sub: turn === undefined ? 'not started' : turn.endedAt === undefined ? `running · step ${board.step ?? 1}` : turn.aborted ? 'interrupted' : 'finished' },
    { label: 'Tool calls', value: `${calls}`, sub: failed > 0 ? `${failed} failed` : 'none failed', ...(failed > 0 ? { subColor: ERR } : {}) },
    { label: 'Files edited', value: `${edited}`, sub: added + removed > 0 ? `+${added} −${removed} lines` : `${files.filter(f => f.reads > 0).length} read` },
    { label: 'Tokens', value: formatTokens(t.input + t.cached + t.output), sub: `${cachePct}% cached` },
    limit !== undefined
      ? { label: limitName, value: `${Math.round(limit.percent)}%`, sub: limit.resetsAt !== undefined && limit.resetsAt > now ? `resets in ${span(limit.resetsAt - now)}` : 'of plan used', ...(limit.percent >= 90 ? { color: ERR } : limit.percent >= 70 ? { color: AMBER } : {}) }
      : { label: 'Model', value: board.model !== undefined ? shortModel(board.model) : '—', sub: `${board.counts.model ?? 0} requests`, color: AMBER },
    { label: joinedLate(board) ? 'Session age' : 'Session', value: elapsed > 0 ? formatMs(elapsed) : '—', sub: joinedLate(board) ? `watched ${span(now - (board.watchedFrom ?? now))}` : limit !== undefined && board.model !== undefined ? shortModel(board.model) : `${board.turns.length} turn${board.turns.length === 1 ? '' : 's'}` },
  ]
  const perRow = rows === 2 ? 4 : clamp(Math.floor(w / 104), 3, 8)
  const cells = all.slice(0, perRow * rows)
  const cw = w / perRow
  const ch = 50
  const big = cw >= 108 ? 18 : 15
  return {
    h: rows * ch + (rows - 1) * 6,
    draw: (x, y) =>
      cells
        .map((cell, i) => {
          const cx = x + (i % perRow) * cw
          const cy = y + Math.floor(i / perRow) * (ch + 6)
          let out = `<rect x="${n1(cx + 2)}" y="${n1(cy)}" width="${n1(cw - 4)}" height="${ch}" fill="${PANEL}"/>` + brackets(cx + 2, cy, cw - 4, ch, LINE, 5)
          out += `<text x="${n1(cx + 9)}" y="${n1(cy + 14)}" font-size="9.5" letter-spacing="1" fill="${DIM}">${esc(head(cell.label.toUpperCase(), fit(cw - 14, 10.2)))}</text>`
          // A value too long for the cell is set smaller before it is ever cut.
          const size = [big, 15, 13, 11.5].find(f => cell.value.length <= fit(cw - 14, f)) ?? 11.5
          out += `<text x="${n1(cx + 9)}" y="${n1(cy + 32)}" font-size="${size}" fill="${cell.color ?? INK}">${esc(head(cell.value, fit(cw - 14, size)))}</text>`
          if (cell.gauge !== undefined) {
            const segs = 16
            const gw = (cw - 22) / segs
            for (let k = 0; k < segs; k++) {
              out += `<rect x="${n1(cx + 9 + k * gw)}" y="${n1(cy + 39)}" width="${n1(Math.max(1, gw - 1.5))}" height="4" fill="${k < Math.round(cell.gauge * segs) ? (cell.color ?? CYAN) : GRID}"/>`
            }
          } else {
            out += `<text x="${n1(cx + 9)}" y="${n1(cy + 45)}" font-size="10" fill="${cell.subColor ?? DIM}">${esc(head(cell.sub, fit(cw - 14, 10)))}</text>`
          }
          return out
        })
        .join(''),
  }
}

/** Whether the session was already going when Work Atlas first ran in it: resumed, or the mod installed partway. */
const joinedLate = (board: Board): boolean => board.startedAt !== undefined && board.watchedFrom !== undefined && board.watchedFrom - board.startedAt > 120_000

/**
 * For a session Work Atlas joined late: which figures are of the whole session and which only of what it has watched.
 * Without it a lifetime cost stands beside a count of the last few minutes as if they measured the same thing.
 */
function scopeNote(c: Ctx, w: number): Block | undefined {
  const { board, now } = c
  if (!joinedLate(board)) return undefined
  const text = `This session began ${span(now - board.startedAt!)} ago. Work Atlas has watched the last ${span(now - board.watchedFrom!)}. ${board.cost !== undefined ? 'The dollar figure, context' : 'Context'} and usage limit cover the whole session; every other figure counts only what it has watched.`
  const perLine = fit(w - 16, 10)
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && last.length + 1 + word.length <= perLine) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return {
    h: 10 + lines.length * 13,
    draw: (x, y) =>
      `<rect x="${n1(x)}" y="${n1(y)}" width="3" height="${6 + lines.length * 13}" fill="${AMBER}"/>` +
      lines.map((line, i) => `<text x="${n1(x + 11)}" y="${n1(y + 12 + i * 13)}" font-size="10" fill="${DIM}">${esc(line)}</text>`).join(''),
  }
}

/** One line: what is happening now, in a sentence, and for how long. */
function statusBar(c: Ctx, w: number): Block {
  const live = c.running.filter(e => e.station !== 'model')
  const thinking = c.running.find(e => e.station === 'model' && e.from === 'core')
  const asking = live.find(e => e.mark === 'ask')
  const last = asking ?? live[live.length - 1]
  const turn = c.board.turns[c.board.turns.length - 1]
  const text =
    asking !== undefined
      ? 'Waiting for your answer'
      : last !== undefined
        ? `Running ${stationOf(last.station).name.toLowerCase()}: ${last.label}${live.length > 1 ? `  (+${live.length - 1} more)` : ''}`
        : thinking !== undefined
          ? 'Claude is thinking'
          : turn === undefined
            ? 'Ready: waiting for your first message'
            : 'Done: waiting for your next message'
  const since = last !== undefined ? formatMs(c.now - last.startedAt) : thinking !== undefined ? formatMs(c.now - thinking.startedAt) : ''
  const color = asking !== undefined ? WAIT : last !== undefined ? stationOf(last.station).color : thinking !== undefined ? AMBER : DIM
  const isBusy = last !== undefined || thinking !== undefined
  return {
    h: 24,
    draw: (x, y) =>
      `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="24" fill="${PANEL}" stroke="${LINE}"/>` +
      `<circle cx="${n1(x + 12)}" cy="${n1(y + 12)}" r="4" fill="${color}" filter="url(#g2)">${isBusy ? `<animate attributeName="opacity" values="1;.25;1" dur="1.2s" repeatCount="indefinite"/>` : ''}</circle>` +
      `<text x="${n1(x + 24)}" y="${n1(y + 16)}" font-size="12" fill="${isBusy ? INK : DIM}">${esc(head(text, fit(w - 36 - (since === '' ? 0 : since.length * 7 + 14), 12)))}</text>` +
      (since === '' ? '' : `<text x="${n1(x + w - 8)}" y="${n1(y + 16)}" text-anchor="end" font-size="11" fill="${color}">${esc(since)}</text>`),
  }
}

/** What went wrong in the window: the calls that failed or were refused, newest first. Shown only when there are any. */
function issues(c: Ctx, w: number, maxRows: number): Block | undefined {
  const bad = c.entries.filter(e => (e.status === 'err' || e.status === 'block') && e.station !== 'you')
  if (bad.length === 0 || maxRows < 1) return undefined
  const rows = bad.slice(-maxRows).reverse()
  return {
    h: 14 + 4 + rows.length * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Problems', `${c.isSession ? failedOf(c.board) : bad.length} failed · ${c.rangeLabel}`, ERR)]
      let yy = y + 16
      for (const e of rows) {
        yy += 16
        const what = `${e.status === 'block' ? 'blocked' : 'failed'} ${ago(c.now - (e.endedAt ?? e.startedAt))}`
        const room = fit(w - 76 - what.length * 6.6 - 10, 11)
        parts.push(`<text x="${n1(x)}" y="${n1(yy)}" font-size="11" fill="${ERR}">✕</text>`)
        parts.push(`<text x="${n1(x + 14)}" y="${n1(yy)}" font-size="10" letter-spacing=".6" fill="${ERR}">${esc(stationOf(e.station).name.toUpperCase())}</text>`)
        parts.push(`<text x="${n1(x + 76)}" y="${n1(yy)}" font-size="11" fill="${INK}">${esc(e.file !== undefined ? tailPath(e.file.path, room) : head(e.label, room))}</text>`)
        parts.push(`<text x="${n1(x + w)}" y="${n1(yy)}" text-anchor="end" font-size="10.5" fill="${DIM}">${esc(what)}</text>`)
      }
      return parts.join('')
    },
  }
}

/** The calls that took longest in the window: where to look when a turn felt slow. */
function slowest(c: Ctx, w: number, maxRows: number): Block | undefined {
  const rows = c.slow.slice(0, maxRows)
  if (rows.length === 0) return undefined
  const most = endOf(rows[0]!, c.now) - rows[0]!.startedAt
  return {
    h: 14 + 4 + rows.length * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Slowest calls', c.rangeLabel)]
      const barW = clamp(w * 0.16, 36, 90)
      let yy = y + 16
      for (const e of rows) {
        yy += 16
        const s = stationOf(e.station)
        const took = endOf(e, c.now) - e.startedAt
        parts.push(`<rect x="${n1(x)}" y="${n1(yy - 8)}" width="${n1(barW)}" height="8" fill="${GRID}"/>`)
        parts.push(`<rect x="${n1(x)}" y="${n1(yy - 8)}" width="${n1(Math.max(1, (took / most) * barW))}" height="8" fill="${e.status === 'err' || e.status === 'block' ? ERR : s.color}" opacity=".85"/>`)
        parts.push(`<text x="${n1(x + barW + 8)}" y="${n1(yy)}" font-size="10" letter-spacing=".6" fill="${s.color}">${esc(s.name.toUpperCase())}</text>`)
        parts.push(`<text x="${n1(x + barW + 72)}" y="${n1(yy)}" font-size="11" fill="${INK}">${esc(head(`${e.from === 'agents' ? '↳ ' : ''}${e.label}`, fit(w - barW - 72 - 62, 11)))}</text>`)
        parts.push(`<text x="${n1(x + w)}" y="${n1(yy)}" text-anchor="end" font-size="10.5" fill="${e.endedAt === undefined ? s.color : DIM}">${esc(formatMs(took))}${e.endedAt === undefined ? '…' : ''}</text>`)
      }
      return parts.join('')
    },
  }
}

/** The radar map, drawn to fill a box of any size. */
function radar(c: Ctx, w: number, h: number): Block {
  const { board, now, view } = c
  const focus = view.station
  const draw = (x: number, y0: number): string => {
    // A heading, like every section's, that says which window the counts are of.
    const heading = title(x, y0, w, 'Activity map', c.rangeLabel)
    const y = y0 + 16
    const hh = h - 16
    const k = clamp(Math.min(w / 400, hh / 400), 0.5, 1.7)
    const NODE = 18 * k
    const CORE = 40 * k
    const label = Math.max(8.5, 11 * k)
    const small = Math.max(8, 10 * k)
    const CX = x + w / 2
    const CY = y + hh / 2
    // A true circle: the largest that leaves room for the labels above, below and at the sides.
    const RY = Math.max(50, Math.min(hh / 2 - NODE - 30 * k, w / 2 - 48 * k))
    const RX = RY
    const C: Point = { x: CX, y: CY }
    const ringR = CORE + 22 * k
    const pointOf = (id: StationId): Point => {
      const i = STATIONS.findIndex(s => s.id === id)
      const a = (i * 2 * Math.PI) / STATIONS.length
      return { x: CX + RX * Math.sin(a), y: CY - RY * Math.cos(a) }
    }
    const parts: string[] = []

    // Grid: rings, crosshair, degree ticks.
    for (const f of [0.38, 0.69, 1]) parts.push(`<ellipse cx="${n1(CX)}" cy="${n1(CY)}" rx="${n1(RX * f)}" ry="${n1(RY * f)}" fill="none" stroke="${GRID}" stroke-width="1" ${f === 1 ? '' : 'stroke-dasharray="2 4"'}/>`)
    parts.push(`<path d="M${n1(CX - RX - 8)} ${n1(CY)}H${n1(CX + RX + 8)}M${n1(CX)} ${n1(CY - RY - 8)}V${n1(CY + RY + 8)}" stroke="${GRID}" stroke-width="1"/>`)
    let ticks = ''
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * 2 * Math.PI
      const r0 = i % 6 === 0 ? 0.955 : 0.975
      ticks += `M${n1(CX + RX * r0 * Math.sin(a))} ${n1(CY - RY * r0 * Math.cos(a))}L${n1(CX + RX * Math.sin(a))} ${n1(CY - RY * Math.cos(a))}`
    }
    parts.push(`<path d="${ticks}" stroke="${LINE}" stroke-width="1"/>`)

    // Radar sweep: one turn every eight seconds, carried on across redraws.
    const sweepBegin = -((now / 1000) % 8)
    parts.push(
      `<g><path d="M${n1(CX)} ${n1(CY)}L${n1(CX)} ${n1(CY - RY)}A${n1(RX)} ${n1(RY)} 0 0 1 ${n1(CX + RX * Math.sin(0.6))} ${n1(CY - RY * Math.cos(0.6))}Z" fill="url(#sweep)" opacity=".55"/>` +
        `<line x1="${n1(CX)}" y1="${n1(CY)}" x2="${n1(CX)}" y2="${n1(CY - RY)}" stroke="${CYAN}" stroke-opacity=".5" stroke-width="1"/>` +
        `<animateTransform attributeName="transform" type="rotate" from="0 ${n1(CX)} ${n1(CY)}" to="360 ${n1(CX)} ${n1(CY)}" dur="8s" begin="${sweepBegin.toFixed(2)}s" repeatCount="indefinite"/></g>`,
    )

    // Time ring: each station's share of busy time in the window.
    const busy = Math.max(1, ORDER.filter(o => o !== 'idle').reduce((a, o) => a + (c.bd.parts[o] ?? 0), 0))
    let a0 = 0
    parts.push(`<circle cx="${n1(CX)}" cy="${n1(CY)}" r="${n1(ringR)}" fill="none" stroke="${GRID}" stroke-width="${n1(5 * k)}"/>`)
    for (const o of ORDER) {
      if (o === 'idle') continue
      const share = (c.bd.parts[o] ?? 0) / busy
      if (share < 0.004) continue
      const a1 = a0 + share * 2 * Math.PI
      parts.push(`<path d="${arcPath(C, ringR, a0 + 0.02, Math.max(a0 + 0.03, a1 - 0.02))}" fill="none" stroke="${categoryColor(o)}" stroke-width="${n1(5 * k)}" opacity="${focus !== undefined && focus !== o ? 0.3 : 0.9}"/>`)
      a0 = a1
    }

    // Spokes, worn by use.
    const most = Math.max(1, ...STATIONS.map(s => c.counts[s.id] ?? 0))
    for (const s of STATIONS) {
      const p = pointOf(s.id)
      const count = c.counts[s.id] ?? 0
      const a = towards(C, p, ringR + 6 * k)
      const b = towards(p, C, NODE + 3)
      const width = (0.8 + Math.min(3, Math.log2(1 + count) * 0.6)) * Math.max(0.7, k)
      const op = count === 0 ? 0.5 : 0.25 + 0.6 * (count / most)
      parts.push(`<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke="${count === 0 ? GRID : s.color}" stroke-width="${n1(width)}" stroke-opacity="${n1(c.isDim(s.id) ? op * 0.25 : op)}"/>`)
    }

    // A dashed trail linking the kinds of work used most recently, fading with age.
    const legs = board.entries
      .filter(e => e.from === 'core' && e.station !== 'model' && e.station !== 'you' && now - e.startedAt < 60_000)
      .reduce<Entry[]>((acc, e) => (acc[acc.length - 1]?.station === e.station ? acc : [...acc, e]), [])
      .slice(-6)
    for (let i = 1; i < legs.length; i++) {
      const p0 = pointOf(legs[i - 1]!.station)
      const p1 = pointOf(legs[i]!.station)
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
      const ctl = { x: mid.x + (CX - mid.x) * 0.5, y: mid.y + (CY - mid.y) * 0.5 }
      const op = Math.max(0, 0.8 * (1 - (now - legs[i]!.startedAt) / 60_000)) * (i / (legs.length - 1))
      if (op < 0.05) continue
      parts.push(`<path d="M${n1(p0.x)} ${n1(p0.y)}Q${n1(ctl.x)} ${n1(ctl.y)} ${n1(p1.x)} ${n1(p1.y)}" fill="none" stroke="${CYAN}" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="${n1(op)}"/>`)
    }

    // Pulses: looping out while a call runs, one flash back when it ends.
    const flight = (from: Point, to: Point, color: string, age: number, dur: number, loop: boolean, r: number): string => {
      const path = `M${n1(from.x)} ${n1(from.y)}L${n1(to.x)} ${n1(to.y)}`
      const timing = `begin="${sec(loop ? -(age % dur) : -age)}" dur="${sec(dur)}" ${loop ? 'repeatCount="indefinite"' : 'fill="freeze"'}`
      return `<circle r="${n1(r * k)}" fill="${color}" opacity="0" filter="url(#g2)"><animateMotion path="${path}" ${timing}/><animate attributeName="opacity" values="1;1;0" keyTimes="0;.85;1" ${timing}/></circle>`
    }
    const perStation = new Map<StationId, number>()
    for (const e of c.running) {
      if (e.mark === 'ask') continue
      const n = perStation.get(e.station) ?? 0
      perStation.set(e.station, n + 1)
      if (n >= 3) continue
      const origin = e.from === 'agents' ? pointOf('agents') : C
      const dest = pointOf(e.station)
      parts.push(`<g opacity="${c.isDim(e.station) ? 0.25 : 1}">${flight(towards(origin, dest, e.from === 'agents' ? NODE + 3 : ringR + 6 * k), towards(dest, origin, NODE + 3), stationOf(e.station).color, now - e.startedAt + n * 350, 1300, true, 3)}</g>`)
    }
    for (const e of board.entries) {
      if (e.endedAt === undefined || e.from === 'inbound' || e.endedAt === e.startedAt || now - e.endedAt > 900) continue
      const origin = e.from === 'agents' ? pointOf('agents') : C
      const dest = pointOf(e.station)
      parts.push(flight(towards(dest, origin, NODE + 3), towards(origin, dest, ringR + 6 * k), e.status === 'ok' ? stationOf(e.station).color : ERR, now - e.endedAt, 800, false, 2.4))
    }

    // Stations: hexagons with their figures.
    const st = statsOf(board.entries, { from: 0, to: now }, now)
    for (const s of STATIONS) {
      const p = pointOf(s.id)
      const stat = st.get(s.id)
      const count = c.counts[s.id] ?? 0
      const faults = board.faults[s.id] ?? 0
      const liveHere = c.running.filter(e => e.station === s.id).length
      const isFocus = focus === s.id
      const stroke = faults > 0 ? ERR : liveHere > 0 || isFocus ? s.color : count > 0 ? LINE : GRID
      parts.push(`<g opacity="${c.isDim(s.id) ? 0.3 : 1}">`)
      if (liveHere > 0) parts.push(`<path d="${hexagon(p, NODE + 7 * k)}" fill="none" stroke="${s.color}" stroke-width="1"><animate attributeName="stroke-opacity" values=".7;.1;.7" dur="1.6s" repeatCount="indefinite"/></path>`)
      parts.push(`<path d="${hexagon(p, NODE)}" fill="${PANEL}" stroke="${stroke}" stroke-width="${isFocus ? 2.4 : liveHere > 0 ? 1.8 : 1.2}" ${liveHere > 0 ? 'filter="url(#g2)"' : ''}/>`)
      const iconColor = faults > 0 ? ERR : count > 0 || liveHere > 0 ? s.color : FAINT
      parts.push(`<g transform="translate(${n1(p.x - 8 * k)} ${n1(p.y - 8 * k)}) scale(${n1(k)})" fill="none" stroke="${iconColor}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.id]}</g>`)
      // Labels under each node; the upper nodes keep theirs above, off the spoke that runs down to the core.
      const lx = clamp(p.x, x + 34, x + w - 34)
      const ly = p.y < CY - RY * 0.5 ? p.y - NODE - small - 5 : p.y + NODE + label
      parts.push(`<text x="${n1(lx)}" y="${n1(ly)}" text-anchor="middle" font-size="${n1(label)}" letter-spacing="1" fill="${count > 0 ? INK : DIM}">${esc(s.name.toUpperCase())}</text>`)
      const unit = s.id === 'you' ? 'message' : s.id === 'model' ? 'request' : 'call'
      const figure = count === 0 ? '' : liveHere > 0 ? `${liveHere} running` : `${count} ${unit}${count === 1 ? '' : 's'}`
      parts.push(`<text x="${n1(lx)}" y="${n1(ly + small + 1)}" text-anchor="middle" font-size="${n1(small)}" fill="${liveHere > 0 ? s.color : DIM}">${esc(figure)}</text>`)
      if (faults > 0) {
        const b = { x: p.x + NODE * 0.85, y: p.y - NODE * 0.8 }
        parts.push(`<circle cx="${n1(b.x)}" cy="${n1(b.y)}" r="${n1(7 * k)}" fill="${ERR}" filter="url(#g2)"/><text x="${n1(b.x)}" y="${n1(b.y + 3.2 * k)}" text-anchor="middle" font-size="${n1(9 * k)}" fill="#fff">${faults}</text>`)
      }
      if (s.id === 'agents') {
        board.agents.slice(0, 8).forEach((_, i) => {
          const begin = -((now / 1000 + i * 0.5) % 4)
          parts.push(
            `<circle cx="${n1(p.x)}" cy="${n1(p.y - NODE - 5 * k)}" r="${n1(2.2 * k)}" fill="${s.color}" filter="url(#g2)">` +
              `<animateTransform attributeName="transform" type="rotate" from="${i * 45} ${n1(p.x)} ${n1(p.y)}" to="${i * 45 + 360} ${n1(p.x)} ${n1(p.y)}" dur="4s" begin="${begin.toFixed(2)}s" repeatCount="indefinite"/></circle>`,
          )
        })
      }
      parts.push(`</g>`)
    }

    // Core: segmented context ring, name, state.
    const ctx = board.context ?? 0
    const ctxColor = ctx >= 90 ? ERR : ctx >= 70 ? AMBER : CYAN
    const segs = 48
    let on = ''
    let off = ''
    for (let i = 0; i < segs; i++) {
      const d = arcPath(C, CORE + 9 * k, (i / segs) * 2 * Math.PI + 0.02, ((i + 1) / segs) * 2 * Math.PI - 0.02)
      if (i < Math.round((ctx / 100) * segs)) on += d
      else off += d
    }
    if (off !== '') parts.push(`<path d="${off}" fill="none" stroke="${GRID}" stroke-width="${n1(4 * k)}"/>`)
    if (on !== '') parts.push(`<path d="${on}" fill="none" stroke="${ctxColor}" stroke-width="${n1(4 * k)}"/>`)
    const live = c.running.filter(e => e.station !== 'model')
    const thinking = c.running.some(e => e.station === 'model')
    const isSwitch = board.switchedAt !== undefined && now - board.switchedAt < 8_000
    parts.push(`<circle cx="${n1(CX)}" cy="${n1(CY)}" r="${n1(CORE)}" fill="${PANEL}" stroke="${isSwitch ? AMBER : CYAN}" stroke-width="${isSwitch ? 2 : 1.2}" filter="url(#g3)"/>`)
    if (thinking) {
      parts.push(`<circle cx="${n1(CX)}" cy="${n1(CY)}" r="${n1(CORE - 5 * k)}" fill="none" stroke="${AMBER}" stroke-opacity=".6" stroke-dasharray="1 3"><animateTransform attributeName="transform" type="rotate" from="0 ${n1(CX)} ${n1(CY)}" to="360 ${n1(CX)} ${n1(CY)}" dur="6s" begin="${(-((now / 1000) % 6)).toFixed(2)}s" repeatCount="indefinite"/></circle>`)
    }
    const lastDone = [...board.entries].reverse().find(e => e.mark === 'done')
    if (lastDone !== undefined && now - lastDone.startedAt < 1_500) {
      const b = sec(-(now - lastDone.startedAt))
      parts.push(`<circle cx="${n1(CX)}" cy="${n1(CY)}" r="${n1(CORE)}" fill="none" stroke="${CYAN}" stroke-width="2" opacity="0"><animate attributeName="r" values="${n1(CORE)};${n1(RX)}" begin="${b}" dur="1.5s" fill="freeze"/><animate attributeName="opacity" values=".9;0" begin="${b}" dur="1.5s" fill="freeze"/></circle>`)
    }
    parts.push(`<text x="${n1(CX)}" y="${n1(CY - 14 * k)}" text-anchor="middle" font-size="${n1(Math.max(6, 9.5 * k))}" letter-spacing="1.2" fill="${ctxColor}">${ctx}%</text>`)
    parts.push(`<text x="${n1(CX)}" y="${n1(CY + 5 * k)}" text-anchor="middle" font-size="${n1(16 * k)}" letter-spacing="${n1(1.6 * k)}" fill="${INK}" filter="url(#g1)">${esc(c.core)}</text>`)
    parts.push(`<text x="${n1(CX)}" y="${n1(CY + 19 * k)}" text-anchor="middle" font-size="${n1(Math.max(6, 9.5 * k))}" letter-spacing="1" fill="${live.length > 0 ? CYAN : thinking ? AMBER : DIM}">${live.length > 0 ? `${live.length} RUNNING` : thinking ? 'THINKING' : 'IDLE'}</text>`)
    return heading + parts.join('')
  }
  return { h, draw }
}

/** The most tool calls running at the same moment in each of `columns` equal stretches of the window. */
export function atOnce(entries: readonly Entry[], win: Window, columns: number, now: number): number[] {
  const out = Array.from({ length: columns }, () => 0)
  const span = Math.max(1, win.to - win.from)
  const edges: [number, number][] = []
  for (const e of entries) {
    if (e.station === 'model' || e.mark !== undefined || e.from === 'inbound') continue
    const from = Math.max(e.startedAt, win.from)
    const to = Math.min(endOf(e, now), win.to)
    if (to > from) edges.push([from, 1], [to, -1])
  }
  edges.sort((a, z) => a[0] - z[0] || a[1] - z[1])
  let running = 0
  let at = win.from
  for (const [t, delta] of edges) {
    if (running > 0 && t > at) {
      const first = Math.floor(((at - win.from) / span) * columns)
      const last = Math.min(columns - 1, Math.floor(((t - 1 - win.from) / span) * columns))
      for (let i = Math.max(0, first); i <= last; i++) out[i] = Math.max(out[i]!, running)
    }
    at = Math.max(at, t)
    running += delta
  }
  return out
}

/**
 * One lane of the record, drawn as bars: time is cut into columns two units wide, each as strong as its station was
 * busy in it, red where a call failed; neighbours alike are drawn as one bar. Every call the record holds shows.
 */
function recordLane(h: NonNullable<Board['history']>, id: StationId, color: string, win: Window, left: number, plot: number, y: number, lane: number): string {
  const busy = h.busy[id]
  if (busy === undefined) return ''
  const faults = h.faults[id] ?? []
  const span = Math.max(1, win.to - win.from)
  const cols = Math.max(1, Math.floor(plot / 2))
  const colMs = span / cols
  type Run = { from: number; to: number; level: number; isFault: boolean }
  const runs: Run[] = []
  for (let col = 0; col < cols; col++) {
    const t0 = win.from + col * colMs
    const t1 = t0 + colMs
    const first = Math.max(0, Math.floor((t0 - h.from) / h.sliceMs))
    const last = Math.min(busy.length - 1, Math.floor((t1 - 1 - h.from) / h.sliceMs))
    let ms = 0
    let isFault = false
    for (let k = first; k <= last; k++) {
      // A slice wider than a column gives each column its share.
      const s0 = h.from + k * h.sliceMs
      const share = Math.max(0, Math.min(t1, s0 + h.sliceMs) - Math.max(t0, s0)) / h.sliceMs
      ms += (busy[k] ?? 0) * share
      if ((faults[k] ?? 0) > 0 && (busy[k] ?? 0) > 0) isFault = true
    }
    if (ms <= 0) continue
    const level = ms / colMs >= 0.6 ? 3 : ms / colMs >= 0.2 ? 2 : 1
    const prev = runs[runs.length - 1]
    if (prev !== undefined && prev.to === col && prev.level === level && prev.isFault === isFault) prev.to = col + 1
    else runs.push({ from: col, to: col + 1, level, isFault })
  }
  return runs
    .map(r => `<rect x="${n1(left + (r.from / cols) * plot)}" y="${n1(y + 3)}" width="${n1(Math.max(1.5, ((r.to - r.from) / cols) * plot))}" height="${lane - 9}" fill="${r.isFault ? ERR : color}" fill-opacity="${r.level === 3 ? 0.85 : r.level === 2 ? 0.6 : 0.4}"/>`)
    .join('')
}

/** Lanes of calls over the window, and under them how many ran at once. */
function timeline(c: Ctx, w: number, withParallel: boolean, LANE = 17): Block {
  const { board, now, window: win, view } = c
  const span = Math.max(1, win.to - win.from)
  const inWindow = board.entries.filter(e => endOf(e, now) >= win.from && e.startedAt <= win.to && e.mark !== 'switch')
  // The session's calls that are no longer kept one by one are in the record: their lanes are drawn from it.
  const past = c.isSession ? c.board.history : undefined
  const recorded = new Set(stationsIn(past))
  const lanes = STATIONS.filter(s => recorded.has(s.id) || inWindow.some(e => e.station === s.id))
  const lanesH = Math.max(1, lanes.length) * LANE
  const cH = withParallel ? Math.round(LANE * 1.6) : 0
  const h = 14 + 16 + lanesH + (withParallel ? 6 + cH : 0)
  const draw = (x: number, y: number): string => {
    const parts: string[] = [title(x, y, w, 'Timeline', `${c.rangeLabel} · ${formatMs(span)}`)]
    const LEFT = x + 66
    const plot = w - 66
    const px = (t: number): number => LEFT + ((clamp(t, win.from, win.to) - win.from) / span) * plot
    const top = y + 30
    const bottom = top + lanesH + (withParallel ? 6 + cH : 0)
    parts.push(`<rect x="${n1(LEFT)}" y="${n1(top)}" width="${n1(plot)}" height="${lanesH}" fill="${PANEL}"/>`)
    const step = tickStep(span, Math.max(2, Math.floor(plot / 80)))
    for (let t = win.to; t >= win.from - 1; t -= step) {
      const ago = win.to - t
      parts.push(`<line x1="${n1(px(t))}" y1="${n1(top)}" x2="${n1(px(t))}" y2="${n1(bottom)}" stroke="${GRID}" stroke-width="1"/>`)
      parts.push(`<text x="${n1(px(t))}" y="${n1(top - 4)}" text-anchor="${ago === 0 ? 'end' : 'middle'}" font-size="9.5" fill="${DIM}">${ago === 0 ? (win.to >= now - 50 ? 'NOW' : 'END') : `-${tickLabel(ago)}`}</text>`)
    }
    for (const tr of board.turns) {
      if (tr.startedAt < win.from || tr.startedAt > win.to) continue
      parts.push(`<line x1="${n1(px(tr.startedAt))}" y1="${n1(top)}" x2="${n1(px(tr.startedAt))}" y2="${n1(top + lanesH)}" stroke="${AMBER}" stroke-opacity=".6" stroke-dasharray="2 2"/>`)
    }
    lanes.forEach((s, i) => {
      const ly = top + i * LANE
      parts.push(`<g opacity="${c.isDim(s.id) ? 0.3 : 1}">`)
      parts.push(`<text x="${n1(LEFT - 6)}" y="${n1(ly + LANE / 2 + 3.5)}" text-anchor="end" font-size="10" letter-spacing=".6" fill="${view.station === s.id ? s.color : DIM}">${esc(s.name.toUpperCase())}</text>`)
      parts.push(`<line x1="${n1(LEFT)}" y1="${n1(ly + LANE)}" x2="${n1(LEFT + plot)}" y2="${n1(ly + LANE)}" stroke="${GRID}" stroke-width=".5"/>`)
      if (past !== undefined) parts.push(recordLane(past, s.id, s.color, win, LEFT, plot, ly, LANE))
      const mine = inWindow.filter(e => e.station === s.id)
      const kept = mine.length > 160 ? [...mine].sort((a, b) => endOf(b, now) - b.startedAt - (endOf(a, now) - a.startedAt)).slice(0, 160) : mine
      for (const e of kept) {
        const color = e.status === 'err' || e.status === 'block' ? ERR : s.color
        if (!hasSpan(e, now)) {
          parts.push(`<path d="M${n1(px(e.startedAt))} ${n1(ly + LANE / 2 - 5)}l3 5-3 5-3-5z" fill="${color}"/>`)
          continue
        }
        const x0 = px(e.startedAt)
        const wpx = Math.max(1.5, px(endOf(e, now)) - x0)
        const isSub = e.from === 'agents'
        const isRun = e.status === 'run'
        const grow = isRun && win.to >= now - 50 ? `<animate attributeName="width" from="${n1(wpx)}" to="${n1(wpx + (plot / span) * 10_000)}" dur="10s" fill="freeze"/>` : ''
        const fill = e.mark === 'ask' ? 0.2 : isRun ? 1 : isSub ? 0.5 : 0.85
        parts.push(
          `<rect x="${n1(x0)}" y="${n1(isSub ? ly + LANE - 6 : ly + 3)}" width="${n1(wpx)}" height="${isSub ? 4 : LANE - 9}" fill="${color}" fill-opacity="${fill}"` +
            (e.mark === 'ask' ? ` stroke="${color}" stroke-dasharray="2 1.5"` : '') +
            (isRun ? ` filter="url(#g2)"` : '') +
            (grow === '' ? '/>' : `>${grow}</rect>`),
        )
      }
      parts.push(`</g>`)
    })
    if (lanes.length === 0) parts.push(`<text x="${n1(LEFT + plot / 2)}" y="${n1(top + 12)}" text-anchor="middle" font-size="10" fill="${DIM}">NO ACTIVITY IN WINDOW</text>`)

    if (withParallel) {
      const cTop = top + lanesH + 6
      const buckets = clamp(Math.floor(plot / 3), 30, 160)
      // The most tool calls truly running at the same moment in each column: a sweep over the calls' starts and ends,
      // not a count of the calls that touch the column. Where calls are no longer kept, the record's own peaks.
      const conc = atOnce(inWindow, win, buckets, now)
      if (past !== undefined) {
        for (let i = 0; i < buckets; i++) {
          const t0 = win.from + (i / buckets) * span
          const t1 = win.from + ((i + 1) / buckets) * span
          const first = Math.max(0, Math.floor((t0 - past.from) / past.sliceMs))
          const last = Math.min(past.peak.length - 1, Math.floor((t1 - 1 - past.from) / past.sliceMs))
          for (let k = first; k <= last; k++) conc[i] = Math.max(conc[i] ?? 0, past.peak[k] ?? 0)
        }
      }
      const cMax = Math.max(2, ...conc)
      let area = `M${n1(LEFT)} ${n1(cTop + cH)}`
      conc.forEach((v, i) => {
        const yy = cTop + cH - (v / cMax) * cH
        area += `L${n1(LEFT + (i / buckets) * plot)} ${n1(yy)}L${n1(LEFT + ((i + 1) / buckets) * plot)} ${n1(yy)}`
      })
      area += `L${n1(LEFT + plot)} ${n1(cTop + cH)}Z`
      parts.push(`<text x="${n1(LEFT - 6)}" y="${n1(cTop + 11)}" text-anchor="end" font-size="10" letter-spacing=".6" fill="${DIM}">AT ONCE</text>`)
      parts.push(`<text x="${n1(LEFT - 6)}" y="${n1(cTop + 23)}" text-anchor="end" font-size="10" fill="${DIM}">peak ${Math.max(...conc)}</text>`)
      parts.push(`<path d="${area}" fill="url(#concFill)" stroke="${CYAN}" stroke-width="1"/>`)
    }
    if (win.to >= now - 50) {
      parts.push(`<line x1="${n1(LEFT + plot)}" y1="${n1(top - 1)}" x2="${n1(LEFT + plot)}" y2="${n1(bottom)}" stroke="${CYAN}" stroke-width="1.5" filter="url(#g2)"><animate attributeName="stroke-opacity" values="1;.3;1" dur="1.5s" repeatCount="indefinite"/></line>`)
    }
    return parts.join('')
  }
  return { h, draw }
}

/** One stacked bar of where the window's time went, and its legend. */
function timeSplit(c: Ctx, w: number): Block {
  // The stretch the parts add up to: the window, or for the session everything its turns and waits came to.
  const span = Math.max(1, c.bd.span)
  const pct = (ms: number): number => Math.round((ms / span) * 100)
  const shown = ORDER.filter(o => (c.bd.parts[o] ?? 0) > span * 0.002)
  const cols = clamp(Math.floor(w / 150), 2, 5)
  const legendRows = Math.ceil(shown.length / cols)
  return {
    h: 14 + 8 + 8 + 6 + legendRows * 16,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Where the time went', c.bd.busy > 0 ? `${pct(c.bd.busy)}% working` : '')]
      let bx = x
      for (const o of shown) {
        const wpx = ((c.bd.parts[o] ?? 0) / span) * w
        parts.push(`<rect x="${n1(bx)}" y="${n1(y + 22)}" width="${n1(Math.max(0.5, wpx - 1))}" height="8" fill="${categoryColor(o)}" opacity="${c.view.station !== undefined && c.view.station !== o ? 0.3 : 0.9}"/>`)
        bx += wpx
      }
      const colW = w / cols
      shown.forEach((o, i) => {
        const lx = x + (i % cols) * colW
        const ly = y + 36 + Math.floor(i / cols) * 16 + 11
        parts.push(`<rect x="${n1(lx)}" y="${n1(ly - 8)}" width="8" height="8" fill="${categoryColor(o)}"/>`)
        parts.push(`<text x="${n1(lx + 12)}" y="${n1(ly)}" font-size="10.5" fill="${INK}">${esc(head(categoryName(o), fit(colW - 52, 10.5)))}</text>`)
        parts.push(`<text x="${n1(lx + colW - 8)}" y="${n1(ly)}" text-anchor="end" font-size="10.5" fill="${DIM}">${pct(c.bd.parts[o] ?? 0)}%</text>`)
      })
      return parts.join('')
    },
  }
}

/** A table: each station's calls, failures and times in the window. */
function stationTable(c: Ctx, w: number): Block | undefined {
  const ws = c.stats
  const rows = STATIONS.filter(s => ws.has(s.id))
  if (rows.length === 0) return undefined
  const isNarrow = w < 400
  const cols = isNarrow
    ? [{ label: 'CALLS', f: 0.42 }, { label: 'FAILED', f: 0.58 }, { label: 'TIME', f: 0.76 }]
    : [{ label: 'CALLS', f: 0.3 }, { label: 'FAILED', f: 0.41 }, { label: 'TIME', f: 0.52 }, { label: 'AVERAGE', f: 0.65 }, { label: 'SLOWEST', f: 0.78 }]
  const barX = 0.81
  return {
    h: 14 + 16 + rows.length * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Activity by type', c.rangeLabel)]
      let yy = y + 28
      parts.push(`<text x="${n1(x)}" y="${n1(yy)}" font-size="9.5" letter-spacing="1" fill="${DIM}">TYPE</text>`)
      for (const col of cols) parts.push(`<text x="${n1(x + w * col.f)}" y="${n1(yy)}" text-anchor="end" font-size="9.5" letter-spacing="1" fill="${DIM}">${col.label}</text>`)
      parts.push(`<text x="${n1(x + w * barX)}" y="${n1(yy)}" font-size="9.5" letter-spacing="1" fill="${DIM}">SHARE</text>`)
      const maxTotal = Math.max(1, ...rows.map(s => ws.get(s.id)!.total))
      for (const s of rows) {
        const v = ws.get(s.id)!
        yy += 16
        const cells = isNarrow ? [String(v.calls), v.fails > 0 ? String(v.fails) : '·', formatMs(v.total)] : [String(v.calls), v.fails > 0 ? String(v.fails) : '·', formatMs(v.total), formatMs(v.total / Math.max(1, v.calls)), formatMs(v.max)]
        parts.push(`<g opacity="${c.isDim(s.id) ? 0.35 : 1}">`)
        parts.push(`<rect x="${n1(x)}" y="${n1(yy - 10)}" width="3" height="11" fill="${s.color}"/>`)
        parts.push(`<text x="${n1(x + 8)}" y="${n1(yy)}" font-size="11" fill="${INK}">${esc(s.name)}${v.running > 0 ? `<tspan fill="${s.color}"> ▶${v.running}</tspan>` : ''}</text>`)
        cells.forEach((txt, i) => {
          parts.push(`<text x="${n1(x + w * cols[i]!.f)}" y="${n1(yy)}" text-anchor="end" font-size="11" fill="${i === 1 && v.fails > 0 ? ERR : i === 0 ? INK : DIM}">${esc(txt)}</text>`)
        })
        const bw = w * (1 - barX)
        parts.push(`<rect x="${n1(x + w * barX)}" y="${n1(yy - 8)}" width="${n1(bw)}" height="8" fill="${GRID}"/>`)
        parts.push(`<rect x="${n1(x + w * barX)}" y="${n1(yy - 8)}" width="${n1(Math.max(1, (v.total / maxTotal) * bw))}" height="8" fill="${s.color}" opacity=".85"/>`)
        parts.push(`</g>`)
      }
      return parts.join('')
    },
  }
}

/** The files worked on most, as a table: how often each was edited and read, the lines changed, and when last. */
function fileHeat(c: Ctx, w: number, maxRows: number): Block | undefined {
  const files = Object.entries(c.files)
    .map(([path, f]) => ({ path, f, score: f.writes * 2 + f.reads + f.searches }))
    .sort((a, z) => z.score - a.score || z.f.last - a.f.last)
  if (files.length === 0 || maxRows < 1) return undefined
  const top = files.slice(0, maxRows)
  const edited = files.filter(r => r.f.writes > 0).length
  // Columns, from the left: a bar, EDITS, READS, then LINES and LAST where the pane is wide enough, then the file.
  const barW = clamp(w * 0.14, 30, 80)
  const hasLines = w >= 430
  const hasLast = w >= 520
  const xEdits = barW + 44
  const xReads = xEdits + 44
  const xLines = xReads + 78
  const xLast = (hasLines ? xLines : xReads) + 62
  const xPath = (hasLast ? xLast : hasLines ? xLines : xReads) + 12
  return {
    h: 14 + 16 + top.length * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Files touched', `${edited} edited · ${c.rangeLabel}${c.isSession && (c.board.filesDropped ?? 0) > 0 ? ` · ${c.board.filesDropped} older not listed` : ''}`)]
      let yy = y + 28
      const headAt = (hx: number, text: string, anchor = 'end'): string => `<text x="${n1(x + hx)}" y="${n1(yy)}" text-anchor="${anchor}" font-size="9.5" letter-spacing="1" fill="${DIM}">${text}</text>`
      parts.push(headAt(xEdits, 'EDITS') + headAt(xReads, 'READS') + (hasLines ? headAt(xLines, 'LINES') : '') + (hasLast ? headAt(xLast, 'LAST') : '') + headAt(xPath, 'FILE', 'start'))
      const most = Math.max(1, ...top.map(r => r.f.reads + r.f.writes))
      for (const r of top) {
        yy += 16
        const ww = (r.f.writes / most) * barW
        const rw = (r.f.reads / most) * barW
        parts.push(`<rect x="${n1(x)}" y="${n1(yy - 8)}" width="${n1(barW)}" height="8" fill="${GRID}"/>`)
        if (ww > 0) parts.push(`<rect x="${n1(x)}" y="${n1(yy - 8)}" width="${n1(ww)}" height="8" fill="${AMBER}"/>`)
        if (rw > 0) parts.push(`<rect x="${n1(x + ww)}" y="${n1(yy - 8)}" width="${n1(rw)}" height="8" fill="${stationOf('files').color}" opacity=".85"/>`)
        parts.push(`<text x="${n1(x + xEdits)}" y="${n1(yy)}" text-anchor="end" font-size="11" fill="${r.f.writes > 0 ? AMBER : FAINT}">${r.f.writes > 0 ? r.f.writes : '·'}</text>`)
        parts.push(`<text x="${n1(x + xReads)}" y="${n1(yy)}" text-anchor="end" font-size="11" fill="${r.f.reads > 0 ? stationOf('files').color : FAINT}">${r.f.reads > 0 ? r.f.reads : '·'}</text>`)
        if (hasLines) {
          const changed = (r.f.added ?? 0) + (r.f.removed ?? 0) > 0
          parts.push(`<text x="${n1(x + xLines)}" y="${n1(yy)}" text-anchor="end" font-size="10.5" fill="${changed ? INK : FAINT}">${changed ? `+${r.f.added ?? 0} −${r.f.removed ?? 0}` : '·'}</text>`)
        }
        if (hasLast) parts.push(`<text x="${n1(x + xLast)}" y="${n1(yy)}" text-anchor="end" font-size="10.5" fill="${DIM}">${esc(ago(c.now - r.f.last))}</text>`)
        parts.push(`<text x="${n1(x + xPath)}" y="${n1(yy)}" font-size="11" fill="${r.f.errs > 0 ? ERR : INK}">${esc(tailPath(r.path, fit(w - xPath - (r.f.errs > 0 ? 60 : 0), 11)))}${r.f.errs > 0 ? `<tspan fill="${ERR}" font-size="10">  ✕ ${r.f.errs} failed</tspan>` : ''}</text>`)
      }
      return parts.join('')
    },
  }
}

/** Subagents still at work: which one, what it is doing now, how many calls it has made and for how long. */
function subagents(c: Ctx, w: number): Block | undefined {
  const ids = c.board.agents.slice(0, 5)
  if (ids.length === 0) return undefined
  return {
    h: 14 + 4 + ids.length * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Subagents', `${c.board.agents.length} running`)]
      let yy = y + 16
      ids.forEach((id, i) => {
        const theirs = c.board.entries.filter(e => e.agentId === id)
        const first = theirs[0]
        const last = [...theirs].reverse().find(e => e.station !== 'model') ?? theirs[theirs.length - 1]
        const tools = theirs.filter(e => e.station !== 'model').length
        // The Agent call that started it carries the task's own description.
        const task = c.board.entries.find(e => e.task === id || (e.station === 'agents' && e.status === 'run' && e.agentId === undefined && first !== undefined && Math.abs(e.startedAt - first.startedAt) < 3000))
        yy += 16
        const right = `${tools} call${tools === 1 ? '' : 's'} · ${first !== undefined ? formatMs(c.now - first.startedAt) : ''}`
        parts.push(`<circle cx="${n1(x + 4)}" cy="${n1(yy - 4)}" r="2.5" fill="${stationOf('agents').color}"><animate attributeName="opacity" values="1;.3;1" dur="1.4s" repeatCount="indefinite"/></circle>`)
        parts.push(`<text x="${n1(x + 12)}" y="${n1(yy)}" font-size="11" fill="${INK}">${esc(head(c.board.agentNames?.[id] ?? (task !== undefined ? task.label : `Agent ${i + 1}`), fit(w * 0.36, 11)))}</text>`)
        parts.push(`<text x="${n1(x + 12 + w * 0.38)}" y="${n1(yy)}" font-size="11" fill="${DIM}">${esc(head(last !== undefined && last.station !== 'model' ? `${stationOf(last.station).name.toLowerCase()}: ${last.label}` : 'thinking', fit(w * 0.62 - 24 - right.length * 6.6, 11)))}</text>`)
        parts.push(`<text x="${n1(x + w)}" y="${n1(yy)}" text-anchor="end" font-size="10.5" fill="${DIM}">${esc(right)}</text>`)
      })
      return parts.join('')
    },
  }
}

/** What fills the context window, largest first: where the room went, and what a compaction would have to shrink. */
function contextParts(c: Ctx, w: number, maxRows: number): Block | undefined {
  const all = c.board.contextParts ?? []
  if (all.length === 0 || maxRows < 1) return undefined
  const rows = all.slice(0, maxRows)
  const used = all.reduce((a, p) => a + p.tokens, 0)
  const max = Math.max(used, c.board.contextMax ?? used, 1)
  const hues: StationId[] = ['model', 'files', 'shell', 'web', 'browser', 'agents', 'memory', 'skills']
  const colorOf = (i: number): string => stationOf(hues[i % hues.length]!).color
  const cols = w >= 560 ? 2 : 1
  return {
    h: 14 + 8 + 8 + 6 + Math.ceil(rows.length / cols) * 16,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'What fills the context', `${formatTokens(used)} of ${formatTokens(max)} tokens`)]
      parts.push(`<rect x="${n1(x)}" y="${n1(y + 22)}" width="${n1(w)}" height="8" fill="${GRID}"/>`)
      let bx = x
      all.forEach((p, i) => {
        const wpx = (p.tokens / max) * w
        parts.push(`<rect x="${n1(bx)}" y="${n1(y + 22)}" width="${n1(Math.max(0.5, wpx - 1))}" height="8" fill="${i < rows.length ? colorOf(i) : FAINT}" opacity=".9"/>`)
        bx += wpx
      })
      const colW = w / cols
      rows.forEach((p, i) => {
        const lx = x + (i % cols) * colW
        const ly = y + 36 + Math.floor(i / cols) * 16 + 11
        parts.push(`<rect x="${n1(lx)}" y="${n1(ly - 8)}" width="8" height="8" fill="${colorOf(i)}"/>`)
        parts.push(`<text x="${n1(lx + 12)}" y="${n1(ly)}" font-size="10.5" fill="${INK}">${esc(head(p.name, fit(colW - 130, 10.5)))}</text>`)
        parts.push(`<text x="${n1(lx + colW - 52)}" y="${n1(ly)}" text-anchor="end" font-size="10.5" fill="${DIM}">${formatTokens(p.tokens)} tokens</text>`)
        parts.push(`<text x="${n1(lx + colW - 8)}" y="${n1(ly)}" text-anchor="end" font-size="10.5" fill="${DIM}">${Math.round((p.tokens / max) * 100)}%</text>`)
      })
      return parts.join('')
    },
  }
}

/** The folders that saw the most work. */
function folders(c: Ctx, w: number, maxRows: number): Block | undefined {
  const dirs = new Map<string, { ops: number; writes: number; files: number }>()
  for (const [path, f] of Object.entries(c.files)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(project root)'
    const d = dirs.get(dir) ?? { ops: 0, writes: 0, files: 0 }
    dirs.set(dir, { ops: d.ops + f.reads + f.writes + f.searches, writes: d.writes + f.writes, files: d.files + 1 })
  }
  const top = [...dirs.entries()].sort((a, z) => z[1].ops - a[1].ops).slice(0, maxRows)
  if (top.length === 0) return undefined
  return {
    h: 14 + 4 + top.length * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, 'Busiest folders', c.rangeLabel)]
      const most = Math.max(1, ...top.map(([, d]) => d.ops))
      const barW = clamp(w * 0.2, 44, 110)
      let yy = y + 16
      for (const [dir, d] of top) {
        yy += 16
        parts.push(`<rect x="${n1(x)}" y="${n1(yy - 8)}" width="${n1(barW)}" height="8" fill="${GRID}"/>`)
        parts.push(`<rect x="${n1(x)}" y="${n1(yy - 8)}" width="${n1((d.ops / most) * barW)}" height="8" fill="${CYAN}" opacity=".7"/>`)
        parts.push(`<text x="${n1(x + barW + 8)}" y="${n1(yy)}" font-size="10.5" fill="${DIM}">${d.ops} action${d.ops === 1 ? '' : 's'} · ${d.files} file${d.files === 1 ? '' : 's'}</text>`)
        parts.push(`<text x="${n1(x + barW + 150)}" y="${n1(yy)}" font-size="11" fill="${INK}">${esc(tailPath(dir, fit(w - barW - 152, 11)))}</text>`)
      }
      return parts.join('')
    },
  }
}

/** The event stream, newest first: when, what kind, what, how long. Model steps only when the model is followed. */
function eventLog(c: Ctx, w: number, maxRows: number, name = 'Activity log'): Block | undefined {
  if (maxRows < 1) return undefined
  const focus = c.view.station
  const all = c.entries.filter(e => (focus !== undefined ? e.station === focus : e.station !== 'model' || e.mark === 'switch' || e.status !== 'ok'))
  const rows = all.slice(-maxRows).reverse()
  const count = Math.max(1, rows.length)
  return {
    h: 14 + 4 + count * 16 + 2,
    draw: (x, y) => {
      const parts: string[] = [title(x, y, w, name, `${focus !== undefined ? `${stationOf(focus).name} · ` : ''}${rows.length < all.length || (c.isSession && c.keptFrom > c.window.from + 2000) ? `newest ${rows.length} shown` : `${all.length} events`} · ${c.rangeLabel}`)]
      if (rows.length === 0) parts.push(`<text x="${n1(x)}" y="${n1(y + 32)}" font-size="11" fill="${DIM}">Nothing in this window.</text>`)
      const hasAgo = w >= 420
      const xStation = x + (hasAgo ? 54 : 0) + 14
      const xLabel = xStation + 62
      let yy = y + 16
      for (const e of rows) {
        yy += 16
        const s = stationOf(e.station)
        const isFault = e.status === 'err' || e.status === 'block'
        const isRun = e.status === 'run'
        const color = isFault ? ERR : s.color
        const took = e.endedAt === undefined ? 'running' : e.endedAt - e.startedAt > 0 ? formatMs(e.endedAt - e.startedAt) : ''
        const tok = e.tokens !== undefined ? `  ${formatTokens(e.tokens.input + e.tokens.cached)}→${formatTokens(e.tokens.output)}` : ''
        const mark = e.mark === 'switch' ? '◆' : isRun ? '▶' : isFault ? '✕' : '·'
        if (isRun) parts.push(`<rect x="${n1(x - 3)}" y="${n1(yy - 11)}" width="${n1(w + 6)}" height="15" fill="${s.color}" opacity=".08"/>`)
        if (hasAgo) parts.push(`<text x="${n1(x + 48)}" y="${n1(yy)}" text-anchor="end" font-size="10" fill="${FAINT}">${esc(ago(Math.max(0, c.now - e.startedAt)))}</text>`)
        parts.push(`<text x="${n1(xStation - 12)}" y="${n1(yy)}" font-size="11" fill="${color}">${mark}</text>`)
        parts.push(`<text x="${n1(xStation)}" y="${n1(yy)}" font-size="10" letter-spacing=".6" fill="${isRun || isFault ? color : DIM}">${esc(s.name.toUpperCase())}</text>`)
        parts.push(`<text x="${n1(xLabel)}" y="${n1(yy)}" font-size="11" fill="${isFault ? ERR : INK}" fill-opacity="${isFault || isRun ? 1 : 0.72}">${esc(head(`${e.from === 'agents' ? '↳ ' : ''}${e.label}${tok}`, fit(w - (xLabel - x) - 58, 11)))}</text>`)
        parts.push(`<text x="${n1(x + w)}" y="${n1(yy)}" text-anchor="end" font-size="10.5" fill="${isRun ? s.color : isFault ? ERR : DIM}">${esc(took)}</text>`)
      }
      return parts.join('')
    },
  }
}

/** A section with nothing in it yet. */
function empty(w: number, name: string, text: string): Block {
  return { h: 46, draw: (x, y) => title(x, y, w, name) + `<text x="${n1(x)}" y="${n1(y + 34)}" font-size="11" fill="${DIM}">${esc(text)}</text>` }
}

// ---- layout ------------------------------------------------------------------------------------

/** The blocks that fit `room`, by importance: each is taken if it still fits, in the order given. */
function pick(candidates: (Block | undefined)[], room: number): { blocks: Block[]; used: number } {
  const blocks: Block[] = []
  let used = 0
  for (const b of candidates) {
    if (b === undefined) continue
    const need = b.h + GAP
    if (used + need > room) continue
    blocks.push(b)
    used += need
  }
  return { blocks, used }
}

export function drawHud(input: HudInput): string {
  usePalette(THEMES[input.theme])
  const W = Math.round(clamp(input.width, 300, 2400))
  const H = Math.round(clamp(input.height, 150, 3000))
  const focus = input.view.tab === 'log' ? input.view.station : undefined
  const isSession = input.view.range === 'all'
  const inWindow = isSession ? input.board.entries : input.board.entries.filter(e => endOf(e, input.now) >= input.window.from && e.startedAt <= input.window.to)
  // Past what any board holds, a short window is of the newest calls only, and its headings say so.
  const isCut = !isSession && input.board.entries.length >= HARD_KEEP && (input.board.entries[0]?.startedAt ?? 0) > input.window.from
  const c: Ctx = {
    ...input,
    rangeLabel: isCut ? `${input.rangeLabel}, newest ${HARD_KEEP} calls` : input.rangeLabel,
    view: { ...input.view, station: focus },
    bd: (isSession ? sessionBreakdown(input.board, input.now) : undefined) ?? breakdown(input.board.entries, input.window, input.now),
    stats: (isSession ? sessionStats(input.board, input.now) : undefined) ?? statsOf(input.board.entries, input.window, input.now),
    slow: slowestOf(isSession && input.board.slow !== undefined ? [...input.board.slow, ...input.board.entries.filter(e => e.status === 'run')] : inWindow, input.now),
    keptFrom: input.board.entries[0]?.startedAt ?? input.now,
    isSession,
    running: input.board.entries.filter(e => e.status === 'run'),
    entries: inWindow,
    // The session's own tallies are whole; a shorter window is counted from the calls still on the board.
    counts: isSession ? input.board.counts : countsIn(inWindow),
    files: isSession ? input.board.files : filesIn(inWindow),
    isDim: id => focus !== undefined && focus !== id,
  }
  const IN = W - PAD * 2
  const parts: string[] = []
  // The title and the tabs are the toolbar's, drawn right above this.
  let y = PAD

  // Always: the figures and the line of now. One row of figures when the pane is short or wide.
  const figures = telemetry(c, IN, H >= 560 && IN < 760 ? 2 : 1)
  parts.push(figures.draw(PAD, y))
  y += figures.h + 8
  if (H >= 240) {
    const bar = statusBar(c, IN)
    parts.push(bar.draw(PAD, y))
    y += bar.h + GAP
    const note = scopeNote(c, IN)
    if (note !== undefined) {
      parts.push(note.draw(PAD, y - 4))
      y += note.h + GAP - 4
    }
  }
  const room = H - y - PAD
  const isWide = IN >= 760 && room >= 220
  const rowsIn = (space: number): number => Math.max(0, Math.floor((space - 20 - GAP) / 16))
  const stack = (blocks: (Block | undefined)[], x: number, top: number): number => {
    let yy = top
    for (const b of blocks) {
      if (b === undefined) continue
      parts.push(b.draw(x, yy))
      yy += b.h + GAP
    }
    return yy
  }
  const half = (IN - 20) / 2
  const tab = input.view.tab

  if (tab === 'log') {
    stack([eventLog(c, IN, rowsIn(room + GAP))], PAD, y)
  } else if (tab === 'files') {
    if (isWide) {
      stack([fileHeat(c, half, rowsIn(room + GAP)) ?? empty(half, 'File heat', 'No files touched in this window.')], PAD, y)
      stack([folders(c, half, rowsIn(room + GAP)), subagents(c, half)], PAD + half + 20, y)
    } else {
      const dirs = folders(c, IN, clamp(rowsIn(room * 0.3), 0, 8))
      const files = fileHeat(c, IN, rowsIn(room + GAP - (dirs !== undefined ? dirs.h + GAP : 0))) ?? empty(IN, 'File heat', 'No files touched in this window.')
      stack([files, dirs], PAD, y)
    }
  } else if (tab === 'timeline') {
    if (isWide) {
      const colW = IN * 0.6 - 10
      const split = timeSplit(c, colW)
      const lanes = Math.max(1, STATIONS.filter(s => (c.board.counts[s.id] ?? 0) > 0).length)
      stack([timeline(c, colW, true, clamp(Math.floor((room - split.h - GAP - 40) / (lanes + 1.6)), 17, 30)), split], PAD, y)
      const right = pick([stationTable(c, IN * 0.4 - 10), subagents(c, IN * 0.4 - 10)], room + GAP)
      stack([...right.blocks, slowest(c, IN * 0.4 - 10, clamp(rowsIn(room + GAP - right.used), 0, 10))], PAD + colW + 20, y)
    } else {
      const rest = pick([timeSplit(c, IN), slowest(c, IN, 5), stationTable(c, IN), subagents(c, IN)], Math.max(0, room - 120))
      const lanes = Math.max(1, STATIONS.filter(s => (c.board.counts[s.id] ?? 0) > 0).length)
      const lane = clamp(Math.floor((room + GAP - rest.used - 42) / (lanes + 1.6)), 15, 28)
      const tl = timeline(c, IN, true, lane)
      stack([tl, ...rest.blocks], PAD, y)
    }
  } else if (isWide) {
    // Overview, wide: the map at the left, as tall as the room; the panels stacked at its right.
    const mapW = clamp(room * 1.2, 300, IN * 0.5)
    const colW = IN - mapW - 16
    parts.push(radar(c, mapW, room).draw(PAD, y))
    const first = pick([issues(c, colW, 3), timeline(c, colW, room >= 300), timeSplit(c, colW), stationTable(c, colW), subagents(c, colW), contextParts(c, colW, 6)], room + GAP)
    const left = room + GAP - first.used
    const files = fileHeat(c, colW, clamp(rowsIn(left * 0.5), 0, 8))
    const log = eventLog(c, colW, rowsIn(left - (files !== undefined ? files.h + GAP : 0)), 'Latest activity')
    stack([...first.blocks, files, log], PAD + mapW + 16, y)
  } else {
    // Overview, stacked: the panels that fit under a map of at least its least height; the map takes what is left.
    const MAP_MIN = 210
    const hasMap = room >= MAP_MIN
    const forPanels = hasMap ? room - MAP_MIN : room + GAP
    const first = pick([issues(c, IN, 3), timeline(c, IN, forPanels >= 380), timeSplit(c, IN), stationTable(c, IN), subagents(c, IN), contextParts(c, IN, 5)], forPanels)
    // A few rows of each come before a roomier map; more only once the map is comfortable.
    const mapIdeal = clamp(IN * 0.8, MAP_MIN, 400)
    const spare = forPanels - first.used
    const roomy = spare - (hasMap ? mapIdeal - MAP_MIN : 0)
    const files = fileHeat(c, IN, Math.max(clamp(rowsIn(spare * 0.5), 0, 4), clamp(rowsIn(roomy * 0.5), 0, 8)))
    const afterFiles = files !== undefined ? files.h + GAP : 0
    const log = eventLog(c, IN, Math.max(clamp(rowsIn(spare - afterFiles), 0, 4), clamp(rowsIn(roomy - afterFiles), 0, 10)), 'Latest activity')
    const blocks = [...first.blocks, ...(files !== undefined ? [files] : []), ...(log !== undefined ? [log] : [])]
    const panelsH = blocks.reduce((a, b) => a + b.h + GAP, 0)
    if (hasMap) {
      const mapH = room - panelsH
      parts.push(radar(c, IN, mapH).draw(PAD, y))
      y += mapH + GAP
    }
    stack(blocks, PAD, y)
  }

  // Drawn far larger than any pane, so the surface always scales it down to the pane's exact width.
  const scale = 4
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * scale}" height="${H * scale}" ${FONT}>` +
    `<defs>${glow('g1', 1.2)}${glow('g2', 2)}${glow('g3', 4)}` +
    `<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${CYAN}" stop-opacity=".35"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="concFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${CYAN}" stop-opacity=".45"/><stop offset="1" stop-color="${CYAN}" stop-opacity=".03"/></linearGradient>` +
    `<pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="${GRID}"/></pattern>` +
    
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="${BG}"/><rect width="${W}" height="${H}" fill="url(#dots)"/>` +
    `<path d="M${W - 3} ${H - 15}V${H - 3}H${W - 15}M15 ${H - 3}H3V${H - 15}" fill="none" stroke="${FAINT}" stroke-width="1.2"/>` +
    parts.join('') +
    `</svg>`
  )
}
