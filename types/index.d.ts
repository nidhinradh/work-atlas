export type StationId =
  | 'you' | 'model' | 'memory' | 'files' | 'shell'
  | 'web' | 'browser' | 'agents' | 'skills' | 'hooks'

export type Status = 'run' | 'ok' | 'err' | 'block'

export type FileOp = 'read' | 'write' | 'search'

export type Tokens = { input: number; output: number; cached: number }

/** A single thing that happened: a tool call, a model request, a message. Holds a short label only, never content. */
export type Entry = {
  id: string
  station: StationId
  label: string
  /** Who initiated it: the main loop (`core`), a subagent (`agents`), or something arriving from outside (`inbound`). */
  from: 'core' | 'agents' | 'inbound'
  startedAt: number
  endedAt?: number
  status: Status
  /** Id of the subagent that made this call. Unset for main-loop calls. */
  agentId?: string
  /** Id of a background task this call launched. While set and unreported, the call counts as still running. */
  task?: string
  /** A special kind of row: `switch` for a model change, `done` for a finished answer, `ask` for a question to the user. */
  mark?: 'switch' | 'done' | 'ask'
  /** The file the call touched, relative to the session folder when inside it. */
  file?: { path: string; op: FileOp; added?: number; removed?: number }
  /** For a model step: what the request cost in tokens. */
  tokens?: Tokens
}

export type FileStat = { reads: number; writes: number; searches: number; errs: number; last: number; added?: number; removed?: number }

/** One usage window of the account: how much is used, and when it resets. */
export type Limit = { kind: string; percent: number; resetsAt?: number }

/** One station's calls over the whole session: how many, how many failed, how long in all, and the longest. */
export type StationTotals = { calls: number; fails: number; total: number; max: number }

/** Where the session's time went, by what it was spent on (a station's id, `waiting` or `idle`), in milliseconds. */
export type Spent = { parts: Record<string, number>; busy: number; parallel: number; peak: number }

/**
 * The shape of the session's calls that are no longer kept one by one: time cut into slices of `sliceMs` from `from`,
 * and for each station how many milliseconds of each slice it was busy, and whether a call failed in it. `peak` is the
 * most tool calls running at once in each slice. Every call that leaves `entries` is added here, so the two together
 * are the whole session. The slices widen as the session grows, so the record stays small.
 */
export type History = {
  sliceMs: number
  from: number
  busy: Partial<Record<StationId, number[]>>
  faults: Partial<Record<StationId, number[]>>
  peak: number[]
  /** Up to when `peak` has been worked out. */
  peakUntil?: number
}

export type Turn = { id: string; startedAt: number; endedAt?: number; aborted?: boolean }

export type Board = {
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  /** Failed or blocked calls per kind of work in the current turn. Cleared when a new message arrives. */
  faults: Partial<Record<StationId, number>>
  /** Ids of subagents currently running. */
  agents: string[]
  files: Record<string, FileStat>
  turns: Turn[]
  tokens: Tokens
  model?: string
  /** Context window fill, 0 to 100. */
  context?: number
  /** Session cost in US dollars. */
  cost?: number
  switchedAt?: number
  /** When the session began. */
  startedAt?: number
  /** The main loop's current step in this turn. */
  step?: number
  /** Calls that failed or were refused, over the whole session. */
  failed?: number
  /** When the first thing of the session happened. */
  firstAt?: number
  /** When Work Atlas first ran in this session. Later than `startedAt` for a session it joined partway or that was resumed. */
  watchedFrom?: number
  /** The session's totals, added to as each call ends: they do not depend on which calls are still in `entries`. */
  stats?: Partial<Record<StationId, StationTotals>>
  /** The session's slowest calls, longest first. */
  slow?: Entry[]
  /** Where the time of the turns that have ended went, and of the waits between them. */
  spent?: Spent
  /** The shape of the calls no longer in `entries`. */
  history?: History
  /** How many files left `files` because it was full: the list says so when any did. */
  filesDropped?: number
  /** The account's usage windows, as last reported. */
  limits?: Limit[]
  /** What each running subagent is called: its name, else what it was asked to do. */
  agentNames?: Record<string, string>
  /** What fills the context window, largest first, as /context lists it; and the window's size in tokens. */
  contextParts?: { name: string; tokens: number }[]
  contextMax?: number
  /** Warnings already raised, so each is said once. */
  warned?: { context?: boolean; limit?: boolean }
}

export type Range = 'turn' | '5m' | 'all'

export type ThemeId = 'nebula' | 'dark' | 'light'

export type Tab = 'overview' | 'timeline' | 'files' | 'log'

/** What the person chose to look at. */
export type View = {
  tab: Tab
  range: Range
  /** Only this station in the log; others dimmed on the map and timeline. */
  station?: StationId
  /** Which of the toolbar's menus is open. */
  menu?: 'range' | 'theme'
  /** The look the person picked; absent, the one the mod's options name. */
  theme?: ThemeId
}

declare module 'claude-code' {
  interface PluginState {
    'work-atlas': { board: Shaped<Board>; view: Shaped<View>; tick: Shaped<number>; drawn: Shaped<boolean> }
  }
}
