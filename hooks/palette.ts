// The three themes. Plain data.
import type { StationId, ThemeId } from '../types'

export type Palette = {
  /** The ground everything is drawn on. */
  bg: string
  /** Cells, lanes and the map's nodes: a step off the ground. */
  panel: string
  /** The faintest rules: grid, empty bars. */
  grid: string
  /** Rules and frames. */
  line: string
  /** Type that is read. */
  ink: string
  /** Type that labels. */
  dim: string
  /** Type and marks that step back. */
  faint: string
  /** The look's own colour: headings, the core, what is chosen. */
  accent: string
  /** The model, and warnings. */
  amber: string
  /** Failures and refusals. */
  err: string
  /** Time spent waiting on the person. */
  wait: string
  /** The ground of an open menu. */
  menu: string
  /** How far marks glow, as a blur's deviation scale: 1 for the neon look, 0 for none. */
  glow: number
  stations: Record<StationId, string>
}

/** Station colours that read on a dark ground. */
const BRIGHT: Record<StationId, string> = {
  you: '#e2e2e2',
  model: '#e0a96d',
  memory: '#4fd1c5',
  files: '#7aa2f7',
  shell: '#9ece6a',
  web: '#5ec8f0',
  browser: '#b48ef7',
  agents: '#f2c94c',
  skills: '#f78fb3',
  hooks: '#ff9e64',
}

export const THEMES: Record<ThemeId, Palette> = {
  // The look the atlas was drawn in first: deep navy, cyan and glow.
  nebula: {
    bg: '#060a12',
    panel: '#0b1220',
    grid: '#16233a',
    line: '#1f3352',
    ink: '#d8ecff',
    dim: '#6f86a6',
    faint: '#34496b',
    accent: '#3ee6ff',
    amber: '#ffb547',
    err: '#ff3d7f',
    wait: '#c3cfe0',
    menu: '#16233a',
    glow: 1,
    stations: BRIGHT,
  },
  // Neutral greys and a warm accent: quiet beside a dark app.
  dark: {
    bg: '#1a1a1c',
    panel: '#232326',
    grid: '#2e2e32',
    line: '#3e3e44',
    ink: '#ededf0',
    dim: '#9c9ca6',
    faint: '#5c5c66',
    accent: '#e08a5b',
    amber: '#e5b567',
    err: '#ff6b6b',
    wait: '#c9c9d1',
    menu: '#2e2e32',
    glow: 0.35,
    stations: BRIGHT,
  },
  // Paper and ink: for a light app. No glow, and station colours deep enough to read on white.
  light: {
    bg: '#faf9f5',
    panel: '#ffffff',
    grid: '#ebe9e0',
    line: '#d3d1c7',
    ink: '#1f1e1d',
    dim: '#66655f',
    faint: '#a8a69c',
    accent: '#c15f3c',
    amber: '#a8620f',
    err: '#d32f4d',
    wait: '#8d8c85',
    menu: '#ebe9e0',
    glow: 0,
    stations: {
      you: '#5b6472',
      model: '#a8620f',
      memory: '#0f8f86',
      files: '#2f5fd0',
      shell: '#3f8f1f',
      web: '#0b84b8',
      browser: '#7a4fd6',
      agents: '#9a7300',
      skills: '#c2417a',
      hooks: '#cf5a14',
    },
  },
}

export const THEME_ORDER: readonly ThemeId[] = ['nebula', 'dark', 'light']

export const isTheme = (v: unknown): v is ThemeId => v === 'nebula' || v === 'dark' || v === 'light'
