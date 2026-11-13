// The board's bookkeeping, as plain functions from one board to the next. The hooks module decides when something
// happened; these say what the board looks like afterwards. They are pure functions with no engine calls, so all of
// it is tested without an engine.
import type { Board, Entry, FileStat, StationId, Status } from '../types'
import { folded, kept, peaked, spentAfterTurn, spentWaiting, tallied } from './tally'

/** How many files the board lists before the least recently touched make room. */
export const MAX_FILES = 3000
const MAX_TURNS = 40
const MAX_AGENTS = 12

export const isFailure = (status: Status): boolean => status === 'err' || status === 'block'

/** What the hooks module knows about a call as it starts. `outcome` set means it is over already: a moment. */
export type Opening = Pick<Entry, 'station' | 'label'> &
  Partial<Pick<Entry, 'from' | 'agentId' | 'mark' | 'file'>> & {
    outcome?: Status
    startedAt?: number
    endedAt?: number
    /** False for a row that restates something counted elsewhere, such as a change of model. */
    isCounted?: boolean
  }

const bumped = (tally: Board['faults'], station: StationId): Board['faults'] => ({ ...tally, [station]: (tally[station] ?? 0) + 1 })

/** A failure noted: on its station until the next message, and in the session's count for good. */
const withFailure = (b: Board, station: StationId): Pick<Board, 'faults' | 'failed'> => ({ faults: bumped(b.faults, station), failed: (b.failed ?? 0) + 1 })

/** The file list after a call on one of its files; the list sheds its stalest entries past `MAX_FILES`. */
function withFile(b: Board, e: Entry, now: number, phase: 'opened' | 'failed'): Pick<Board, 'files' | 'filesDropped'> {
  if (e.file === undefined) return { files: b.files }
  const { path, op, added = 0, removed = 0 } = e.file
  const before: FileStat = b.files[path] ?? { reads: 0, writes: 0, searches: 0, errs: 0, last: 0 }
  const isOpening = phase === 'opened'
  const after: FileStat = {
    reads: before.reads + (isOpening && op === 'read' ? 1 : 0),
    writes: before.writes + (isOpening && op === 'write' ? 1 : 0),
    searches: before.searches + (isOpening && op === 'search' ? 1 : 0),
    errs: before.errs + (isOpening ? 0 : 1),
    last: now,
    added: (before.added ?? 0) + (isOpening ? added : 0),
    removed: (before.removed ?? 0) + (isOpening ? removed : 0),
  }
  const files = { ...b.files, [path]: after }
  const paths = Object.keys(files)
  const excess = paths.length - MAX_FILES
  if (excess <= 0) return { files }
  const stale = new Set(paths.sort((p, q) => files[p]!.last - files[q]!.last).slice(0, excess))
  return { files: Object.fromEntries(Object.entries(files).filter(([p]) => !stale.has(p))), filesDropped: (b.filesDropped ?? 0) + excess }
}

/** A call has started (or, with an outcome, a moment has passed): it joins the board. */
export function opened(b: Board, id: string, o: Opening, now: number): Board {
  const startedAt = o.startedAt ?? now
  const entry: Entry = {
    id,
    station: o.station,
    label: o.label,
    from: o.from ?? 'core',
    startedAt,
    status: o.outcome ?? 'run',
    ...(o.outcome !== undefined ? { endedAt: o.endedAt ?? now } : {}),
    ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
    ...(o.mark !== undefined ? { mark: o.mark } : {}),
    ...(o.file !== undefined ? { file: o.file } : {}),
  }
  const everything = [...b.entries, entry]
  const entries = kept(everything, now, b.turns[b.turns.length - 1]?.startedAt)
  // Whatever no longer fits on the board goes into the record of the session's shape: nothing leaves unrecorded.
  const staying = new Set(entries)
  const leaving = entries.length === everything.length ? [] : everything.filter(e => !staying.has(e))
  const firstAt = b.firstAt ?? b.entries[0]?.startedAt ?? startedAt
  const history = folded({ ...b, firstAt }, leaving)
  const isCounted = o.isCounted !== false
  const isLoggedFailure = isFailure(entry.status) && entry.station !== 'you'
  const isNewAgent = entry.agentId !== undefined && !b.agents.includes(entry.agentId)
  return {
    ...b,
    entries,
    firstAt,
    ...withFile(b, entry, now, 'opened'),
    ...(history !== undefined ? { history } : {}),
    ...(isCounted ? { counts: { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 } } : {}),
    ...(isLoggedFailure ? withFailure(b, entry.station) : {}),
    ...(isNewAgent ? { agents: [...b.agents, entry.agentId!].slice(-MAX_AGENTS) } : {}),
    ...(entry.endedAt !== undefined ? tallied(b, [entry]) : {}),
  }
}

/** The running call `id` is over. Unknown ids, and calls already over, change nothing. */
export function closed(b: Board, id: string, outcome: Status, now: number, extra: Partial<Entry> = {}): Board {
  const running = b.entries.find(e => e.id === id && e.status === 'run')
  if (running === undefined) return b
  const done: Entry = { ...running, ...extra, status: outcome, endedAt: now }
  return {
    ...b,
    entries: b.entries.map(e => (e === running ? done : e)),
    ...tallied(b, [done]),
    ...(isFailure(outcome) ? { ...withFailure(b, done.station), ...withFile(b, done, now, 'failed') } : {}),
  }
}

/** Every running call the test picks is over, all with one outcome: a subagent's leftovers, a finished background task. */
export function closedWhere(b: Board, test: (e: Entry) => boolean, outcome: Status, now: number): Board {
  const done: Entry[] = []
  const entries = b.entries.map(e => {
    if (e.status !== 'run' || !test(e)) return e
    const over: Entry = { ...e, status: outcome, endedAt: now }
    done.push(over)
    return over
  })
  if (done.length === 0) return b
  let next: Board = { ...b, entries, ...tallied(b, done) }
  if (isFailure(outcome)) for (const e of done) next = { ...next, ...withFailure(next, e.station) }
  return next
}

/** The call `id` handed its work to a background task: it stays running, tied to the task, until the task reports. */
export const backgrounded = (b: Board, id: string, task: string): Board => ({ ...b, entries: b.entries.map(e => (e.id === id && e.status === 'run' ? { ...e, task } : e)) })

/** The person sent a message: a new turn. Failures shown on stations start over, and the wait since the last answer is accounted for. */
export function turnBegan(b: Board, turnId: string, now: number): Board {
  const spent = spentWaiting(b, now)
  return { ...b, faults: {}, ...(spent !== undefined ? { spent } : {}), turns: [...b.turns, { id: turnId, startedAt: now }].slice(-MAX_TURNS) }
}

/**
 * The main loop's turn is over. Calls of its own still marked running never reported back (an interrupt does that), so
 * they end here; background tasks carry on. The turn's time joins the session's, while its calls are all still here.
 */
export function turnEnded(b: Board, now: number, wasAborted: boolean): Board {
  const settled = closedWhere(b, e => e.from === 'core' && e.task === undefined, 'ok', now)
  const turn = settled.turns[settled.turns.length - 1]
  if (turn === undefined || turn.endedAt !== undefined) return settled
  const history = peaked(settled, now)
  return {
    ...settled,
    turns: settled.turns.map(t => (t === turn ? { ...t, endedAt: now, aborted: wasAborted } : t)),
    spent: spentAfterTurn(settled, turn.startedAt, now),
    ...(history !== undefined ? { history } : {}),
  }
}

/** A subagent's loop ended: it is no longer listed, and what it left running is over. */
export function agentLeft(b: Board, agentId: string, now: number): Board {
  return closedWhere({ ...b, agents: b.agents.filter(id => id !== agentId) }, e => e.agentId === agentId || e.task === agentId, 'ok', now)
}

// ---- background tasks ---------------------------------------------------------------------------

const asTaskId = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v) ? v : undefined)

/**
 * The background task a tool's result says it started, if any. Read off the result types the engine publishes: a
 * shell command sent to the background carries `backgroundTaskId`; an agent or workflow launched to run on answers
 * with a `status` of `async_launched` or `remote_launched` and the id of what it launched.
 */
export function backgroundTaskOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const fields = result as Record<string, unknown>
  const launched = fields.status === 'async_launched' || fields.status === 'remote_launched'
  if (launched) return asTaskId(fields.agentId) ?? asTaskId(fields.taskId) ?? asTaskId(fields.runId)
  return asTaskId(fields.backgroundTaskId)
}

/**
 * What a task notification says: which task, and whether it is over and how. The engine delivers one as a prompt of
 * origin `task-notification`, its text a small tagged block; only the id and the status are read, never its output.
 * No status means the task spoke and carries on.
 */
export function readTaskNotice(text: string): { task: string; outcome?: Status } | undefined {
  const body = text.trim()
  if (!body.startsWith('<task-notification')) return undefined
  const tag = (name: string): string | undefined => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(body)?.[1]
  const task = asTaskId(tag('task-id'))
  if (task === undefined) return undefined
  const status = tag('status')
  if (status === undefined || status === '') return { task }
  return { task, outcome: /fail|error|kill/i.test(status) ? 'err' : 'ok' }
}
