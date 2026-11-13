import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, StationId, Status, Tab, ThemeId, Tokens, View } from '../types'
import { STATIONS, classify, paintStations, clean, formatMs, formatTokens, shortModel, stationOf } from './classify'
import type { Context } from './classify'
import { drawHud } from './hud'
import { THEMES, isTheme } from './palette'
import { MENU_WIDTH, layoutMenu, layoutToolbar, menuRight, pressToView } from './toolbar-layout'
import { agentLeft, backgroundTaskOf, backgrounded, closed, closedWhere, isFailure, opened, readTaskNotice, turnBegan, turnEnded } from './ledger'
import type { Opening } from './ledger'
import { endOf, windowOf } from './time'
import type { Window } from './time'

const PANE = 'work-atlas'
const TITLE = 'Work atlas'
/** A settings hook's check that takes this long is noted; a quicker one is not worth a row. */
const SLOW_HOOK_MS = 400
const ERR = '#ff3d7f'
// The surface leaves a frame around a pane's body that nothing drawn here reaches: it clips at the body's edge, so a
// negative margin only cuts the drawing off. The pane's own `backgroundColor` stops at the body too.
/** Rows left free under the drawing: a drawing a little short shows its own ground; one a little tall is cut off. */
const SPARE_ROWS = 0.5
/** Drawing units per column: about a pixel each at full size, so the HUD's type is drawn near its real size. */
const UNIT = 8

const EMPTY: Board = { entries: [], counts: {}, faults: {}, agents: [], files: {}, turns: [], tokens: { input: 0, output: 0, cached: 0 } }

// Each `shape` tag is a version. Bump one when its value's fields change, and state saved by older code is discarded.
const board = atom({ plugin: 'work-atlas', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const view = atom({ plugin: 'work-atlas', key: 'view' } as const, { tab: 'overview', range: 'all' } as View, { shape: 'view-6' })
/** Written once a second while anything moves, so the pane redraws its clocks and growing bars. */
const tick = atom({ plugin: 'work-atlas', key: 'tick' } as const, 0, { shape: 'tick-1' })

/** Whether the surface has shown that it draws the atlas' own toolbar: its region said hello. */
const drawn = atom({ plugin: 'work-atlas', key: 'drawn' } as const, false, { shape: 'drawn-1' })

let serial = 0
/** A name for a call, unique in the session whatever order calls start in, and across a reload of this module. */
const callId = (): string => `c${(serial++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Runs work that only serves the atlas and swallows whatever goes wrong in it. The atlas watches the session; a
 * fault of its own must never fail a tool call, a turn or a prompt.
 */
async function safely<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

/** Changes the board, at the engine's own time. What the change is lives in `ledger.ts`, away from the engine. */
async function record($: EngineInterface, change: (b: Board, now: number) => Board): Promise<void> {
  await safely(async () => {
    const now = await $.clock.now()
    await update($, board, b => change(b, now))
  })
}

/** Starts a call on the board and hands back its id, for `closed` to end it by. */
async function open($: EngineInterface, call: Opening, alongside?: Partial<Board>): Promise<string> {
  const id = callId()
  await record($, (b, now) => ({ ...opened(b, id, { ...call, label: clean(call.label) }, now), ...alongside }))
  return id
}

/** Notes something that happened and is already over: a message arriving, a hook's verdict, an answer. */
async function moment($: EngineInterface, what: Opening): Promise<void> {
  await record($, (b, now) => opened(b, callId(), { outcome: 'ok', ...what, label: clean(what.label) }, now))
}

/** A background task reported how it ended: the call that started it is over. */
async function taskReported($: EngineInterface, text: string): Promise<boolean> {
  const notice = readTaskNotice(text)
  if (notice === undefined) return false
  const { task, outcome } = notice
  if (outcome !== undefined) await record($, (b, now) => closedWhere(b, e => e.task === task, outcome, now))
  return true
}

/** Whether a settings hook put anything into the context. */
const addedContext = (context: readonly string[] | undefined): boolean => (context ?? []).some(text => text.trim() !== '')

async function usageOf($: EngineInterface): Promise<Partial<Board>> {
  const u = await safely(() => $.session.usage())
  if (u === undefined) return {}
  return {
    ...(typeof u.context.percent === 'number' ? { context: u.context.percent } : {}),
    ...(u.cost !== undefined ? { cost: u.cost.usd } : {}),
    limits: u.rateLimits.map(r => {
      const at = r.resetsAt !== undefined ? Date.parse(r.resetsAt) : Number.NaN
      return { kind: r.kind, percent: r.percentUsed, ...(Number.isFinite(at) ? { resetsAt: at } : {}) }
    }),
  }
}

/** Opens the pane, or retitles it, with the look's ground painted under its body: no bare surface shows below the drawing. */
async function openPane($: EngineInterface, theme: ThemeId, isTerminal: boolean): Promise<{ isPlaced: boolean; reason?: string }> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, ...(isTerminal ? {} : { backgroundColor: THEMES[theme].bg }) })
  return { isPlaced: opened.isPlaced, ...(opened.isPlaced ? {} : { reason: String(opened.reason) }) }
}

/** What the session has used, written to the board; and a word, once each, when the context or a limit runs high. */
async function noteUsage($: EngineInterface, usage: Partial<Board>, alerts: boolean): Promise<void> {
  const b = await update($, board, x => ({ ...x, ...usage }))
  if (!alerts) return
  const ctx = b.context ?? 0
  const top = Math.max(0, ...(b.limits ?? []).map(l => l.percent))
  const warned = b.warned ?? {}
  const next = { context: ctx >= 85 ? true : ctx < 70 ? false : warned.context === true, limit: top >= 90 ? true : top < 80 ? false : warned.limit === true }
  if (next.context && warned.context !== true) $.ui.toast(`Work Atlas: the context is ${ctx}% full. /compact frees room before Claude has to.`, { timeoutMs: 8000 })
  if (next.limit && warned.limit !== true) $.ui.toast(`Work Atlas: ${Math.round(top)}% of your usage limit is used.`, { timeoutMs: 8000 })
  if (next.context !== (warned.context === true) || next.limit !== (warned.limit === true)) await update($, board, x => ({ ...x, warned: next }))
}

/** A subagent's name, asked of the engine once: its own name, else what it was asked to do, else its type. */
async function nameAgent($: EngineInterface, id: string): Promise<void> {
  const b = await read($, board)
  if (b.agentNames?.[id] !== undefined) return
  const info = (await $.agent.list()).find(a => a.id === id)
  if (info === undefined) return
  const name = clean(info.name ?? (info.description !== '' ? info.description : info.type), 60)
  await update($, board, x => ({ ...x, agentNames: { ...x.agentNames, [id]: name } }))
}

/** What fills the context window, as /context estimates it without asking the API. */
async function measureContext($: EngineInterface): Promise<void> {
  const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  if (breakdown === undefined) return
  const parts = breakdown.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: clean(c.name, 40), tokens: c.tokens }))
    .sort((a, z) => z.tokens - a.tokens)
    .slice(0, 8)
  await update($, board, x => ({ ...x, contextParts: parts, contextMax: breakdown.rawMaxTokens }))
}

/** The session in a few lines of plain text: what `/work-atlas summary` answers. */
function summaryOf(b: Board, now: number): string {
  const calls = STATIONS.reduce((a, s) => a + (s.id === 'model' || s.id === 'you' ? 0 : (b.counts[s.id] ?? 0)), 0)
  const files = Object.values(b.files)
  const slow = b.entries.filter(e => e.endedAt !== undefined && e.mark === undefined && e.station !== 'model').sort((a, z) => z.endedAt! - z.startedAt - (a.endedAt! - a.startedAt))[0]
  const busiest = STATIONS.filter(s => s.id !== 'you' && s.id !== 'model' && (b.counts[s.id] ?? 0) > 0)
    .sort((a, z) => (b.counts[z.id] ?? 0) - (b.counts[a.id] ?? 0))
    .slice(0, 3)
    .map(s => `${s.name} ${b.counts[s.id]}`)
  return [
    `Work Atlas · session ${b.startedAt !== undefined ? formatMs(now - b.startedAt) : ''} · ${b.turns.length} turn${b.turns.length === 1 ? '' : 's'}`,
    `Cost: ${b.cost !== undefined ? `$${b.cost.toFixed(2)}` : 'unknown'} · Context used: ${b.context ?? 0}% · Tokens: ${formatTokens(b.tokens.input + b.tokens.cached)} in, ${formatTokens(b.tokens.output)} out`,
    `Tool calls: ${calls}, ${Math.max(b.failed ?? 0, b.entries.filter(e => isFailure(e.status) && e.station !== 'you').length)} failed${busiest.length > 0 ? ` · most used: ${busiest.join(', ')}` : ''}`,
    `Files: ${files.filter(f => f.writes > 0).length} edited (+${files.reduce((a, f) => a + (f.added ?? 0), 0)} −${files.reduce((a, f) => a + (f.removed ?? 0), 0)} lines), ${files.filter(f => f.reads > 0).length} read`,
    ...(slow !== undefined ? [`Slowest call: ${stationOf(slow.station).name.toLowerCase()}: ${slow.label} (${formatMs(slow.endedAt! - slow.startedAt)})`] : []),
  ].join('\n')
}

let ticking = false

async function onTick($: EngineInterface): Promise<void> {
  const b = await read($, board)
  const now = await $.clock.now()
  const last = b.entries[b.entries.length - 1]
  // Only while something runs: the clocks and counters move, and a redraw is cheap next to a stale figure.
  const isMoving = b.entries.some(e => e.status === 'run') || (last !== undefined && last.endedAt !== undefined && now - last.endedAt < 3_000)
  if (isMoving) await update($, tick, () => now)
}

/** Redraw once a second while something runs or has just changed; quiet otherwise. */
function startTicking($: EngineInterface): void {
  if (ticking) return
  ticking = true
  $.clock.every(2000, () => void safely(() => onTick($)))
}

// ---- the terminal's timeline, in characters ---------------------------------------------------------

function textLanes(b: Board, w: Window, now: number, columns: number): { name: string; cells: string; color: string }[] {
  const width = Math.max(10, columns - 10)
  const span = Math.max(1, w.to - w.from)
  return STATIONS.flatMap(s => {
    const mine = b.entries.filter(e => e.station === s.id && endOf(e, now) >= w.from && e.startedAt <= w.to && e.mark !== 'switch')
    if (mine.length === 0) return []
    const cells = Array.from({ length: width }, (_, i) => {
      const t0 = w.from + (i / width) * span
      const t1 = w.from + ((i + 1) / width) * span
      const here = mine.filter(e => e.startedAt < t1 && endOf(e, now) >= t0)
      if (here.length === 0) return '·'
      if (here.some(e => isFailure(e.status))) return '✕'
      if (here.some(e => e.from !== 'agents')) return here.length > 1 ? '█' : '▆'
      return '▂'
    }).join('')
    return [{ name: s.name, cells, color: s.color }]
  })
}

// ---- the module ------------------------------------------------------------------------------------

/** An option that holds several values: given as a list, or as one string with commas. */
function asList(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return items.map(item => String(item).trim()).filter(item => item.length > 0)
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Record<string, unknown>
  const core = (typeof opts.coreName === 'string' && opts.coreName.trim() !== '' ? opts.coreName.trim() : 'CLAUDE').slice(0, 10)
  const ctx: Context = { cwd: '', memoryServers: asList(opts.memoryServers ?? ['memory']) }
  const shape = typeof opts.cellShape === 'number' ? opts.cellShape : typeof opts.cellShape === 'string' ? Number(opts.cellShape) : Number.NaN
  /** Row height divided by column width for the pane's text grid. The drawing's height is worked out from it. */
  const cellShape = Number.isFinite(shape) && shape >= 1.2 && shape <= 4 ? shape : 2.25
  /** The look the mod's options name; the person's own pick, kept in the view, comes before it. */
  const defaultTheme: ThemeId = isTheme(opts.theme) ? opts.theme : 'nebula'
  /** Whether to say, once each, that the context or a usage limit is running high. */
  const alerts = opts.alerts !== false
  let isTerminal = false
  /** Ids of tool calls vetoed by a settings hook. Lets the call be logged as blocked, not as an error. */
  const stoppedByHook = new Set<string>()
  /** Model used by the previous main-loop request; compared with the next to spot a switch. */
  let mainModel: string | undefined

  on('session.start', async ($, e, next) => {
    ctx.cwd = e.cwd
    await safely(async () => {
      const startedAt = (await $.session.usage()).startedAt
      const now = await $.clock.now()
      // The first time Work Atlas runs in a session is when its own counts begin.
      await update($, board, b => ({ ...b, startedAt, watchedFrom: b.watchedFrom ?? b.firstAt ?? now }))
    })
    await safely(() => $.command.register({ name: 'work-atlas', description: 'Open the work atlas: map, timeline and files' }))
    isTerminal = e.surface === 'terminal'
    // The look and the window the person last chose, in any session, come before the defaults.
    const saved = await safely(async () => ({ theme: await $.store.get('theme'), range: await $.store.get('range') }))
    const savedRange: View['range'] | undefined = saved?.range === 'turn' || saved?.range === '5m' || saved?.range === 'all' ? saved.range : undefined
    const v = await safely(() =>
      update($, view, x => ({
        ...x,
        ...(x.theme === undefined && isTheme(saved?.theme) ? { theme: saved.theme } : {}),
        ...(savedRange !== undefined ? { range: savedRange } : {}),
        menu: undefined,
      })),
    )
    const theme = v?.theme ?? defaultTheme
    void safely(async () => {
      await openPane($, theme, isTerminal)
      await $.ui.scroll({ in: PANE, to: 'start' })
    })
    startTicking($)
    return next(e)
  })

  on('command.run', { command: 'work-atlas' }, async ($, e) => {
    const [word = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'summary') return { text: summaryOf(await read($, board), await $.clock.now()) }
    if (word === 'theme') {
      if (!isTheme(arg)) return { text: 'Work Atlas themes: nebula, dark, light. For example: /work-atlas theme dark' }
      await update($, view, x => ({ ...x, theme: arg }))
      await safely(() => $.store.set('theme', arg))
      await safely(() => openPane($, arg, isTerminal))
      return { text: `Work Atlas theme: ${arg}.` }
    }
    const theme = (await read($, view)).theme ?? defaultTheme
    const opened = await openPane($, theme, isTerminal)
    return { text: opened.isPlaced ? 'Work Atlas opened. Also: /work-atlas summary, /work-atlas theme <nebula|dark|light>.' : `Work Atlas could not open here: ${opened.reason}` }
  })

  // ---- watching the session ------------------------------------------------------------------------
  // Each handler lets the event through untouched (`next(e)`) and only notes on the board what it saw.

  // The main loop's turn begins with the person's message. A background task that reports back also arrives as a
  // turn's text; that one ends the task's call and is no message of the person's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !(await taskReported($, e.text)) && e.text.trim() !== '') {
      await record($, (b, now) => turnBegan(b, e.turnId, now))
      await moment($, { station: 'you', label: 'new message', from: 'inbound' })
    }
    return next(e)
  })

  // One request to the model, in the main loop or in a subagent's. The step is open while the response streams, and
  // closes with what the request cost in tokens.
  on('turn.step', async function* ($, e, next) {
    const subagent = e.agentId
    if (subagent === undefined) {
      const before = mainModel
      mainModel = e.model
      if (before !== undefined && before !== e.model) {
        await record($, (b, now) => ({
          ...opened(b, callId(), { station: 'model', label: `${shortModel(before)} → ${shortModel(e.model)}`, outcome: 'ok', mark: 'switch', isCounted: false }, now),
          switchedAt: now,
        }))
      }
    } else {
      void safely(() => nameAgent($, subagent))
    }
    const id = await open(
      $,
      { station: 'model', label: `${shortModel(e.model)} · step ${e.index + 1}${subagent === undefined ? '' : ' · subagent'}`, ...(subagent === undefined ? {} : { from: 'agents' as const, agentId: subagent }) },
      subagent === undefined ? { model: e.model, step: e.index + 1 } : undefined,
    )
    let cost: Tokens | undefined
    try {
      const response = yield* next(e)
      const u = response.usage
      if (u !== null && u !== undefined) cost = { input: u.input_tokens + u.cache_creation_input_tokens, output: u.output_tokens, cached: u.cache_read_input_tokens }
      return response
    } finally {
      const usage = await usageOf($)
      const tokens = cost
      await record($, (b, now) => {
        const after = closed(b, id, 'ok', now, tokens !== undefined ? { tokens } : {})
        if (tokens === undefined) return { ...after, ...usage }
        return { ...after, ...usage, tokens: { input: after.tokens.input + tokens.input, output: after.tokens.output + tokens.output, cached: after.tokens.cached + tokens.cached } }
      })
    }
  })

  // A loop is done: a subagent leaves the map, or the main loop has its answer (or was interrupted).
  on('turn.complete', async ($, e, next) => {
    const subagent = e.agentId
    if (subagent !== undefined) {
      await record($, (b, now) => agentLeft(b, subagent, now))
    } else {
      void safely(() => measureContext($))
      await moment($, e.isAborted ? { station: 'you', label: 'turn interrupted', outcome: 'err' } : { station: 'you', label: 'answer ready', mark: 'done' })
      await record($, (b, now) => turnEnded(b, now, e.isAborted))
    }
    return next(e)
  })

  // A tool call, from start to result. It ends as done, failed, or blocked (the tool, a plugin or a settings hook
  // refused it); a call that started background work stays open until that work reports back.
  on('tool.call', async ($, e, next) => {
    let seen: Opening
    try {
      seen = classify(e.tool, e as unknown as Record<string, unknown>, ctx)
    } catch {
      seen = { station: 'skills', label: e.tool }
    }
    const id = await open($, e.agentId === undefined ? seen : { ...seen, from: 'agents', agentId: e.agentId })
    let outcome: Status = 'err'
    let task: string | undefined
    try {
      const answer = await next(e)
      const wasRefused = answer.deny !== undefined || (e.tool_use_id !== undefined && stoppedByHook.delete(e.tool_use_id))
      outcome = wasRefused ? 'block' : answer.isError === true ? 'err' : 'ok'
      if (outcome === 'ok') task = backgroundTaskOf(answer.result)
      return answer
    } finally {
      const result = outcome
      const background = task
      await record($, (b, now) => (background !== undefined ? backgrounded(b, id, background) : closed(b, id, result, now)))
    }
  })

  // A settings hook's verdict on a tool call, before it runs: a refusal, a request for permission, or a check slow
  // enough to be worth seeing. A quick pass is not noted.
  on('classic.PreToolUse', async ($, e, next) => {
    const askedAt = await safely(() => $.clock.now())
    const verdict = await next(e)
    await safely(async () => {
      const answeredAt = await $.clock.now()
      const span = { startedAt: askedAt ?? answeredAt, endedAt: answeredAt }
      if (verdict.deny !== undefined) {
        if (e.tool_use_id !== undefined) stoppedByHook.add(e.tool_use_id)
        await moment($, { station: 'hooks', label: `stopped ${e.tool}`, outcome: 'block', ...span })
      } else if (verdict.ask !== undefined) {
        await moment($, { station: 'hooks', label: `asked permission for ${e.tool}`, ...span })
      } else if (span.endedAt - span.startedAt >= SLOW_HOOK_MS) {
        await moment($, { station: 'hooks', label: `checked ${e.tool}`, ...span })
      }
    })
    return verdict
  })

  // Background tasks can also report while a turn is in progress. Those reports come through as submitted prompts.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') await taskReported($, e.text)
    return next(e)
  })

  // Settings hooks that put text into the context: with the person's message, or as the session starts.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (addedContext(result.additionalContext)) await moment($, { station: 'hooks', label: 'added context to your message' })
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (addedContext(result.additionalContext)) await moment($, { station: 'hooks', label: 'added context at start' })
    return result
  })

  // The engine says when the cost, the context or a limit moved: the figures follow without asking.
  on('session.measure', async ($, e, next) => {
    await safely(() =>
      noteUsage(
        $,
        {
          ...(typeof e.context.percent === 'number' ? { context: e.context.percent } : {}),
          ...(e.cost !== undefined ? { cost: e.cost.usd } : {}),
          limits: e.rateLimits.map(r => {
            const at = r.resetsAt !== undefined ? Date.parse(r.resetsAt) : Number.NaN
            return { kind: r.kind, percent: r.percentUsed, ...(Number.isFinite(at) ? { resetsAt: at } : {}) }
          }),
        },
        alerts,
      ),
    )
    return next(e)
  })

  // The context is being compacted: the model is at work until it is done, and the figures have changed after.
  on('session.compact', async ($, e, next) => {
    const id = await open($, { station: 'model', label: 'compacting context' })
    try {
      return await next(e)
    } finally {
      const usage = await usageOf($)
      await record($, (b, now) => ({ ...closed(b, id, 'ok', now), ...usage }))
    }
  })

  // The toolbar's region speaks: it is alive, or one of its items was pressed.
  on('ui.message', async ($, e, next) => {
    if ((e.element === 'toolbar' || e.element === 'menu') && typeof e.data === 'object' && e.data !== null) {
      const data = e.data as { hello?: unknown; press?: unknown }
      if (data.hello === true) await safely(() => update($, drawn, () => true))
      const press = data.press
      if (typeof press === 'string') {
        const after = await safely(() => update($, view, x => ({ ...x, ...pressToView(press, x) })))
        if (after !== undefined && press.startsWith('range:') && press !== 'range:menu') void safely(() => $.store.set('range', after.range))
        if (after?.theme !== undefined && press.startsWith('theme:') && press !== 'theme:menu') {
          const theme = after.theme
          void safely(() => $.store.set('theme', theme))
          void safely(() => openPane($, theme, isTerminal))
        }
      }
    }
    return next(e)
  })

  // ---- drawing -------------------------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const b = await read($, board)
    const v = await read($, view)
    await read($, tick)
    const now = await $.clock.now()
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const setView = (patch: Partial<View>): void => {
      void safely(() => update($, view, x => ({ ...x, ...patch })))
      if (patch.range !== undefined) void safely(() => $.store.set('range', patch.range))
      // The toolbar lives at the top: keep the pane there, whatever its window had followed.
      void safely(() => $.ui.scroll({ in: PANE, to: 'start' }))
    }
    const w = windowOf(b, v.range, now)
    const theme = v.theme ?? defaultTheme
    const p = THEMES[theme]
    paintStations(p.stations)
    const rangeLabel = v.range === 'turn' ? 'this turn' : v.range === '5m' ? 'last 5 min' : 'session'

    // The surface's own buttons: what the terminal and the editor use, and what the desktop shows until its own
    // toolbar region has said it is alive. They stay on the surface's ground, where their own colours read.
    const tabs: [Tab, string][] = [['overview', 'Overview'], ['timeline', 'Timeline'], ['files', 'Files'], ['log', 'Log']]
    const used = STATIONS.filter(s => (b.counts[s.id] ?? 0) > 0)
    const follows: (StationId | undefined)[] = [undefined, ...used.map(s => s.id)]
    const nextFollow = follows[(follows.indexOf(v.station) + 1) % follows.length]
    const toolbar = (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" paddingX={1}>
        {tabs.map(([tab, label]) => (
          <Button key={`tab-${tab}`} label={label} variant={v.tab === tab ? 'primary' : 'secondary'} onPress={() => setView({ tab })} />
        ))}
        <Button key="follow" label={`Follow: ${v.station !== undefined ? stationOf(v.station).name : 'all'}`} variant="secondary" onPress={() => setView({ station: nextFollow })} />
        <Select
          key="range"
          label="Window"
          value={v.range}
          options={[
            { value: 'turn', label: 'This turn' },
            { value: '5m', label: 'Last 5 min' },
            { value: 'all', label: 'Session' },
          ]}
          onSelect={value => setView({ range: value as View['range'] })}
        />
      </Box>
    )

    if (isTerminal) {
      const t = b.tokens
      const telemetry = [
        b.cost !== undefined ? `$${b.cost.toFixed(3)}` : '',
        `${formatTokens(t.input + t.cached)} in · ${formatTokens(t.output)} out`,
        b.context !== undefined ? `ctx ${b.context}%` : '',
        b.model !== undefined ? shortModel(b.model) : '',
      ]
        .filter(x => x !== '')
        .join(' · ')
      const lanes = textLanes(b, w, now, columns)
      const rows = b.entries
        .filter(x => (v.station !== undefined ? x.station === v.station : x.station !== 'model' || x.mark === 'switch' || x.status !== 'ok'))
        .slice(-Math.max(4, bodyRows - lanes.length - 8))
        .reverse()
      return (
        <Box flexDirection="column" gap={1}>
          {toolbar}
          <Text mono wrap="truncate-end">{telemetry}</Text>
          <Box flexDirection="column">
            <Text mono dimColor>{`TIMELINE · ${rangeLabel}`}</Text>
            {lanes.length === 0 ? [<Text dimColor>Nothing ran in this window.</Text>] : []}
            {lanes.map(l => (
              <Text mono wrap="truncate-end" dimColor={v.station !== undefined && stationOf(v.station).name !== l.name}>
                {l.name.padEnd(9)}
                <Text color={l.color}>{l.cells}</Text>
              </Text>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text mono dimColor>LOG</Text>
            {rows.map(x => {
              const mark = x.mark === 'switch' ? '◆' : x.status === 'run' ? '▶' : x.status === 'ok' ? '·' : '✕'
              const took = x.endedAt === undefined ? 'live' : x.endedAt - x.startedAt > 0 ? formatMs(x.endedAt - x.startedAt) : ''
              const color = isFailure(x.status) ? ERR : x.status === 'run' ? stationOf(x.station).color : undefined
              return (
                <Text mono color={color} dimColor={x.status === 'ok'} wrap="truncate-end">
                  {`${mark} ${stationOf(x.station).name.padEnd(8)} ${x.label}${took !== '' ? `  ${took}` : ''}`}
                </Text>
              )
            })}
          </Box>
        </Box>
      )
    }

    // Drawn as an image, not a frame: a frame reloads, and so flashes, on every redraw; an image swaps in place and its
    // SMIL animation still runs. Laid out for the pane's own room: its columns wide, and as tall as the rows the
    // toolbar leaves. The surface scales the drawing to the pane's width, so only the shape matters here.
    const live = b.entries.filter(x => x.status === 'run').length
    const alt = `Work atlas, ${v.tab}. ${live === 0 ? 'Nothing is running.' : `${live} running.`} Context ${b.context ?? 0}%.`
    const buttonRows = columns < 72 ? 4 : 2
    const hud = (rows: number): string => drawHud({ board: b, view: v, window: w, rangeLabel, now, core, theme, width: columns * UNIT, height: Math.max(8, rows) * UNIT * cellShape })

    if (e.surface === 'desktop') {
      // The desktop draws the atlas' own toolbar: coloured type on the HUD's ground, clicked where it is drawn.
      const { Svg, Client } = $.ui.resolve(e)
      const strip = layoutToolbar(v, b, columns, theme, p)
      const isDrawn = await read($, drawn)
      const colours = { ground: p.bg, ink: p.ink, dim: p.dim, faint: p.faint }
      return (
        <Box flexDirection="column">
          {isDrawn ? [] : [toolbar]}
          <Box flexDirection="column" backgroundColor={p.bg} position="relative">
            <Client key="toolbar" module="./toolbar.tsx" width="100%" height={strip.length} props={{ rows: strip, ...colours }} />
            <Svg source={hud(bodyRows - strip.length - SPARE_ROWS - (isDrawn ? 0 : buttonRows))} alt={alt} />
            {v.menu !== undefined
              ? [
                  // The open menu floats under its control, over the drawing: nothing below it moves.
                  <Box key="menu-float" position="absolute" top={1} right={v.menu === 'theme' ? menuRight(strip) : 1} width={MENU_WIDTH} backgroundColor={p.menu}>
                    <Client key="menu" module="./toolbar.tsx" width={MENU_WIDTH} height={3} props={{ rows: layoutMenu(v, theme, p), ...colours, ground: p.menu }} />
                  </Box>,
                ]
              : []}
          </Box>
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        <Svg source={hud(bodyRows - buttonRows)} alt={alt} />
      </Box>
    )
  })
}
