/**
 * dsh-retrace — Rollback executor (PLAN.md §4.5).
 *
 * Rolls a session (and optionally its artifacts) back to a recorded version:
 *
 *   scope 'context'   — append an invisible replacement marker shadowing every
 *                       surface node added AFTER the version boundary, so the
 *                       model-visible history rewinds to that point (git-checkout
 *                       semantics: the rewound content stays in the durable log
 *                       as a later version — non-destructive, auditable).
 *   scope 'artifacts' — restore the files the version's window touched to their
 *                       content at that version: git checkout when the workspace
 *                       is a repository and the version recorded a HEAD, else
 *                       content-addressed snapshot read-back through `ctx.fs`
 *                       (CAS-guarded), with subprocess `rm` for files that were
 *                       deleted in the version's window (realpath-in-workspace +
 *                       in-manifest guards only).
 *   scope 'both'      — context first, then artifacts.
 *
 * Every execution is dry-run-previewable first and records the restore as a new
 * version (kind='restore') in the projection feed, so a rollback is itself a
 * version and can be rolled back again (idempotent per-session lock included).
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { editorError, serializeSession, serializeWorkspace, sessionEvents } from './host-core.js'
import { capabilityMessage, capabilitiesForScope, resolveCapabilities } from './capabilities.js'

const VALID_SCOPES = ['context', 'artifacts', 'both']
/** An undo captures at most this much: past it the rollback simply has no undo. */
const UNDO_MAX_FILES = 32
const UNDO_MAX_BYTES = 16 * 1024 * 1024
/** How long an undo stays available (the seam releases the bytes after this). */
const UNDO_TTL_MS = 30 * 60_000

/**
 * Create the rollback executor.
 * @param {object} deps
 * @param {object} deps.ctx            — host context (ctx.fs / ctx.subprocess / ctx.sandboxPolicy).
 * @param {object} deps.sessions       — session registry (sessions.get / sessions.flush).
 * @param {object} deps.seam           — versioning seam (snapshot / resolveSnapshot /
 *                                       readSnapshot / gitStatus / gitHeadFor).
 * @param {object} [deps.agents]       — agent registry (agents.get) 用于轮次间 marker 的
 *                                       turn 信封推进 agent-loop 计数器（writeMarker 情形③）。
 * @param {Function} [deps.writeMarker] — 遮蔽写入器（adapter 注入；业务层只表达遮蔽意图）。
 * @param {(line: string) => void} [deps.log]
 */
export function createRollbackExecutor({ ctx, sessions, agents, seam, validateMarker, writeMarker, log = () => {}, capabilities = resolveCapabilities(), options = {} }) {
  /**
   * Preview tickets: a plan is executable only after a preview produced it, and
   * only once. The client's span/scope/version are never authoritative — the
   * ticket carries what the server actually planned.
   */
  const PLANS = new Map()
  const PLAN_TTL_MS = options.planTtlMs ?? 5 * 60_000
  let planCounter = 0
  let undoCounter = 0

  /** Refuse a scope whose restore path is gated off in this build. */
  function requireCapabilities(scope) {
    for (const capability of capabilitiesForScope(scope)) {
      if (capabilities?.[capability] !== true) {
        throw editorError('capability-disabled', capabilityMessage(capability))
      }
    }
  }

  /** One in-flight operation per session, shared with the editor entry points. */
  function locked(sessionId, fn) {
    return serializeSession(ctx, sessionId, fn)
  }

  /** Latest boundary the session has reached (plan staleness check). */
  function revisionOf(sessionId) {
    const versions = seam.snapshot(sessionId).versions ?? []
    return versions.at(-1)?.boundarySeq ?? 0
  }

  /** Drop expired tickets; called before every ticket lookup. */
  function prunePlans(now) {
    for (const [id, plan] of PLANS) {
      if (now - plan.createdAt > PLAN_TTL_MS) PLANS.delete(id)
    }
  }

  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw editorError('bad-request', 'sessionId must be a non-empty string')
    }
    const session = sessions.get(sessionId)
    if (!session) throw editorError('session-not-found', `session "${sessionId}" not found`)
    return session
  }

  function requireIdle(sessionId) {
    const agent = seam.agentOf?.(sessionId)
    if (agent && typeof agent.status === 'string' && agent.status === 'running') {
      throw editorError('agent-busy', 'The agent is still responding; stop the current reply before rolling back.')
    }
  }

  function versionOf(sessionId, versionId) {
    const snap = seam.snapshot(sessionId)
    const record = (snap.versions ?? []).find((v) => v.versionId === versionId)
    if (!record) throw editorError('version-not-found', `version "${versionId}" not found in session "${sessionId}"`)
    return record
  }

  function cwdOf(session) {
    return typeof session.header?.cwd === 'string' ? session.header.cwd : null
  }

  /** fs targets are objects ({targetKey, displayPath}); subprocesses need a path. */
  function displayPathOf(target) {
    if (typeof target === 'string') return target
    if (typeof target?.displayPath === 'string') return target.displayPath
    if (typeof target?.targetKey === 'string') return target.targetKey
    return String(target)
  }

  /**
   * Git facts for a rollback: the HEAD recorded at the version boundary (the
   * content we must restore) plus the live status (cwd / dirty detection).
   * A version without recorded facts falls back to content snapshots.
   */
  async function gitFactsFor(sessionId, record) {
    if (!seam.configFor(sessionId).git) return null
    const status = await seam.gitStatus(sessionId)
    // `{repo:false}` is the seam's "adapter is live, this workspace is not a
    // repository" signal: git restore is unavailable, snapshots are not.
    if (!status || status.repo === false) return null
    const facts = await seam.gitHeadFor(sessionId, record.versionId)
    return {
      headHash: facts?.headHash ?? null,
      // Dirty AT THE BOUNDARY: the captured worktree content exists only in the
      // content snapshot; `git checkout <headHash>` would silently replace it
      // with an older committed revision, so those versions must use snapshots.
      boundaryDirty: facts?.dirty === true,
      // Dirty NOW: a checkout would overwrite uncommitted work; execute refuses.
      dirty: status.dirty === true,
    }
  }

  /**
   * The surface diff of "now" vs the version boundary: every current surface
   * node absent from the version's folded surface. An empty diff means the
   * session is already at (or before) that version.
   *
   * Reads through `sessionEvents()` (snapshotEvents on the current host) — the
   * previous `session.events.slice(...)` threw a TypeError on hosts without the
   * legacy `events` array, and a failed read must never look like "nothing to
   * restore".
   */
  function contextDiff(session, record) {
    const events = sessionEvents(session)
    if (!Array.isArray(events) || events.length === 0) {
      throw editorError('log-unavailable', 'The session log is not readable from this host; cannot compute what to restore.')
    }
    // `boundarySeq` is an absolute event seq, not an array index: the host may
    // hand us a windowed log whose first event is far past 0. Slicing by index
    // would then fold the wrong prefix (or the whole window) and report an
    // empty diff, i.e. "nothing to restore" for a rollback that does nothing.
    const boundaryIndex = events.findIndex((event) => event?.seq === record.boundarySeq)
    if (boundaryIndex < 0) {
      throw editorError(
        'log-unavailable',
        `Version ${record.versionId} is outside the readable part of this session log; cannot compute what to restore.`,
      )
    }
    const target = foldSurface(events.slice(0, boundaryIndex + 1))
    const targetNodes = new Set(target.nodes)
    const current = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
    if (current.length === 0) {
      throw editorError('log-unavailable', 'This host exposes no surface for the session; cannot compute what to restore.')
    }
    const diff = current.filter((seq) => !targetNodes.has(seq))
    // A replacement marker can only hide current nodes; it can never bring back
    // a node the surface no longer shows. When the target had nodes the current
    // surface lacks, the only honest answer is to refuse: appending a marker
    // here would report "restored" while the target surface is not reproduced.
    const currentSet = new Set(current)
    const missing = [...targetNodes].filter((seq) => !currentSet.has(seq))
    return {
      messages: diff.length,
      diff,
      firstSeq: diff.length > 0 ? diff[0] : null,
      lastSeq: diff.length > 0 ? diff[diff.length - 1] : null,
      resurrect: missing.length,
      restorable: missing.length === 0,
      missing,
    }
  }

  /** Realpath must stay inside the workspace and match a manifest path. */
  async function workspaceRealpath(session, relPath) {
    const cwd = cwdOf(session)
    if (!cwd) return null
    try {
      const target = await ctx.fs.resolve(relPath, { cwd })
      const root = await ctx.fs.resolve('.', { cwd })
      if (!ctx.fs.contains(root, target)) return null
      return target
    } catch (error) {
      // A recorded tool path may no longer resolve (ENOTDIR when an ancestor
      // became a file, empty/invalid paths, deleted directories). That is a
      // non-restorable file, not a server error: preview must keep working.
      log(`retrace: cannot resolve ${String(relPath)}: ${String(error)}`)
      return null
    }
  }

  /**
   * DSH fs versions are opaque tokens, not numbers: the local provider returns
   * `"dev:ino:size:mtimeNs:ctimeNs"`. The old `typeof version === 'number'`
   * test made every expected version `undefined`, i.e. the CAS guard on writes
   * was dead code.
   */
  function expectedVersionOf(stat) {
    const version = stat?.version
    if (typeof version === 'string' && version.length > 0) return { kind: 'replaceIfVersion', version }
    // Some in-memory providers use numbers; keep them working.
    if (typeof version === 'number') return { kind: 'replaceIfVersion', version }
    return undefined
  }

  /**
   * Reference lookup that also reports whether the capture is provable. Seams
   * without `snapshotState` (older builds) degrade to the bare address.
   */
  async function snapshotRef(seam, session, record, path) {
    if (typeof seam.snapshotState === 'function') {
      return seam.snapshotState(session.id, record.versionId, path)
    }
    const sha = await seam.resolveSnapshot(session.id, record.versionId, path)
    return sha ? { sha256: sha, racy: false } : null
  }

  /** Artifact plan for one version: per file the action and the method. */
  async function artifactPlan(session, record, gitFacts) {
    const rows = []
    const cwd = cwdOf(session)
    const headHash = gitFacts?.headHash
    // `git checkout <headHash> -- <path>` restores the *committed* bytes at the
    // boundary. That is wrong for paths first touched in this window (they may
    // not exist in HEAD at all — checkout then skips them and the old code
    // reported "unchanged") and for boundaries captured with a dirty worktree
    // (HEAD lacks those edits). Both cases go through the content snapshot.
    const gitRestorable = Boolean(headHash) && gitFacts.boundaryDirty !== true
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        const target = cwd ? await workspaceRealpath(session, file.path) : null
        rows.push({
          path: file.path,
          action: 'delete',
          method: 'subprocess',
          safe: target !== null,
        })
        continue
      }
      if (gitRestorable && file.mode !== 'created') {
        // git checkout only works on workspace paths; a tool that touched an
        // absolute path outside the repo must not be advertised as restorable.
        const target = cwd ? await workspaceRealpath(session, file.path) : null
        if (!target) rows.push({ path: file.path, action: 'skip', reason: 'outside-workspace' })
        else rows.push({ path: file.path, action: 'restore', method: 'git', safe: true })
        continue
      }
      const target = cwd ? await workspaceRealpath(session, file.path) : null
      if (!target) {
        rows.push({ path: file.path, action: 'skip', reason: 'outside-workspace' })
        continue
      }
      const state = await snapshotRef(seam, session, record, file.path)
      if (!state?.sha256) rows.push({ path: file.path, action: 'skip', reason: 'no-snapshot' })
      else if (state.racy) rows.push({ path: file.path, action: 'skip', reason: 'snapshot-racy' })
      else rows.push({ path: file.path, action: 'restore', method: 'snapshot', safe: true })
    }
    // `enabled` only when the boundary recorded a HEAD we can actually check
    // out; `dirty` / `boundaryDirty` let the client warn before overwriting
    // uncommitted work.
    const git = gitFacts
      ? {
          enabled: gitRestorable,
          headHash: headHash ?? null,
          dirty: gitFacts.dirty === true,
          boundaryDirty: gitFacts.boundaryDirty === true,
        }
      : { enabled: false }
    return { rows, git }
  }

  /** Dry-run preview: what a rollback would remove / touch (no side effects). */
  async function preview(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    // Preview is a dry-run: it must stay available even when the build may not
    // execute the restore (the client shows the blocked scopes and the execute
    // path re-checks capabilities). Requiring them here made a single-capability
    // setup fail at preview time with capability-disabled.
    const session = requireSession(sessionId)
    const record = versionOf(sessionId, versionId)
    // An artifacts-only rollback does not touch the message surface, so an
    // unreadable/absent event log must not block it (execute computes the diff
    // only for context/both).
    const context = scope === 'artifacts' ? null : contextDiff(session, record)
    const gitFacts = await gitFactsFor(sessionId, record)
    const artifacts = await artifactPlan(session, record, gitFacts)
    const applicable = scope === 'context'
      ? (context?.messages ?? 0) > 0
      : scope === 'artifacts'
        ? artifacts.rows.length > 0
        : (context?.messages ?? 0) > 0 || artifacts.rows.length > 0
    const now = Date.now()
    prunePlans(now)
    const planId = `plan-${now.toString(36)}-${(++planCounter).toString(36)}`
    PLANS.set(planId, {
      planId,
      sessionId,
      versionId,
      scope,
      revision: revisionOf(sessionId),
      createdAt: now,
      used: false,
      restorable: context ? context.restorable : null,
    })
    return {
      planId,
      versionId,
      kind: record.kind,
      boundarySeq: record.boundarySeq,
      scope,
      context,
      artifacts,
      applicable,
      expiresInMs: PLAN_TTL_MS,
    }
  }

  /** Delete one manifest file, after realpath-in-workspace verification. */
  async function removeOne(session, file) {
    const target = await workspaceRealpath(session, file.path)
    if (!target) return { path: file.path, status: 'skipped', reason: 'outside-workspace' }
    const cwd = cwdOf(session)
    if (!cwd) return { path: file.path, status: 'skipped', reason: 'no-cwd' }
    try {
      await ctx.fs.stat(target)
    } catch {
      return { path: file.path, status: 'deleted' } // already gone
    }
    // Prefer the sandboxed fs service; `rm` is not present on every platform.
    if (typeof ctx.fs.remove === 'function') {
      try {
        await ctx.fs.remove(target)
        return { path: file.path, status: 'deleted' }
      } catch (error) {
        log(`retrace: fs.remove failed for ${file.path}, falling back to rm: ${String(error)}`)
      }
    }
    const handle = ctx.subprocess.spawn({
      // `target` is an fs target object, not a path: hand `rm` the display path.
      argv: ['rm', '--', relative(resolve(cwd), resolve(cwd, displayPathOf(target)))],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 15_000,
      signal: undefined,
      env: {},
    })
    const outcome = await handle.done
    return { path: file.path, status: outcome.exitCode === 0 ? 'deleted' : 'failed' }
  }

  /** Restore one snapshot file through the sandboxed fs (CAS-guarded write). */
  async function restoreSnapshot(session, file, sha) {
    const target = await workspaceRealpath(session, file.path)
    if (!target) return { path: file.path, status: 'skipped', reason: 'outside-workspace' }
    const bytes = await seam.readSnapshot(sha)
    // `writeText` is the only public write primitive and it takes a string.
    // Snapshot bytes that are not valid UTF-8 (GBK configs, Latin-1 notes) must
    // be refused, never decoded with replacement characters — that would
    // silently rewrite the file with U+FFFD and report "restored".
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { path: file.path, status: 'skipped', reason: 'binary-unsupported' }
    }
    let expected
    try {
      const stat = await ctx.fs.stat(target)
      expected = expectedVersionOf(stat)
    } catch { /* missing file: plain create */ }
    const policy = ctx.sandboxPolicy?.resolve?.({ session, mode: 'workspace-write' })
    await ctx.fs.writeText(target, text, expected, undefined, policy)
    return { path: file.path, status: 'restored' }
  }

  /**
   * Remember what a rollback is about to overwrite, so it can be undone once.
   * Capture happens strictly before any write: for `git checkout` that means
   * reading every path first, then checking out.
   */
  function undoCollector() {
    const entries = []
    let bytes = 0
    let overflow = false
    return {
      entries,
      get overflow() {
        return overflow
      },
      async capture(session, path) {
        if (overflow) return
        if (entries.length >= UNDO_MAX_FILES) {
          overflow = true
          return
        }
        // Undo may only ever put bytes back inside the workspace. An absolute
        // path outside it is surfaced as outside-workspace by the plan, so it
        // is not captured here (and its content never enters the store).
        const target = await workspaceRealpath(session, path)
        if (!target) return
        try {
          let stat = null
          try {
            stat = await ctx.fs.stat(target)
          } catch {
            stat = null
          }
          if (!stat) {
            // Absent before the rollback: undoing it removes the file again.
            entries.push({ path, sha256: null, sizeBytes: 0, version: null })
            return
          }
          const remaining = Math.max(0, UNDO_MAX_BYTES - bytes)
          if (typeof stat.size === 'number' && stat.size > remaining) {
            overflow = true
            return
          }
          // Bounded read: the budget check above is an early exit, but the file
          // can grow between stat and read, so the read itself is capped too.
          const current = await ctx.fs.readBytes(target, undefined, remaining)
          // Undo writes through `writeText`, so only UTF-8 text can ever be put
          // back. Capturing raw bytes for a binary file produced a ticket whose
          // undo could never succeed (and was retried until its TTL).
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(current)
          } catch {
            overflow = true
            return
          }
          const saved = await seam.saveUndoBytes(current)
          bytes += saved.sizeBytes
          if (bytes > UNDO_MAX_BYTES) {
            overflow = true
            return
          }
          entries.push({
            path,
            sha256: saved.sha256,
            sizeBytes: saved.sizeBytes,
            // Version AT CAPTURE TIME: undo only puts the bytes back when the
            // file still is what the rollback overwrote (CAS).
            version: expectedVersionOf(stat)?.version ?? null,
          })
        } catch (error) {
          // No undo rather than a partial one: an entry we failed to capture
          // would silently restore the wrong content.
          overflow = true
          log(`retrace: undo capture failed for ${path}: ${String(error)}`)
        }
      },
    }
  }

  /** Execute artifact rollback for one version (git first, snapshot fallback). */
  async function rollbackArtifacts(session, record, gitFacts, undo) {
    const results = []
    const cwd = cwdOf(session)
    const gitPaths = []
    const snapshotJobs = []
    const deletes = []
    const headHash = gitFacts?.headHash
    // Same predicate as the preview: git only reproduces committed bytes, so
    // `created` paths and dirty boundaries go through the content snapshot.
    const gitRestorable = Boolean(headHash) && gitFacts.boundaryDirty !== true
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        deletes.push(file)
        continue
      }
      if (gitRestorable && file.mode !== 'created') {
        gitPaths.push(file.path)
        continue
      }
      const state = await snapshotRef(seam, session, record, file.path)
      if (!state?.sha256) results.push({ path: file.path, status: 'skipped', reason: 'no-snapshot' })
      else if (state.racy) results.push({ path: file.path, status: 'skipped', reason: 'snapshot-racy' })
      else snapshotJobs.push({ file, sha: state.sha256 })
    }
    // Capture before writing: git checkout and every snapshot/delete below.
    if (undo) {
      for (const path of gitPaths) await undo.capture(session, path)
      for (const { file } of snapshotJobs) await undo.capture(session, file.path)
      for (const file of deletes) await undo.capture(session, file.path)
    }
    if (gitPaths.length > 0 && cwd && headHash) {
      const outcome = await seam.gitCheckout(cwd, headHash, gitPaths)
      for (const path of gitPaths) {
        if (outcome.ok && outcome.checked.includes(path)) {
          results.push({ path, status: 'restored' })
          continue
        }
        if (!outcome.ok) {
          results.push({ path, status: 'failed' })
          continue
        }
        // The path exists in the worktree but not in the recorded HEAD (a file
        // created outside git's index): checkout skips it. Report `unchanged`
        // only after a snapshot restore proved there is nothing to do.
        const file = record.touchedFiles.find((candidate) => candidate.path === path)
        const state = file ? await snapshotRef(seam, session, record, path) : null
        if (!state?.sha256) {
          results.push({ path, status: 'skipped', reason: 'git-missing' })
          continue
        }
        if (state.racy) {
          results.push({ path, status: 'skipped', reason: 'snapshot-racy' })
          continue
        }
        try {
          results.push(await restoreSnapshot(session, file, state.sha256))
        } catch (error) {
          results.push({ path, status: 'failed', reason: String(error) })
        }
      }
    }
    for (const { file, sha } of snapshotJobs) {
      try {
        results.push(await restoreSnapshot(session, file, sha))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    for (const file of deletes) {
      try {
        results.push(await removeOne(session, file))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    return results
  }

  /**
   * Execute a rollback. The ticket from `preview` is required: it is the only
   * proof that the user saw this exact plan (session, version, scope, revision),
   * it is single-use, and it expires.
   */
  async function execute(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    const planId = String(args?.planId ?? '')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    requireCapabilities(scope)
    return locked(sessionId, async () => {
      const session = requireSession(sessionId)
      requireIdle(sessionId)
      const plan = consumePlan(planId, { sessionId, versionId, scope })
      const record = versionOf(sessionId, versionId)
      const gitFacts = await gitFactsFor(sessionId, record)
      if (scope !== 'context' && gitFacts?.dirty) {
        throw editorError(
          'working-tree-dirty',
          'The workspace has uncommitted changes; commit or discard them before rolling back artifacts.',
        )
      }
      const outcome = { op: 'restore', versionId, scope, markerSeq: null, artifacts: [], context: { messages: 0 } }

      let failure = null
      try {
        if (scope === 'context' || scope === 'both') {
          const { diff, restorable, resurrect } = contextDiff(session, record)
          if (!restorable) {
            throw editorError(
              'restore-unsupported',
              `This version had ${resurrect} message(s) the session no longer shows; a replacement marker cannot bring them back. Use a checkpoint branch instead of rolling the context back.`,
            )
          }
          if (diff.length > 0) {
            const span = { start: diff[0], end: diff[diff.length - 1], shadowedSeqs: diff.slice() }
            if (typeof writeMarker !== 'function') {
              throw editorError('writer-unavailable', 'No marker writer (adapter) is wired; cannot restore context.')
            }
            const markerEvent = await writeMarker(session, span, { op: 'restore', targetSeq: record.boundarySeq, originalText: '' })
            const flushWarning = await flushSafely(session)
            outcome.markerSeq = markerEvent.seq
            outcome.context = { messages: diff.length }
            if (flushWarning) outcome.flushWarning = flushWarning
          }
        }

        if (scope === 'artifacts' || scope === 'both') {
          // Artifact writes are workspace-scoped: two sessions in one workspace
          // must not restore files at the same time.
          const undo = undoCollector()
          const cwd = cwdOf(session)
          try {
            outcome.artifacts = cwd
              ? await serializeWorkspace(ctx, cwd, () => rollbackArtifacts(session, record, gitFacts, undo))
              : await rollbackArtifacts(session, record, gitFacts, undo)
          } catch (error) {
            // The marker may already be written: keep the failure in the audit
            // line even though the op itself still fails.
            outcome.artifactsError = error instanceof Error ? error.message : String(error)
            throw error
          }
          // Only offer an undo when every touched path was captured: a partial
          // undo would put back some files and leave others rolled back.
          if (!undo.overflow && undo.entries.length > 0) {
            const undoId = `undo-${Date.now().toString(36)}-${++undoCounter}`
            await seam.putUndo(undoId, {
              sessionId,
              versionId,
              createdAt: Date.now(),
              entries: undo.entries,
            })
            outcome.undoId = undoId
            outcome.undoExpiresInMs = UNDO_TTL_MS
          }
        }
        return outcome
      } catch (error) {
        failure = error
        throw error
      } finally {
        // Audit every attempt that consumed a ticket, including a partial one:
        // a marker already appended must never be missing from operations.jsonl.
        // The ok/error pair keeps a failed attempt distinguishable from a
        // no-op row (`artifacts: []`, `markerSeq: null`).
        await recordOperation({
          op: 'restore',
          sessionId,
          versionId,
          scope,
          planId,
          ok: failure === null,
          error: failure === null
            ? null
            : {
                code: typeof failure?.code === 'string' ? failure.code : 'internal',
                message: failure instanceof Error ? failure.message : String(failure),
              },
          outcome,
        })
      }
    })
  }

  /** Validate and consume one preview ticket. */
  function consumePlan(planId, expected) {
    if (typeof planId !== 'string' || planId.length === 0) {
      throw editorError('plan-required', 'Preview this rollback first; execute needs the plan id it returned.')
    }
    const now = Date.now()
    prunePlans(now)
    const plan = PLANS.get(planId)
    if (!plan) throw editorError('plan-expired', 'This preview expired or was already used; preview again.')
    if (plan.used) throw editorError('plan-used', 'This preview was already executed; preview again.')
    // A preview with scope `both` shows the message surface AND the file rows;
    // the user narrows it to `context` or `artifacts` in the same dialog. Any
    // subset of what was previewed is therefore a match; a narrower preview
    // still binds to exactly its own scope so an unseen surface is never
    // executed.
    const scopeOk = plan.scope === expected.scope || plan.scope === 'both'
    if (plan.sessionId !== expected.sessionId || plan.versionId !== expected.versionId || !scopeOk) {
      throw editorError('plan-mismatch', 'The request does not match the preview it references; preview again.')
    }
    const revision = revisionOf(expected.sessionId)
    if (revision !== plan.revision) {
      throw editorError('plan-stale', 'The session changed since this preview; preview again.')
    }
    plan.used = true
    return plan
  }

  /**
   * One audit line per executed rollback. Never stores message text or file
   * contents — only ids, scope and per-file status.
   */
  async function recordOperation(entry) {
    try {
      const record = seam.recordOperation
      if (typeof record !== 'function') return
      await record({
        at: Date.now(),
        op: entry.op,
        sessionId: entry.sessionId,
        versionId: entry.versionId,
        scope: entry.scope,
        planId: entry.planId,
        markerSeq: entry.outcome?.markerSeq ?? null,
        contextMessages: entry.outcome?.context?.messages ?? 0,
        flushWarning: entry.outcome?.flushWarning ?? null,
        artifactsError: entry.outcome?.artifactsError ?? null,
        ok: entry.ok !== false,
        error: entry.error ?? null,
        artifacts: (entry.outcome?.artifacts ?? []).map((row) => ({ path: row.path, status: row.status, reason: row.reason ?? null })),
      })
    } catch (error) {
      log(`retrace: operation record failed: ${String(error)}`)
    }
  }

  /**
   * Undo one artifact rollback: put back exactly what it overwrote (and delete
   * what it created). Single use, expires with the seam's undo window.
   */
  async function undo(args) {
    const sessionId = String(args?.sessionId ?? '')
    const undoId = String(args?.undoId ?? '')
    return locked(sessionId, async () => {
      const session = requireSession(sessionId)
      requireIdle(sessionId)
      if (capabilities?.artifactRestore !== true) {
        throw editorError('capability-disabled', capabilityMessage('artifactRestore'))
      }
      if (undoId.length === 0) throw editorError('undo-not-found', 'No undo id was supplied.')
      const record = typeof seam.getUndo === 'function' ? await seam.getUndo(undoId) : null
      if (!record || record.sessionId !== sessionId) {
        throw editorError('undo-not-found', 'This undo expired or was already used.')
      }
      if (Date.now() - (record.createdAt ?? 0) > UNDO_TTL_MS) {
        await seam.deleteUndo?.(undoId)
        throw editorError('undo-expired', 'This undo expired; the bytes are gone.')
      }
      const results = []
      const cwd = cwdOf(session)
      const work = async () => {
        for (const entry of record.entries ?? []) {
          try {
            if (entry.sha256 === null) {
              results.push(await removeOne(session, { path: entry.path }))
              continue
            }
            // Same containment contract as removeOne: the recorded path came
            // from a tool event, so resolve it through the workspace root
            // (realpath) before writing bytes back.
            const target = await workspaceRealpath(session, entry.path)
            if (!target) {
              results.push({ path: entry.path, status: 'failed', reason: 'outside-workspace' })
              continue
            }
            const bytes = await seam.readSnapshot(entry.sha256)
            let text = null
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            } catch {
              results.push({ path: entry.path, status: 'failed', reason: 'binary-unsupported' })
              continue
            }
            // Only restore when the file still matches what the rollback
            // overwrote; otherwise another edit landed in between and the undo
            // would silently discard it.
            const expected = entry.version != null
              ? { kind: 'replaceIfVersion', version: entry.version }
              : undefined
            const policy = ctx.sandboxPolicy?.resolve?.({ session, mode: 'workspace-write' })
            await ctx.fs.writeText(target, text, expected, undefined, policy)
            results.push({ path: entry.path, status: 'restored' })
          } catch (error) {
            results.push({ path: entry.path, status: 'failed', reason: String(error) })
          }
        }
      }
      if (cwd) await serializeWorkspace(ctx, cwd, work)
      else await work()
      const failed = results.filter((row) => row.status === 'failed' || row.status === 'skipped')
      // Keep the ticket when something failed, so a transient filesystem error
      // is retryable instead of silently discarding the only copy of the bytes.
      if (failed.length === 0) await seam.deleteUndo?.(undoId)
      await recordOperation({
        op: 'undo',
        sessionId,
        versionId: record.versionId,
        scope: 'artifacts',
        planId: null,
        ok: failed.length === 0,
        outcome: { artifacts: results, context: { messages: 0 } },
      })
      return { op: 'undo', versionId: record.versionId, artifacts: results, partial: failed.length > 0 }
    })
  }

  async function flushSafely(session) {
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`retrace: flush failed: ${message}`)
      return message
    }
  }

  return { preview, execute, undo }
}
