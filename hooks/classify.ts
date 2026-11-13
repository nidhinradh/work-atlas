// Sorting tool calls: the kind of work each one is, a short label for it, and the file it acted on, if any.
// Pure functions: no engine calls.
import type { Entry, FileOp, StationId } from '../types'

export type Station = { readonly id: StationId; readonly name: string; color: string }

/** Clockwise from the top. The colours here are the default look's; `paintStations` sets another look's. */
export const STATIONS: readonly Station[] = [
  { id: 'you', name: 'You', color: '#e2e2e2' },
  { id: 'model', name: 'Model', color: '#e0a96d' },
  { id: 'memory', name: 'Memory', color: '#4fd1c5' },
  { id: 'files', name: 'Files', color: '#7aa2f7' },
  { id: 'shell', name: 'Shell', color: '#9ece6a' },
  { id: 'web', name: 'Network', color: '#5ec8f0' },
  { id: 'browser', name: 'Browser', color: '#b48ef7' },
  { id: 'agents', name: 'Agents', color: '#f2c94c' },
  { id: 'skills', name: 'Tools', color: '#f78fb3' },
  { id: 'hooks', name: 'Hooks', color: '#ff9e64' },
]

/** Sets every station's colour for the look being drawn: called before each drawing, which is one look throughout. */
export function paintStations(colors: Readonly<Record<StationId, string>>): void {
  for (const s of STATIONS) s.color = colors[s.id]
}

export const stationOf = (id: StationId): Station => STATIONS.find(s => s.id === id) ?? STATIONS[0]!

export type Context = { cwd: string; memoryServers: readonly string[] }

export type Classified = Pick<Entry, 'station' | 'label'> & Partial<Pick<Entry, 'file' | 'mark'>>

/** One printable line, bounded. */
export function clean(text: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const one = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A path as the person would say it: inside the session folder relative to it, the home folder as ~. */
export function shortPath(path: string, cwd: string): string {
  if (cwd !== '' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path.replace(/^\/(Users|home)\/[^/]+/, '~')
}

const isMemoryPath = (path: string): boolean =>
  /\/\.claude\/projects\/[^/]+\/memory\//.test(path) || /(^|\/)MEMORY\.md$/.test(path)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

// ---- shell -------------------------------------------------------------------------------------

/** Prefix commands. `sudo npm test` is judged as `npm test`. */
const WRAPPERS = new Set(['sudo', 'env', 'timeout', 'nohup', 'time', 'nice', 'xargs', 'command', 'exec', 'caffeinate', 'stdbuf'])
const NET = new Set(['curl', 'wget', 'gh', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ping', 'dig', 'nslookup', 'http', 'https', 'telnet', 'ftp', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'])
/** Network only with one of these words after them. */
const NET_SUB: Record<string, readonly string[]> = {
  git: ['push', 'pull', 'fetch', 'clone', 'ls-remote'],
  npm: ['install', 'i', 'ci', 'add', 'publish', 'update'],
  pnpm: ['install', 'i', 'add', 'publish', 'update'],
  yarn: ['install', 'add', 'publish'],
  bun: ['install', 'add', 'i'],
  pip: ['install', 'download'],
  pip3: ['install', 'download'],
  brew: ['install', 'update', 'upgrade'],
  docker: ['pull', 'push', 'login'],
  cargo: ['install', 'fetch', 'publish'],
  go: ['get', 'install'],
}
const FILE_READ = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'egrep', 'fgrep', 'find', 'fd', 'ls', 'tree', 'wc', 'stat', 'file', 'diff', 'du', 'awk', 'jq', 'realpath', 'readlink', 'get-content', 'select-string', 'get-childitem', 'gc', 'sls', 'dir', 'pwd'])
const FILE_WRITE = new Set(['mv', 'cp', 'rm', 'rmdir', 'mkdir', 'touch', 'tee', 'chmod', 'chown', 'ln', 'unlink', 'set-content', 'remove-item', 'copy-item', 'move-item', 'new-item'])

/** The commands of a shell line, each as its words: split at pipes, `;`, `&&`, `||` and into `$(…)`. */
export function commandsOf(line: string): string[][] {
  const flat = line.replace(/\$\(|`/g, ' ; ').replace(/\)/g, ' ')
  return flat
    .split(/\|\||&&|[|;&\n]/)
    .map(part => part.trim().split(/\s+/).filter(w => w !== ''))
    .map(words => {
      let i = 0
      while (i < words.length) {
        const w = words[i]!
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
        else if (WRAPPERS.has(w)) {
          i++
          while (i < words.length && words[i]!.startsWith('-')) i += words[i] === '-n' || words[i] === '-u' ? 2 : 1
          if (w === 'timeout' && i < words.length && /^\d/.test(words[i]!)) i++
        } else break
      }
      return words.slice(i)
    })
    .filter(words => words.length > 0)
}

const nameOf = (word: string): string =>
  word.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')

export function classifyShell(line: string): { station: StationId; op?: FileOp } {
  const cmds = commandsOf(line)
  if (cmds.length === 0) return { station: 'shell' }
  let allFiles = true
  let writes = false
  for (const words of cmds) {
    const name = nameOf(words[0]!)
    if (name === 'npx' && words.includes('-y')) return { station: 'web' }
    if (NET.has(name)) return { station: 'web' }
    const subs = NET_SUB[name]
    if (subs !== undefined && words.slice(1).some(w => subs.includes(w))) return { station: 'web' }
    if (name === 'sed' && words.some(w => w === '-i' || w.startsWith('-i'))) writes = true
    else if (name === 'find' && words.includes('-delete')) writes = true
    else if (FILE_WRITE.has(name)) writes = true
    else if (!FILE_READ.has(name) && name !== 'sed' && name !== 'echo' && name !== 'cd' && name !== 'printf') allFiles = false
  }
  return allFiles ? { station: 'files', op: writes ? 'write' : 'read' } : { station: 'shell' }
}

/** A shell line as a row should name it: without the variables it sets first and the folder it steps into. */
export function shellLabel(line: string): string {
  let rest = line.trim()
  for (let i = 0; i < 8; i++) {
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&]*)\s*(?:;|&&)?\s*|cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:;|&&)\s*)/.exec(rest)
    if (m === null || m[0].length === 0 || m[0].length >= rest.length) break
    rest = rest.slice(m[0].length)
  }
  return rest
}

const lines = (v: unknown): number => (typeof v === 'string' && v !== '' ? v.split('\n').length : 0)

/** How many lines an edit puts in and takes out, read off its arguments: the text itself is never kept. */
export function linesOf(tool: string, input: Record<string, unknown>): { added?: number; removed?: number } {
  if (tool === 'Write') return { added: lines(input.content), removed: 0 }
  if (tool === 'Edit' || tool === 'NotebookEdit') return { added: lines(input.new_string ?? input.new_source), removed: lines(input.old_string) }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0
    let removed = 0
    for (const one of input.edits as Record<string, unknown>[]) {
      added += lines(one?.new_string)
      removed += lines(one?.old_string)
    }
    return { added, removed }
  }
  return {}
}

// ---- tools -------------------------------------------------------------------------------------

const MISC_LABELS: Record<string, string> = {
  TodoWrite: 'update todo list',
  ToolSearch: 'tool search',
  EnterPlanMode: 'plan mode',
}

/** An MCP server's name as the person would read it: an opaque id is left out. */
const serverLabel = (server: string): string => (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(server) ? '' : server)

export function classify(tool: string, input: Record<string, unknown>, ctx: Context): Classified {
  const path = str(input.file_path) ?? str(input.notebook_path)

  if (tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const op: FileOp = tool === 'Read' ? 'read' : 'write'
    if (path === undefined) return { station: 'files', label: tool }
    const short = shortPath(path, ctx.cwd)
    return { station: isMemoryPath(path) ? 'memory' : 'files', label: `${op === 'read' ? '' : '✎ '}${short}`, file: { path: short, op, ...linesOf(tool, input) } }
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const pattern = str(input.pattern) ?? ''
    const where = str(input.path)
    return { station: 'files', label: clean(`${tool === 'Grep' ? 'grep' : 'glob'} ${pattern}${where !== undefined ? ` in ${shortPath(where, ctx.cwd)}` : ''}`) }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = str(input.command) ?? ''
    const label = clean(str(input.description) ?? shellLabel(command), 120)
    if (/\/\.claude\/projects\/[^/]+\/memory\//.test(command)) return { station: 'memory', label }
    const seen = classifyShell(command)
    return { station: seen.station, label }
  }
  if (tool === 'WebFetch') {
    const url = str(input.url) ?? ''
    let host = url
    try {
      host = new URL(url).host
    } catch {
      /* not a URL: shown as written */
    }
    return { station: 'web', label: clean(host) }
  }
  if (tool === 'WebSearch') return { station: 'web', label: clean(`search: ${str(input.query) ?? ''}`) }
  if (tool === 'Agent' || tool === 'Task') {
    return { station: 'agents', label: clean(str(input.description) ?? str(input.subagent_type) ?? 'subagent') }
  }
  if (tool === 'Skill') return { station: 'skills', label: clean(`skill: ${str(input.skill) ?? ''}`) }
  if (tool === 'AskUserQuestion') return { station: 'you', label: 'question for you', mark: 'ask' }
  if (tool === 'ExitPlanMode') return { station: 'you', label: 'plan for your approval', mark: 'ask' }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp !== null) {
    const [, server = '', name = ''] = mcp
    const label = clean([serverLabel(server), name.replace(/_/g, ' ')].filter(x => x !== '').join(' · '))
    if (/browser|chrome|playwright|puppeteer/i.test(server)) return { station: 'browser', label: name.replace(/_/g, ' ') }
    if (ctx.memoryServers.includes(server) || /memory/i.test(server)) return { station: 'memory', label }
    // A server the app runs itself (its own panes, sessions, plugins) reaches no network; an opaque id is a hosted connector.
    const isRemote = serverLabel(server) === '' || /^(https?|remote|cloud)|vercel|github|slack|notion|linear|jira|sentry|exa|search|fetch|web/i.test(server)
    return { station: isRemote ? 'web' : 'skills', label }
  }
  if (/^Task(Create|Update|List|Get|Stop|Output)$|^Monitor$|^Cron/.test(tool)) return { station: 'shell', label: clean(tool) }
  return { station: 'skills', label: MISC_LABELS[tool] ?? clean(tool) }
}

// ---- small formatting ---------------------------------------------------------------------------

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 10) * 10)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** `claude-opus-5-5` → `opus 5.5`. */
export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)(?:[-_.](\d+))?/i.exec(model)
  if (m === null) return model.replace(/^claude-/, '').slice(0, 16)
  return `${m[1]!.toLowerCase()} ${m[2]}${m[3] !== undefined && m[3].length <= 2 ? `.${m[3]}` : ''}`
}
