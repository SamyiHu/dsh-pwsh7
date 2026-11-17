/**
 * dsh-pwsh7 — keep DSH's `pwsh` tool on PowerShell 7.
 *
 * The bundle patch pins `pwshPath` on the `pwsh-sandbox` row, which is what the
 * shell executor actually spawns. This plugin is the runtime half: it resolves
 * PowerShell 7 again, proves the version by running it, moves its folder to the
 * front of PATH, checks the executor's effective executable, and — when no
 * PowerShell 7 exists — blocks the shell instead of letting it silently run
 * Windows PowerShell 5.1.
 */

import { execFile } from 'node:child_process'
import { lstatSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pwsh7'
export const inject = ['shell']

const TAG = '[dsh-pwsh7]'
const MIN_MAJOR = 7
const PROBE_TIMEOUT_MS = 15_000
const STATUS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'status.json')
const PROBE_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '$PSVersionTable.PSVersion.ToString()',
]

/** Trim a configuration string, treating anything else as absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Candidate executables in preference order, deduplicated case-insensitively. */
function candidates(configured) {
  const seen = new Set()
  const list = []
  const add = (value) => {
    const path = text(value)
    if (path === '' || seen.has(path.toLowerCase())) return
    seen.add(path.toLowerCase())
    list.push(path)
  }
  add(configured)
  add(process.env.DSH_PWSH7_PATH)
  add(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'))
  const localAppData = process.env.LOCALAPPDATA ?? ''
  if (localAppData !== '') {
    add(join(localAppData, 'Programs', 'PowerShell', '7', 'pwsh.exe'))
    add(join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  }
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const folder = entry.trim().replace(/^"|"$/g, '')
    if (folder !== '') add(join(folder, 'pwsh.exe'))
  }
  return list
}

/**
 * Whether the entry can be spawned. lstat does not follow the Microsoft Store
 * execution alias, whose target ACL denies a plain stat but which CreateProcess
 * still resolves.
 */
function spawnable(path) {
  try {
    const stat = lstatSync(path)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Run the candidate and accept it only when it reports PowerShell 7 or newer. */
function probe(path) {
  return new Promise((resolve) => {
    execFile(path, PROBE_ARGS, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      const lines = String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const version = lines.at(-1) ?? ''
      const major = Number.parseInt(version.split('.')[0] ?? '', 10)
      if (!Number.isInteger(major) || major < MIN_MAJOR) {
        resolve(undefined)
        return
      }
      resolve({ version, major })
    })
  })
}

/** Put the executable's folder first in PATH so child processes agree with the pin. */
function preferOnPath(folder) {
  const parts = (process.env.PATH ?? '').split(';').filter(part => part !== '')
  if (parts[0] === folder) return
  process.env.PATH = [folder, ...parts.filter(part => part.toLowerCase() !== folder.toLowerCase())].join(';')
}

/** Record what this boot resolved, so the result is inspectable outside the console. */
function record(report) {
  try {
    writeFileSync(STATUS_FILE, `${JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // A read-only package directory only costs the report, never the pin.
  }
}

/**
 * Resolve PowerShell 7 and verify the shell executor uses it.
 * @param ctx - plugin context; `shell` is injected.
 * @param config - `{ path?: string, strict?: boolean }` from the loader row.
 */
export function apply(ctx, config = {}) {
  const shell = ctx.shell
  const strict = config.strict !== false
  let restore = () => {}

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { restore() })
  }

  // Refusing to run is the point of the plugin: a missing PowerShell 7 must not
  // degrade into Windows PowerShell 5.1 behind the user's back.
  const blockShell = () => {
    const original = shell.execute
    shell.execute = async () => {
      throw new Error(`dsh-pwsh7: PowerShell ${MIN_MAJOR} or newer is required but was not found. Install it with "winget install --id Microsoft.PowerShell -e" and restart DeepSeek Harness.`)
    }
    restore = () => { shell.execute = original }
  }

  void (async () => {
    const checked = []
    let found
    for (const candidate of candidates(config.path)) {
      if (!spawnable(candidate)) continue
      checked.push(candidate)
      const probed = await probe(candidate)
      if (probed !== undefined) {
        found = { path: candidate, ...probed }
        break
      }
    }

    if (found === undefined) {
      console.error(`${TAG} no PowerShell ${MIN_MAJOR}+ found; checked: ${checked.length > 0 ? checked.join(', ') : 'no candidate'}`)
      record({ ok: false, reason: `no PowerShell ${MIN_MAJOR}+ found`, checked })
      if (strict) blockShell()
      return
    }

    preferOnPath(dirname(found.path))

    // The row config pins the executor; read its effective executable back and
    // only touch the live config when the two disagree.
    let effective
    try {
      effective = typeof shell.pwshPath === 'string' ? shell.pwshPath : undefined
    } catch {
      effective = undefined
    }
    if (effective !== undefined && effective.toLowerCase() !== found.path.toLowerCase()) {
      const slot = shell?.config?.pwshPath
      if (slot !== undefined && typeof slot.set === 'function') {
        slot.set(found.path)
        try {
          effective = shell.pwshPath
        } catch {
          effective = undefined
        }
      }
    }

    const ok = effective === undefined || effective.toLowerCase() === found.path.toLowerCase()
    record({ ok, resolvedPath: found.path, version: found.version, effectivePath: effective ?? null, checked })
    if (ok) {
      console.log(`${TAG} PowerShell ${found.version} at ${found.path}${effective === undefined ? ' (executor path not readable)' : ''}`)
      return
    }
    console.error(`${TAG} the shell executor still resolves ${effective ?? 'an unknown executable'} instead of ${found.path}; restart DeepSeek Harness`)
  })().catch((error) => {
    console.error(`${TAG} ${error instanceof Error ? error.message : String(error)}`)
  })
}
