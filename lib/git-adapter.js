/**
 * dsh-retrace — GitAdapter (PLAN.md §4.4).
 *
 * All git activity rides the host subprocess seam (`ctx.subprocess`):
 * read-only commands (`rev-parse`, `status`, `ls-tree`) run freely; write
 * commands (`init`, `update-ref`, `checkout`, the one-time initial commit)
 * are only ever issued from user-confirmed flows (one-click init, artifact
 * rollback). Nothing here touches the working tree directly — every file
 * change goes through `ctx.fs` (workspace sandbox) or `git checkout` with a
 * strict path allow-list.
 *
 * The adapter is transport-shaped for tests: the caller injects `run` (one
 * spawn spec in → one outcome out) and `writeText` (workspace sandbox write),
 * so the test suite exercises the full decision logic with a fake runner
 * instead of a real git binary.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Minimal `.gitignore` written by the one-click init (never touches user files). */
export const MINIMAL_GITIGNORE = [
  '# created by dsh-retrace (one-click git init) — remove freely',
  'node_modules/',
  'dist/',
  '*.log',
  '',
].join('\n')

const SPILL_LIMIT = 256 * 1024

/** Run-spec → outcome shim over the real host subprocess seam. */
export function createSubprocessRunner(ctx, log = () => {}) {
  const command = async (argv, cwd, signal) => {
    const git = await ctx.subprocess.resolveExecutable('git')
    const handle = ctx.subprocess.spawn({
      argv: [git, ...argv],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 256 * 1024, spill: { maxBytes: SPILL_LIMIT } },
        stderr: { maxBytes: 256 * 1024, spill: { maxBytes: SPILL_LIMIT } },
      },
      graceMs: 30_000,
      signal,
      env: {},
    })
    const outcome = await handle.done
    const collected = handle.collected
    const read = (reader) => {
      const value = reader.readFrom(0)
      return value.text ?? ''
    }
    return {
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      stdout: read(collected.stdout),
      stderr: read(collected.stderr),
    }
  }
  const writeText = async (path, content, expected, sandboxPolicy) => {
    const target = await ctx.fs.resolve(path)
    await ctx.fs.writeText(target, content, expected, undefined, sandboxPolicy)
  }
  return { command, writeText }
}

/**
 * Create the git adapter.
 * @param {object} deps
 * @param {(argv: string[], cwd: string, signal?: AbortSignal) => Promise<{ok:boolean, exitCode?:number, stdout:string, stderr:string}>} deps.command
 * @param {(path: string, content: string, expected: any, sandboxPolicy: any) => Promise<void>} deps.writeText — workspace sandbox write (one-click init's .gitignore).
 * @param {(line: string) => void} [deps.log]
 */
export function createGitAdapter({ command, writeText, log = () => {} }) {
  /** Detect the enclosing repository root from `cwd` (outer repos included). */
  async function detect(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const run = await command(['rev-parse', '--show-toplevel'], cwd)
    if (!run.ok) return null
    const root = run.stdout.trim()
    return root.length > 0 ? root : null
  }

  /**
   * Parse `git status --porcelain -z` output.
   *
   * `-z` is mandatory here: the plain form C-quotes non-ASCII paths (`"\344\270\255"`)
   * and renders renames as `R  old -> new`, so a Chinese filename arrived as an
   * escaped literal that matched nothing on disk. With `-z` each record is
   * `XY <path>` terminated by NUL, and a rename/copy record is followed by one
   * extra NUL-separated field holding the source path.
   */
  function parsePorcelainZ(stdout) {
    const records = []
    const fields = stdout.split('\0')
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]
      if (field.length <= 3) continue
      const code = field.slice(0, 2)
      // Status occupies two columns, then a single space separates the path.
      const path = field.slice(3)
      if (path.length === 0) continue
      let from = null
      if (code[0] === 'R' || code[0] === 'C') from = fields[++index] || null
      records.push({ code, path, ...(from ? { from } : {}) })
    }
    return records
  }

  /**
   * Read-only repo status at `cwd`: HEAD hash + dirty flag + porcelain paths.
   * Returns null when `cwd` is not inside a repository.
   */
  async function status(cwd, signal) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const run = await command(['rev-parse', '--show-toplevel'], cwd, signal)
    if (!run.ok) return null
    const root = run.stdout.trim()
    if (root.length === 0) return null
    const head = await command(['rev-parse', 'HEAD'], cwd, signal)
    if (!head.ok) return { root, headHash: null, dirty: false, paths: [] }
    const headHash = head.stdout.trim()
    const dirtyRun = await command(['status', '--porcelain', '-z', '--untracked-files=normal'], cwd, signal)
    const records = dirtyRun.ok ? parsePorcelainZ(dirtyRun.stdout) : []
    const paths = []
    for (const record of records) {
      for (const path of [record.path, record.from]) {
        if (typeof path === 'string' && path.length > 0 && !paths.includes(path)) paths.push(path)
      }
    }
    const untracked = records.filter((record) => record.code === '??').length
    return { root, headHash, dirty: records.length > 0, paths, untracked, records }
  }

  /** Files present at `headHash` among `paths` (rollback allow-list pre-filter). */
  async function presentAt(cwd, headHash, paths, signal) {
    if (paths.length === 0) return []
    const run = await command(['ls-tree', '-r', '-z', '--name-only', headHash, '--', ...paths], cwd, signal)
    if (!run.ok) return []
    // `-z` keeps UTF-8, spaces, tabs and newlines in filenames lossless.
    const present = new Set(run.stdout.split('\0').filter((p) => p.length > 0))
    return paths.filter((p) => present.has(p))
  }

  /** Git speaks POSIX separators; on Windows `relative()` hands back backslashes. */
  function toGitPath(path) {
    return path.split(sep).join('/')
  }

  /**
   * Guard every path: inside `cwd`, no `..` escape. Absolute paths are accepted
   * when they resolve inside the repository — the version index records the
   * absolute path it captured (`D:\work\app\src\a.ts`), and dropping those
   * silently made every artifact rollback a no-op that still reported success.
   * Returns repository-relative POSIX paths.
   */
  function guardPaths(cwd, paths) {
    const base = resolve(cwd)
    const safe = []
    for (const path of paths) {
      if (typeof path !== 'string' || path.length === 0) continue
      const resolved = resolve(base, path)
      const rel = relative(base, resolved)
      if (rel.length === 0) continue
      if (rel.startsWith('..') || isAbsolute(rel)) continue
      const gitPath = toGitPath(rel)
      // One path can arrive in several shapes (`D:\p\a.ts`, `a.ts`, `a\a.ts`);
      // git rejects a duplicate pathspec pair, and the caller matches results by
      // path, so keep the first occurrence only.
      if (!safe.includes(gitPath)) safe.push(gitPath)
    }
    return safe
  }

  /**
   * Roll `paths` back to their content at `headHash` (`git checkout <hash> -- <paths>`).
   * Only paths present at the commit are touched; absent ones are no-ops.
   * @returns {{ok: boolean, checked: string[], skipped: string[], stderr?: string}}
   */
  async function checkout(cwd, headHash, paths, signal) {
    const safe = guardPaths(cwd, paths)
    if (safe.length === 0) return { ok: true, checked: [], skipped: [] }
    const present = await presentAt(cwd, headHash, safe, signal)
    const skipped = safe.filter((p) => !present.includes(p))
    if (present.length === 0) return { ok: true, checked: [], skipped }
    const run = await command(['checkout', headHash, '--', ...present], cwd, signal)
    if (!run.ok) {
      log(`retrace: git checkout failed: ${run.stderr.trim()}`)
      return { ok: false, checked: [], skipped: safe, stderr: run.stderr }
    }
    return { ok: true, checked: present, skipped }
  }

  /**
   * One-click init for a non-repository workspace: `git init` + a baseline
   * commit + the `refs/dsh/versions` ref (the plugin's own ref; the default
   * branch is only touched by the baseline commit). User files are never
   * overwritten: a `.gitignore` is only created when absent, and the baseline
   * commit is empty when there is nothing to stage. Deleting
   * `refs/dsh/versions` afterwards restores the pre-plugin git state (the
   * baseline commit and `.gitignore` remain).
   * @param {any} [sandboxPolicy] — the calling session's resolved workspace-write policy (needed by sandboxed fs providers).
   * @returns {{ok: boolean, root: string, headHash?: string, already?: boolean, stderr?: string}}
   */
  async function init(cwd, signal, sandboxPolicy) {
    const base = resolve(cwd)
    const existing = await detect(base)
    if (existing) {
      const current = await status(base, signal)
      return { ok: true, root: existing, headHash: current?.headHash ?? undefined, already: true }
    }
    const initRun = await command(['init', '-q'], base, signal)
    if (!initRun.ok) return { ok: false, root: base, stderr: initRun.stderr }
    const gitignoreTarget = join(base, '.gitignore')
    let createdGitignore = false
    try {
      await writeText(gitignoreTarget, MINIMAL_GITIGNORE, { kind: 'createIfAbsent' }, sandboxPolicy)
      createdGitignore = true
    } catch (error) {
      // An existing .gitignore belongs to the user — leave it untouched.
      if (error?.code !== 'FS_NOT_OBSERVED') return { ok: false, root: base, stderr: String(error) }
    }
    if (createdGitignore) {
      const add = await command(['add', '.gitignore'], base, signal)
      if (!add.ok) return { ok: false, root: base, stderr: add.stderr }
    }
    const commit = await command(
      [
        '-c',
        'user.name=dsh-retrace',
        '-c',
        'user.email=dsh-retrace@localhost',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'chore(dsh-retrace): initialize version tracking',
      ],
      base,
      signal,
    )
    if (!commit.ok) return { ok: false, root: base, stderr: commit.stderr }
    const head = await command(['rev-parse', 'HEAD'], base, signal)
    const headHash = head.ok ? head.stdout.trim() : undefined
    if (headHash) {
      await command(['update-ref', 'refs/dsh/versions', headHash], base, signal)
    }
    return { ok: true, root: base, headHash }
  }

  return { detect, status, checkout, init }
}
