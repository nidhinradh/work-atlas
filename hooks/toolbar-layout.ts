// Toolbar layout: the column each control starts at, for a given pane width.
// Pure functions: no engine calls.
import type { Board, Range, StationId, Tab, ThemeId, View } from '../types'
import { STATIONS } from './classify'
import { THEME_ORDER, isTheme } from './palette'
import type { Palette } from './palette'

export type ToolbarItem = { id: string; label: string; x: number; color: string; isOn: boolean; dot: string; ground: string }

export const TABS: readonly [Tab, string][] = [['overview', 'OVERVIEW'], ['timeline', 'TIMELINE'], ['files', 'FILES'], ['log', 'LOG']]
export const RANGES: readonly [Range, string][] = [['turn', 'THIS TURN'], ['5m', 'LAST 5 MIN'], ['all', 'SESSION']]

const TITLE = '◢ WORK ATLAS'

type Loose = Omit<ToolbarItem, 'x'>

/** The words of the window's menu, each as wide as the others. */
const menuLabel = (name: string, isOn: boolean): string => ` ${isOn ? '✓' : ' '} ${name.padEnd(11)}`
export const MENU_WIDTH = menuLabel('', false).length

/**
 * The toolbar's rows: the title, with the look and the window at its right; then the tabs. The window opens a menu
 * of its three choices, which `layoutMenu` lays out to float under it. The log alone adds the stations to follow,
 * since that is where a filter is read.
 */
export function layoutToolbar(view: View, board: Board, columns: number, theme: ThemeId, p: Palette): ToolbarItem[][] {
  const width = Math.max(24, columns)
  const widthOf = (item: Loose): number => item.label.length + (item.dot === '' ? 0 : 2)
  const control = `◷ ${RANGES.find(([range]) => range === view.range)?.[1] ?? 'SESSION'} ${view.menu === 'range' ? '▴' : '▾'}`
  const controlX = Math.max(TITLE.length + 3, width - control.length - 1)
  // The look: its name where there is room, its mark alone where there is not.
  const arrow = view.menu === 'theme' ? '▴' : '▾'
  const named = `◐ ${theme.toUpperCase()} ${arrow}`
  const look = controlX - 2 - named.length >= TITLE.length + 3 ? named : controlX - 5 >= TITLE.length + 2 ? `◐ ${arrow}` : ''
  const rows: ToolbarItem[][] = [
    [
      { id: '', label: TITLE, color: p.accent, isOn: true, dot: '', ground: '', x: 1 },
      ...(look === '' ? [] : [{ id: 'theme:menu', label: look, color: p.ink, isOn: view.menu === 'theme', dot: '', ground: '', x: controlX - 2 - look.length }]),
      { id: 'range:menu', label: control, color: p.ink, isOn: view.menu === 'range', dot: '', ground: '', x: controlX },
    ],
    [],
  ]
  let x = 1
  for (const [tab, label] of TABS) {
    rows[1]!.push({ id: `tab:${tab}`, label, color: p.accent, isOn: view.tab === tab, dot: '', ground: '', x })
    x += label.length + 2
  }

  if (view.tab === 'log') {
    const used = STATIONS.filter(s => (board.counts[s.id] ?? 0) > 0)
    const chips: Loose[] = [
      { id: 'st:all', label: 'ALL', color: p.ink, isOn: view.station === undefined, dot: '', ground: '' },
      ...used.map(s => ({ id: `st:${s.id}`, label: s.name.toUpperCase(), color: p.ink, isOn: view.station === s.id, dot: s.color, ground: '' })),
    ]
    rows.push([])
    x = 1
    for (const item of chips) {
      if (x + widthOf(item) > width - 1 && rows[rows.length - 1]!.length > 0) {
        rows.push([])
        x = 1
      }
      rows[rows.length - 1]!.push({ ...item, x })
      x += widthOf(item) + 2
    }
  }
  return rows
}

/** The open menu: one choice a row, the chosen one ticked. Drawn in a region of its own, over what is under it. */
export function layoutMenu(view: View, theme: ThemeId, p: Palette): ToolbarItem[][] {
  const choices: [string, string, boolean][] =
    view.menu === 'theme' ? THEME_ORDER.map(t => [`theme:${t}`, t.toUpperCase(), t === theme]) : RANGES.map(([range, name]) => [`range:${range}`, name, view.range === range])
  return choices.map(([id, name, isOn]) => [{ id, label: menuLabel(name, isOn), color: p.ink, isOn, dot: '', ground: p.menu, x: 0 }])
}

/** How far from the toolbar's right edge the look's menu hangs, so that it ends under its own control. */
export function menuRight(rows: ToolbarItem[][]): number {
  const control = rows[0]?.find(item => item.id === 'range:menu')
  const look = rows[0]?.find(item => item.id === 'theme:menu')
  if (control === undefined || look === undefined) return 1
  return Math.max(1, control.label.length + 1 + (control.x - (look.x + look.label.length)))
}

/** What a press on a toolbar item asks of the view; nothing for an id it does not know. Any choice closes the menu. */
export function pressToView(id: string, view: View): Partial<View> | undefined {
  const [kind, value] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
  if (id === 'range:menu') return { menu: view.menu === 'range' ? undefined : 'range' }
  if (id === 'theme:menu') return { menu: view.menu === 'theme' ? undefined : 'theme' }
  if (kind === 'theme' && isTheme(value)) return { theme: value, menu: undefined }
  if (kind === 'tab' && TABS.some(([tab]) => tab === value)) return { tab: value as Tab, menu: undefined }
  if (kind === 'range' && RANGES.some(([range]) => range === value)) return { range: value as Range, menu: undefined }
  if (kind === 'st' && value === 'all') return { station: undefined, menu: undefined }
  if (kind === 'st' && STATIONS.some(s => s.id === value)) return { station: value as StationId, menu: undefined }
  return undefined
}
