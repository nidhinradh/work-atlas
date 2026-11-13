import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Board, Entry } from '../types'
import { atOnce, drawHud } from './hud'
import { classify, classifyShell, formatMs, shortModel } from './classify'
import { breakdown } from './time'
import { THEMES } from './palette'
import { agentLeft, backgroundTaskOf, backgrounded, closed, closedWhere, opened, readTaskNotice, turnBegan, turnEnded } from './ledger'
import { layoutMenu, layoutToolbar, menuRight, pressToView } from './toolbar-layout'
import { folded, kept, peaked, spentAfterTurn, spentWaiting, tallied } from './tally'

const PANE = {
  plugin: 'work-atlas',
  component: 'Pane',
  requestId: 'work-atlas',
  props: { title: 'Work atlas', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 110 }, view: {} },
} as const

const ctx = { cwd: '/repo', memoryServers: ['memory'] }

describe('classify', () => {
  test('files, with paths relative to the session folder', async () => {
    expect(classify('Read', { file_path: '/repo/src/a.ts' }, ctx)).toEqual({ station: 'files', label: 'src/a.ts', file: { path: 'src/a.ts', op: 'read' } })
    expect(classify('Edit', { file_path: '/repo/src/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, ctx).file).toEqual({ path: 'src/a.ts', op: 'write', added: 4, removed: 2 })
    expect(classify('Write', { file_path: '/repo/n.ts', content: 'x\ny\nz' }, ctx).file).toEqual({ path: 'n.ts', op: 'write', added: 3, removed: 0 })
  })
  test('memory files go to memory', async () => {
    expect(classify('Write', { file_path: '/Users/x/.claude/projects/p/memory/a.md' }, ctx).station).toBe('memory')
  })
  test('shell lines by what they run', async () => {
    expect(classifyShell('cat a | grep b').station).toBe('files')
    expect(classifyShell('sudo curl https://x').station).toBe('web')
    expect(classifyShell('git push origin main').station).toBe('web')
    expect(classifyShell('git status').station).toBe('shell')
    expect(classifyShell('npm test').station).toBe('shell')
    expect(classifyShell('rm -rf dist').op).toBe('write')
    expect(classifyShell('echo $(curl x)').station).toBe('web')
  })
  test('tools, MCP and questions', async () => {
    expect(classify('mcp__Claude_Browser__navigate', {}, ctx).station).toBe('browser')
    expect(classify('mcp__memory__search', {}, ctx).station).toBe('memory')
    expect(classify('mcp__github__get_pr', {}, ctx)).toEqual({ station: 'web', label: 'github · get pr' })
    expect(classify('mcp__ccd_turn__wrap_up', {}, ctx)).toEqual({ station: 'skills', label: 'ccd_turn · wrap up' })
    expect(classify('mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch', {}, ctx)).toEqual({ station: 'web', label: 'batch' })
    expect(classify('Bash', { command: 'SP=/tmp/x; cd "$SP" && npm test' }, ctx)).toEqual({ station: 'shell', label: 'npm test' })
    expect(classify('AskUserQuestion', {}, ctx).mark).toBe('ask')
    expect(classify('Agent', { description: 'Explore tests' }, ctx)).toEqual({ station: 'agents', label: 'Explore tests' })
  })
  test('model names', async () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
    expect(shortModel('claude-haiku-5-5-20260101')).toBe('haiku 5.5')
  })
})

describe('breakdown', () => {
  const e = (station: Entry['station'], s: number, t: number, extra: Partial<Entry> = {}): Entry => ({ id: `${station}${s}`, station, label: '', from: 'core', startedAt: s, endedAt: t, status: 'ok', ...extra })
  test('shares overlapping time and counts parallel calls', async () => {
    const b = breakdown([e('model', 0, 1000), e('files', 1000, 3000), e('shell', 2000, 4000)], { from: 0, to: 5000 }, 5000)
    expect(b.parts.model).toBe(1000)
    expect(b.parts.files).toBe(1500)
    expect(b.parts.shell).toBe(1500)
    expect(b.parts.idle).toBe(1000)
    expect(b.parallel).toBe(1000)
    expect(b.peak).toBe(2)
  })
  test('a question counts as waiting, a subagent call counts nothing', async () => {
    const b = breakdown([e('you', 0, 2000, { mark: 'ask' }), e('files', 0, 2000, { from: 'agents' })], { from: 0, to: 2000 }, 2000)
    expect(b.parts.waiting).toBe(2000)
    expect(b.parts.files).toBeUndefined()
  })
})

const start = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]): Promise<void> => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'work-atlas' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
}

describe('the window', () => {
  const now = 1_000_000
  const e = (id: string, station: Entry['station'], label: string, startedAt: number, extra: Partial<Entry> = {}): Entry => ({ id, station, label, from: 'core', startedAt, endedAt: startedAt + 500, status: 'ok', ...extra })
  const board: Board = {
    // An hour ago: an edit and a failed command. Just now: a read.
    entries: [
      e('1', 'files', 'old.ts', now - 3_600_000, { file: { path: 'old.ts', op: 'write', added: 5, removed: 1 } }),
      e('2', 'shell', 'old failing command', now - 3_500_000, { status: 'err' }),
      e('3', 'files', 'new.ts', now - 4_000, { file: { path: 'new.ts', op: 'read' } }),
    ],
    counts: { files: 2, shell: 1 },
    faults: {},
    agents: [],
    files: { 'old.ts': { reads: 0, writes: 1, searches: 0, errs: 0, last: now - 3_600_000, added: 5, removed: 1 }, 'new.ts': { reads: 1, writes: 0, searches: 0, errs: 0, last: now - 4_000 } },
    turns: [{ id: 't', startedAt: now - 5_000 }],
    tokens: { input: 0, output: 0, cached: 0 },
  }
  const draw = (range: 'turn' | 'all', tab: 'overview' | 'files' | 'log'): string =>
    drawHud({ board, view: { tab, range }, window: range === 'all' ? { from: now - 3_700_000, to: now } : { from: now - 5_000, to: now }, rangeLabel: range === 'all' ? 'session' : 'this turn', now, core: 'CLAUDE', theme: 'nebula', width: 520, height: 1600 })

  test('every section under the figures follows it, and says so', async () => {
    const session = draw('all', 'overview')
    const turn = draw('turn', 'overview')
    for (const part of ['old.ts', 'new.ts', 'old failing command', '>PROBLEMS<', 'ACTIVITY MAP']) expect(session).toContain(part)
    expect(turn).toContain('new.ts')
    for (const part of ['old.ts', 'old failing command', '>PROBLEMS<']) expect(turn).not.toContain(part)
    // The map counts the window's calls: two file calls in the session, one in this turn.
    expect(session).toContain('>2 calls<')
    expect(turn).toContain('>1 call<')
    expect(turn).not.toContain('>2 calls<')
  })
  test('the files and the log tabs too', async () => {
    expect(draw('all', 'files')).toContain('old.ts')
    expect(draw('turn', 'files')).not.toContain('old.ts')
    expect(draw('turn', 'files')).toContain('THIS TURN')
    expect(draw('all', 'log')).toContain('old failing command')
    expect(draw('turn', 'log')).not.toContain('old failing command')
  })
})

describe('figures are of the whole of what they name', () => {
  const call = (i: number, startedAt: number): Entry => ({ id: `c${i}`, station: 'files', label: `f${i}`, from: 'core', startedAt, endedAt: startedAt + 100, status: i % 10 === 0 ? 'err' : 'ok' })
  const empty: Board = { entries: [], counts: {}, faults: {}, agents: [], files: {}, turns: [], tokens: { input: 0, output: 0, cached: 0 } }

  test('every call of the current turn and of the last five minutes is kept, however many', async () => {
    const now = 10_000_000
    const turnStart = now - 20 * 60_000
    // 300 calls before the turn, an hour ago; 1500 in the turn, some of them older than five minutes.
    const old = Array.from({ length: 300 }, (_, i) => call(i, now - 3_600_000 + i))
    const inTurn = Array.from({ length: 1500 }, (_, i) => call(1000 + i, turnStart + i * 700))
    const all = kept([...old, ...inTurn], now, turnStart)
    expect(all.filter(e => e.startedAt >= turnStart)).toHaveLength(1500)
    // With no turn going, the last five minutes still are, and the newest 400 besides.
    const idle = kept([...old, ...inTurn], now, undefined)
    expect(idle.filter(e => e.startedAt >= now - 5 * 60_000).length).toBe(inTurn.filter(e => e.startedAt >= now - 5 * 60_000).length)
    expect(idle.length).toBeGreaterThanOrEqual(400)
    expect(idle.length).toBeLessThan(1800)
  })

  test('the session\'s totals count calls that are no longer kept', async () => {
    const now = 50_000_000
    let b: Board = { ...empty, firstAt: now - 40_000_000 }
    // 2000 calls over eleven hours, each ending as it is added: far more than the board keeps.
    for (let i = 0; i < 2000; i++) {
      const e = call(i, now - 40_000_000 + i * 20_000)
      const all = [...b.entries, e]
      const keep = kept(all, e.startedAt, undefined)
      const history = folded(b, all.filter(x => !keep.includes(x)))
      b = { ...b, entries: keep, counts: { files: i + 1 }, ...tallied(b, [e]), ...(history !== undefined ? { history } : {}) }
    }
    // Every call that left the board is in the record: its busy time and the board's add up to all 2000 calls' 100 ms.
    const recorded = (b.history?.busy.files ?? []).reduce((x, y) => x + y, 0)
    const stillKept = b.entries.reduce((x, y) => x + (y.endedAt! - y.startedAt), 0)
    expect(recorded + stillKept).toBe(200_000)
    // Eleven hours in at most 1440 slices: the record stays small.
    expect(b.history!.busy.files!.length).toBeLessThanOrEqual(1440)
    expect(b.entries.length).toBeLessThan(600)
    expect(b.stats?.files).toEqual({ calls: 2000, fails: 200, total: 200_000, max: 100 })

    const hud = drawHud({ board: { ...b, failed: 200 }, view: { tab: 'timeline', range: 'all' }, window: { from: b.firstAt!, to: now }, rangeLabel: 'session', now, core: 'CLAUDE', theme: 'nebula', width: 520, height: 1200 })
    // The table is of all 2000 calls and their 200 failures; the timeline says its older bars are not kept.
    expect(hud).toContain('>2000<')
    expect(hud).toContain('>200<')
    expect(hud).not.toContain('not kept')
  })

  test('the most calls at once is recorded per slice, while the calls are still there', async () => {
    const t0 = 2_000_000
    const tool = (id: string, s: number, d: number): Entry => ({ id, station: 'shell', label: '', from: 'core', startedAt: t0 + s, endedAt: t0 + s + d, status: 'ok' })
    // Three calls overlap in the first slice; one runs alone in the fourth.
    const board: Board = { ...empty, firstAt: t0, entries: [tool('a', 0, 5000), tool('b', 1000, 5000), tool('c', 2000, 1000), tool('d', 31_000, 2000)] }
    const h = peaked(board, t0 + 40_000)
    expect(h?.peak.slice(0, 4)).toEqual([3, 0, 0, 1])
    expect(h?.peakUntil).toBe(t0 + 40_000)
  })

  test('"at once" is calls running at the same moment, not calls that touch the same stretch', async () => {
    const tool = (id: string, s: number, d: number): Entry => ({ id, station: 'shell', label: '', from: 'core', startedAt: s, endedAt: s + d, status: 'ok' })
    // Ten calls one after another inside one column: never more than one at once. Then two that overlap.
    const serial = Array.from({ length: 10 }, (_, i) => tool(`s${i}`, i * 100, 90))
    expect(atOnce([...serial, tool('a', 5000, 2000), tool('b', 6000, 2000)], { from: 0, to: 10_000 }, 2, 10_000)).toEqual([1, 2])
  })

  test('where the session\'s time went adds up turn by turn', async () => {
    const t0 = 1_000_000
    const turn1: Board = { ...empty, entries: [{ id: 'm', station: 'model', label: '', from: 'core', startedAt: t0, endedAt: t0 + 4000, status: 'ok' }, { id: 's', station: 'shell', label: '', from: 'core', startedAt: t0 + 4000, endedAt: t0 + 10_000, status: 'ok' }], turns: [{ id: '1', startedAt: t0 }] }
    const afterTurn = spentAfterTurn(turn1, t0, t0 + 10_000)
    expect(afterTurn.parts).toEqual({ model: 4000, shell: 6000 })
    // Thirty seconds pass before the next message: that is time spent waiting on the person.
    const waiting = spentWaiting({ ...turn1, spent: afterTurn, turns: [{ id: '1', startedAt: t0, endedAt: t0 + 10_000 }] }, t0 + 40_000)
    expect(waiting?.parts).toEqual({ model: 4000, shell: 6000, waiting: 30_000 })
  })
})

describe('the ledger', () => {
  const start: Board = { entries: [], counts: {}, faults: {}, agents: [], files: {}, turns: [], tokens: { input: 0, output: 0, cached: 0 } }

  test('a call opens, closes, and is counted once', async () => {
    let b = opened(start, 'a', { station: 'shell', label: 'npm test' }, 1000)
    expect(b.entries[0]).toEqual({ id: 'a', station: 'shell', label: 'npm test', from: 'core', startedAt: 1000, status: 'run' })
    expect(b.counts).toEqual({ shell: 1 })
    b = closed(b, 'a', 'ok', 4000)
    expect(b.entries[0]!.endedAt).toBe(4000)
    expect(b.stats?.shell).toEqual({ calls: 1, fails: 0, total: 3000, max: 3000 })
    // Closing it again, or closing a call that was never opened, changes nothing.
    expect(closed(b, 'a', 'err', 9000)).toBe(b)
    expect(closed(b, 'nobody', 'err', 9000)).toBe(b)
  })

  test('a failure shows on its station until the next message, and stays in the session\'s count', async () => {
    let b = opened(start, 'a', { station: 'files', label: 'x.ts', file: { path: 'x.ts', op: 'write', added: 3, removed: 1 } }, 1000)
    b = closed(b, 'a', 'err', 1500)
    expect(b.faults).toEqual({ files: 1 })
    expect(b.failed).toBe(1)
    expect(b.files['x.ts']).toEqual({ reads: 0, writes: 1, searches: 0, errs: 1, last: 1500, added: 3, removed: 1 })
    b = turnBegan(b, 't2', 2000)
    expect(b.faults).toEqual({})
    expect(b.failed).toBe(1)
  })

  test('a turn\'s end closes what never reported back, but not a background task', async () => {
    let b = turnBegan(start, 't1', 0)
    b = opened(b, 'stuck', { station: 'shell', label: 'interrupted' }, 100)
    b = opened(b, 'bg', { station: 'shell', label: 'dev server' }, 200)
    b = backgrounded(b, 'bg', 'task-7')
    b = turnEnded(b, 5000, true)
    expect(b.entries.find(e => e.id === 'stuck')!.status).toBe('ok')
    expect(b.entries.find(e => e.id === 'bg')!.status).toBe('run')
    expect(b.turns[0]).toEqual({ id: 't1', startedAt: 0, endedAt: 5000, aborted: true })
    // The task reports that it failed: its call ends as a failure.
    b = closedWhere(b, e => e.task === 'task-7', 'err', 9000)
    expect(b.entries.find(e => e.id === 'bg')).toMatchObject({ status: 'err', endedAt: 9000 })
    expect(b.failed).toBe(1)
  })

  test('a subagent that ends leaves the list, and its open calls end', async () => {
    let b = opened(start, 'm', { station: 'model', label: 'step 1', from: 'agents', agentId: 'ag1' }, 0)
    expect(b.agents).toEqual(['ag1'])
    b = agentLeft(b, 'ag1', 700)
    expect(b.agents).toEqual([])
    expect(b.entries[0]).toMatchObject({ status: 'ok', endedAt: 700 })
  })

  test('background tasks are read off a tool\'s result', async () => {
    expect(backgroundTaskOf({ stdout: '', backgroundTaskId: 'bash_3' })).toBe('bash_3')
    expect(backgroundTaskOf({ status: 'async_launched', agentId: 'agent-9', description: 'x' })).toBe('agent-9')
    expect(backgroundTaskOf({ stdout: 'done' })).toBeUndefined()
    expect(backgroundTaskOf('text')).toBeUndefined()
    expect(backgroundTaskOf({ backgroundTaskId: 'has spaces' })).toBeUndefined()
  })

  test('a task notification gives the task and how it ended, and nothing else', async () => {
    expect(readTaskNotice('<task-notification>\n<task-id>bash_3</task-id>\n<status>completed</status>\n<summary>secret output</summary>\n</task-notification>')).toEqual({ task: 'bash_3', outcome: 'ok' })
    expect(readTaskNotice('<task-notification><task-id>bash_3</task-id><status>failed</status></task-notification>')).toEqual({ task: 'bash_3', outcome: 'err' })
    expect(readTaskNotice('<task-notification><task-id>mon_1</task-id></task-notification>')).toEqual({ task: 'mon_1' })
    expect(readTaskNotice('please fix the <task-id>x</task-id> bug')).toBeUndefined()
  })
})

describe('a long or resumed session', () => {
  test('durations read in the largest units that fit', async () => {
    expect(formatMs(420)).toBe('420 ms')
    expect(formatMs(4_200)).toBe('4.2 s')
    expect(formatMs(59_600)).toBe('60 s')
    expect(formatMs(73_000)).toBe('1m 13s')
    expect(formatMs(3_599_600)).toBe('1h 00m')
    expect(formatMs(2 * 3_600_000 + 5 * 60_000)).toBe('2h 05m')
    // 33521 minutes and 43 seconds: twenty-three days, not a five-digit count of minutes.
    expect(formatMs(33_521 * 60_000 + 43_000)).toBe('23d 7h')
  })

  const now = 5_000_000_000
  const base: Board = { entries: [], counts: { shell: 4 }, faults: {}, agents: [], files: {}, turns: [], tokens: { input: 0, output: 0, cached: 0 }, cost: 471.85, context: 52 }
  const draw = (board: Board): string => drawHud({ board, view: { tab: 'overview', range: 'all' }, window: { from: now - 60_000, to: now }, rangeLabel: 'session', now, core: 'CLAUDE', theme: 'nebula', width: 520, height: 900 })

  test('a session joined late says which figures are of all of it and which of what was watched', async () => {
    // Begun 23 days ago; Work Atlas first ran in it twelve minutes ago.
    const hud = draw({ ...base, startedAt: now - 33_521 * 60_000, watchedFrom: now - 12 * 60_000 })
    expect(hud).toContain('SESSION AGE')
    expect(hud).toContain('>23d 7h<')
    expect(hud).toContain('watched 12m')
    expect(hud).toContain('This session began 23d ago.')
    expect(hud).toContain('has watched the last 12m.')
    expect(hud).not.toContain('/hour')
  })

  test('a session watched from its start carries no such note', async () => {
    const hud = draw({ ...base, startedAt: now - 20 * 60_000, watchedFrom: now - 20 * 60_000 + 5_000 })
    expect(hud).toContain('>SESSION<')
    expect(hud).not.toContain('This session began')
  })

  test('on a subscription the dollar figure is what the work was worth, not a charge', async () => {
    const onPlan = draw({ ...base, limits: [{ kind: 'seven_day', percent: 6 }] })
    expect(onPlan).toContain('API VALUE')
    expect(onPlan).toContain('>not billed<')
    const onApi = draw(base)
    expect(onApi).toContain('>COST<')
    expect(onApi).toContain('>whole session<')
  })
})

describe('toolbar layout', () => {
  const board = { entries: [], counts: { files: 2, shell: 1 }, faults: {}, agents: [], files: {}, turns: [], tokens: { input: 0, output: 0, cached: 0 } }
  const p = THEMES.nebula
  test('the title with the look and the window at its right, and the tabs under it', async () => {
    const rows = layoutToolbar({ tab: 'overview', range: 'all' }, board, 64, 'nebula', p)
    expect(rows.map(r => r.map(i => `${i.x}:${i.label}:${i.id}`))).toEqual([
      ['1:◢ WORK ATLAS:', '40:◐ NEBULA ▾:theme:menu', '52:◷ SESSION ▾:range:menu'],
      ['1:OVERVIEW:tab:overview', '11:TIMELINE:tab:timeline', '21:FILES:tab:files', '28:LOG:tab:log'],
    ])
    expect(rows[1]![0]!.isOn).toBe(true)
  })
  test('an open menu adds no row: it floats, with the chosen one ticked', async () => {
    const open = { tab: 'overview', range: 'all', menu: 'range' } as const
    const rows = layoutToolbar(open, board, 64, 'nebula', p)
    expect(rows).toHaveLength(2)
    expect(rows[0]![2]!.label).toBe('◷ SESSION ▴')
    expect(layoutMenu(open, 'nebula', p).map(r => `${r[0]!.label}:${r[0]!.id}`)).toEqual(['   THIS TURN  :range:turn', '   LAST 5 MIN :range:5m', ' ✓ SESSION    :range:all'])
    expect(layoutMenu({ ...open, menu: 'theme' }, 'dark', p).map(r => `${r[0]!.label}:${r[0]!.id}`)).toEqual(['   NEBULA     :theme:nebula', ' ✓ DARK       :theme:dark', '   LIGHT      :theme:light'])
    // The look's menu ends under its own control, which ends 14 columns from the right edge.
    expect(menuRight(rows)).toBe(14)
  })
  test('a narrow pane keeps the look as its mark alone', async () => {
    expect(layoutToolbar({ tab: 'overview', range: '5m' }, board, 36, 'light', THEMES.light)[0]!.map(i => i.label)).toEqual(['◢ WORK ATLAS', '◐ ▾', '◷ LAST 5 MIN ▾'])
  })
  test('the log adds the stations to follow', async () => {
    const rows = layoutToolbar({ tab: 'log', range: 'all' }, board, 64, 'nebula', p)
    expect(rows[2]!.map(i => `${i.x}:${i.label}`)).toEqual(['1:ALL', '6:FILES', '15:SHELL'])
  })
  test('presses name a change of view, and nothing else', async () => {
    const view = { tab: 'overview', range: 'all' } as const
    expect(pressToView('tab:log', view)).toEqual({ tab: 'log', menu: undefined })
    expect(pressToView('range:menu', view)).toEqual({ menu: 'range' })
    expect(pressToView('range:menu', { ...view, menu: 'range' })).toEqual({ menu: undefined })
    expect(pressToView('theme:menu', { ...view, menu: 'range' })).toEqual({ menu: 'theme' })
    expect(pressToView('range:5m', view)).toEqual({ range: '5m', menu: undefined })
    expect(pressToView('theme:light', view)).toEqual({ theme: 'light', menu: undefined })
    expect(pressToView('theme:nonsense', view)).toBeUndefined()
    expect(pressToView('st:all', view)).toEqual({ station: undefined, menu: undefined })
    expect(pressToView('st:files', view)).toEqual({ station: 'files', menu: undefined })
    expect(pressToView('st:nonsense', view)).toBeUndefined()
  })
})

test('desktop: the toolbar is drawn by the atlas and clicked where it is drawn', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const hud = async (): Promise<string> => JSON.stringify(await ui.find({ type: 'Svg' }))

  // Overview holds every section when the pane is tall.
  for (const part of ['CONTEXT USED', 'TOOL CALLS', 'FILES EDITED', 'TIMELINE', 'WHERE THE TIME WENT', 'ACTIVITY BY TYPE', 'FILES TOUCHED', 'LATEST ACTIVITY', 'src/auth.ts', 'npm test']) expect(await hud()).toContain(part)

  // Once the region has said hello, the surface's own buttons are gone.
  expect(await ui.find({ type: 'Button', key: 'tab-log' })).toBeUndefined()

  // The tabs are the second row, under the title.
  await ui.pointer({ type: 'down', x: 29, y: 1, button: 'left' })
  expect(await hud()).toContain('>ACTIVITY LOG<')
  expect(await hud()).not.toContain('WHERE THE TIME WENT')
  await ui.pointer({ type: 'down', x: 22, y: 1, button: 'left' })
  expect(await hud()).toContain('BUSIEST FOLDERS')

  // On the log, the stations to follow are the third row.
  await ui.pointer({ type: 'down', x: 29, y: 1, button: 'left' })
  await ui.pointer({ type: 'down', x: 8, y: 2, button: 'left' })
  expect(await hud()).toContain('FILES · ')
  expect(await hud()).not.toContain('npm test')
  await ui.pointer({ type: 'down', x: 2, y: 2, button: 'left' })
  expect(await hud()).toContain('npm test')

  // The window is a menu at the title's right: it starts on the session, and opens in a region of its own.
  await ui.pointer({ type: 'down', x: 12, y: 1, button: 'left' })
  expect(await hud()).toContain('SESSION · ')
  const height = (await hud()).match(/viewBox=..0 0 \d+ (\d+)/)?.[1]
  await ui.pointer({ type: 'down', x: 55, y: 0, button: 'left', in: 'toolbar' })
  // Open, the drawing under it keeps its size: nothing moved.
  expect((await hud()).match(/viewBox=..0 0 \d+ (\d+)/)?.[1]).toBe(height)
  await ui.pointer({ type: 'down', x: 5, y: 1, button: 'left', in: 'menu' })
  expect(await hud()).toContain('LAST 5 MIN · ')
  await ui.pointer({ type: 'down', x: 55, y: 0, button: 'left', in: 'toolbar' })
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'menu' })
  expect(await hud()).toContain('THIS TURN · ')

  // The look is a menu too, left of the window's.
  expect(await hud()).toContain(THEMES.nebula.bg)
  await ui.pointer({ type: 'down', x: 43, y: 0, button: 'left', in: 'toolbar' })
  await ui.pointer({ type: 'down', x: 5, y: 1, button: 'left', in: 'menu' })
  expect(await hud()).toContain(THEMES.dark.bg)
  await ui.pointer({ type: 'down', x: 43, y: 0, button: 'left', in: 'toolbar' })
  await ui.pointer({ type: 'down', x: 5, y: 2, button: 'left', in: 'menu' })
  expect(await hud()).toContain(THEMES.light.bg)
  expect(await hud()).toContain(THEMES.light.stations.files)

  // A click on the title or on empty ground changes nothing.
  await ui.pointer({ type: 'down', x: 4, y: 0, button: 'left' })
  await ui.pointer({ type: 'down', x: 45, y: 1, button: 'left' })
  expect(await hud()).toContain('THIS TURN · ')
  expect(await hud()).toContain('AT ONCE')
  await ui.unmount()
})

test('the look and the window chosen in an earlier session come back', async ($, on) => {
  mock.store(on, { theme: 'light', range: 'turn' })
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const hud = JSON.stringify(await ui.find({ type: 'Svg' }))
  expect(hud).toContain(THEMES.light.bg)
  expect(hud).toContain('THIS TURN · ')
  await ui.unmount()
})

test('where the atlas cannot draw its own toolbar, the surface\'s buttons do the same', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const hud = async (): Promise<string> => JSON.stringify(await ui.find({ type: 'Svg' }))
  await ui.press({ key: 'tab-log' })
  expect(await hud()).toContain('>ACTIVITY LOG<')
  await ui.press({ key: 'follow' })
  expect(await hud()).toContain('FILES · ')
  expect(await hud()).not.toContain('npm test')
  await ui.press({ key: 'tab-timeline' })
  expect(await hud()).toContain('SESSION · ')
  await ui.select({ key: 'range', value: '5m' })
  expect(await hud()).toContain('LAST 5 MIN · ')
  await ui.unmount()

  // The terminal draws no SVG, only text.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /TIMELINE/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /src\/auth\.ts/ })).toBeDefined()
  await term.unmount()
})
