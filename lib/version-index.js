/**
 * dsh-retrace — Version index fold.
 *
 * Rewritten per PLAN.md v0.3 (2026-08-20 revision): the old "hand-written
 * VersionIndex service + custom jsonl index" design is scrapped. This module
 * is the pure fold consumed by the official `ctx.sessionProjections`
 * projection unit (lib/projection/versions.js) — the framework owns the
 * session/event subscription, the per-session watermark cache, checkpoint
 * persistence and cold-read restore; this file owns only deterministic state
 * transitions over one session's committed events.
 *
 * Boundary semantics mirror the official surface fold (`foldSurface` in
 * `@deepseek-ai/dsh-session/surface`): an append pushes the event seq onto
 * the surface; a replace splices [start..end] out and inserts the
 * replacement's own seq. Every replacement event closes a "version" — our
 * markers (recall / edit / regenerate / restore), compaction checkpoints, or
 * any other future surface replacer. Between two boundaries the fold also
 * accumulates the session's touched files (parsing tool calls and tool
 * results), so each version records what artifacts changed in its window.
 *
 * The state is plain JSON only (arrays, no Set/Map) so the projection cache
 * can persist it verbatim (`dsh-session-projection-cache` validates rows
 * with `z.json()`).
 *
 * Envelope shapes come from lib/adapter/normalize.js — the fold itself must not
 * re-implement them (see that file's header for the two marker generations).
 */

import { classifyBoundaryKind, isReplacementSurfaceEvent, surfaceOpOf } from './adapter/normalize.js'

/** Timeline keeps the most recent N versions; full history stays replayable from the log. */
export const VERSION_LIMIT = 200

/**
 * Bounds for model-derived data. Tool arguments are arbitrary model output: a
 * multi-megabyte "path" or a huge editor.text would otherwise be persisted in
 * the projection checkpoint and pushed to the client on every /versions read.
 */
const MAX_TOUCHED_PATH_LENGTH = 1024
const MAX_KNOWN_FILES = 4096
const MAX_MARKER_TEXT_LENGTH = 512

// ---------------------------------------------------------------------------
// Official-equivalent predicates
// ---------------------------------------------------------------------------
// The event-envelope contract lives in lib/adapter/normalize.js (single source
// of truth for BOTH marker generations). This module re-exports it so the fold
// and every reader classify the same log the same way — the previous inline
// copies read `data.message.id` / `surfaceOp.start`, which the current host
// never writes, so recall degraded to `edit` and the fold stopped mirroring
// `foldSurface`.

// ---------------------------------------------------------------------------
// Touched-file extraction (pure)
// ---------------------------------------------------------------------------

/** Tool name → write intent. Unknown tools are ignored unless meta.path says otherwise. */
const WRITE_TOOLS = /(?:^|\.)(fs\.(?:write|edit|create|append)|edit|patch|apply-patch)(?:$|\.)/i
const DELETE_TOOLS = /(?:^|\.)(fs\.(?:remove|delete|rename)|rm|del)(?:$|\.)/i

function classifyToolIntent(name) {
  if (typeof name !== 'string') return null
  if (DELETE_TOOLS.test(name)) return 'delete'
  if (WRITE_TOOLS.test(name)) return 'write'
  return null
}

/** Pull path-like strings out of a tool-call arguments JSON (best effort). */
export function pathsFromToolCallArguments(name, argumentsJson) {
  if (typeof argumentsJson !== 'string' || argumentsJson.length === 0) return []
  let args
  try {
    args = JSON.parse(argumentsJson)
  } catch {
    return []
  }
  if (typeof args !== 'object' || args === null) return []
  const found = new Set()
  // Values under these keys are paths by contract — accepted even without a
  // slash (`README.md`); free-floating strings elsewhere need a slash to be
  // considered path-like (avoids capturing prose like "hello world").
  const PATH_KEYS = new Set(['path', 'paths', 'file_path', 'filepath', 'cwd', 'dirname'])
  const visit = (value, underPathKey) => {
    if (typeof value === 'string') {
      if (value.length === 0 || value.length > MAX_TOUCHED_PATH_LENGTH) return
      // Control characters (NUL/newlines) never belong to a path; keeping them
      // would poison checkpoints and downstream fs calls.
      if (/[\u0000-\u001f]/.test(value)) return
      const looksLikePath = underPathKey
        ? value !== '.' && value !== '..'
        : value.includes('/') && value.length > 1
      if (looksLikePath) found.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, underPathKey)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) {
        if (PATH_KEYS.has(key)) visit(value[key], true)
        else if (typeof value[key] === 'object' && value[key] !== null) visit(value[key], underPathKey)
      }
    }
  }
  visit(args, false)
  return [...found]
}

/**
 * Parse one event's touched-file contribution.
 * @returns {Array<{path: string, intent: 'write'|'delete'|'unknown'}>}
 */
export function touchedFilesFromEvent(event) {
  if (!event) return []
  const { type, data } = event
  const out = []
  if (type === 'tool/call' && data && typeof data.arguments === 'string') {
    const intent = classifyToolIntent(data.name)
    if (intent !== null) {
      for (const path of pathsFromToolCallArguments(data.name, data.arguments)) {
        out.push({ path, intent })
      }
    }
  }
  if (type === 'tool/result' && data) {
    const failed = Boolean(data.error)
    const metaPath = data.meta && typeof data.meta.path === 'string' ? data.meta.path : null
    if (metaPath && !failed) out.push({ path: metaPath, intent: 'write' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Version index fold
// ---------------------------------------------------------------------------

/**
 * @typedef {object} VersionFile
 * @property {string} path        — canonical path relative to the session cwd.
 * @property {'created'|'modified'|'deleted'} mode
 */

/**
 * @typedef {object} VersionRecord
 * @property {string} versionId          — `v<boundarySeq>`.
 * @property {number} boundarySeq        — the replacement event's seq.
 * @property {number} createdAt          — event time (ms), keeps the fold replayable.
 * @property {'recall'|'edit'|'regenerate'|'restore'|'compaction'|'replace'} kind
 * @property {string} markerText         — replaced-content summary (editor.text) or ''.
 * @property {VersionFile[]} touchedFiles
 * @property {number} messageCount       — surface node count at the boundary.
 * @property {null} git                  — P1: { headHash, dirty, diffSha }.
 */

/** Create the empty per-session fold state (plain JSON only). */
export function createVersionIndexState() {
  return {
    versions: [],
    /** path → { intent, lastSeq } — files touched since the last boundary. */
    windowFiles: {},
    /** paths that appeared in any already-finalized version (for created/modified). */
    knownFiles: [],
    /** current surface node seqs (mirrors foldSurface). */
    surface: [],
  }
}

/** Map a window file entry to its version mode against the previous versions. */
function extractMarkerText(event, kind) {
  if (kind === 'compaction') return ''
  const text = event?.data?.editor?.text
  if (typeof text !== 'string') return ''
  return text.length > MAX_MARKER_TEXT_LENGTH ? text.slice(0, MAX_MARKER_TEXT_LENGTH) : text
}

/** Close a version at a replacement boundary (window files frozen, window cleared). */
function freezeVersion(state, event) {
  const boundarySeq = event.seq
  const kind = classifyBoundaryKind(event)
  const knownSet = new Set(state.knownFiles)
  const files = Object.entries(state.windowFiles)
    .map(([path, window]) => ({
      path,
      mode: window.intent === 'delete' ? 'deleted' : knownSet.has(path) ? 'modified' : 'created',
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const record = {
    versionId: `v${boundarySeq}`,
    boundarySeq,
    createdAt: typeof event.time === 'number' ? event.time : 0,
    kind,
    markerText: extractMarkerText(event, kind),
    touchedFiles: files,
    messageCount: state.surface.length,
    git: null,
  }
  const versions = [...state.versions, record]
  if (versions.length > VERSION_LIMIT) versions.splice(0, versions.length - VERSION_LIMIT)
  const knownFiles = [...state.knownFiles]
  for (const file of files) {
    if (knownSet.has(file.path)) continue
    knownSet.add(file.path)
    knownFiles.push(file.path)
  }
  // A session that touches thousands of distinct paths must not grow this list
  // (and the O(n) created/modified check) without bound; drop the oldest names.
  if (knownFiles.length > MAX_KNOWN_FILES) knownFiles.splice(0, knownFiles.length - MAX_KNOWN_FILES)
  return { versions, windowFiles: {}, knownFiles, surface: state.surface }
}

/**
 * Fold one committed event into the version index state.
 *
 * Performance contract (load-bearing for the projection registry): when the
 * event changes nothing — not surface, not files, not a boundary — the SAME
 * state reference is returned (`Object.is` gates the change feed, so a new
 * object means a downstream snapshot/push).
 *
 * @param {ReturnType<typeof createVersionIndexState>} state
 * @param {object} event
 * @returns the next state (same reference when nothing changed).
 */
export function applyVersionIndex(state, event) {
  if (!event || typeof event.seq !== 'number') return state
  let next = state

  // 1. Surface fold (mirror foldSurface): append → push; replace → splice.
  //    surfaceOpOf() accepts both `{start,end}` (legacy markers) and
  //    `{startSeq,endSeq}` (current host) — reading only the legacy pair made
  //    every new marker look like a no-op and the fold diverge from the host.
  const op = surfaceOpOf(event)
  if (op?.op === 'append') {
    next = { ...next, surface: [...next.surface, event.seq] }
  } else if (op?.op === 'replace') {
    const startIdx = next.surface.indexOf(op.start)
    const endIdx = next.surface.indexOf(op.end)
    if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
      const surface = next.surface.slice()
      surface.splice(startIdx, endIdx - startIdx + 1, event.seq)
      next = { ...next, surface }
    }
  }

  // 2. Touched-file window.
  const touched = touchedFilesFromEvent(event)
  if (touched.length > 0) {
    const windowFiles = { ...next.windowFiles }
    for (const { path, intent } of touched) {
      const prev = windowFiles[path]
      if (!prev || event.seq > prev.lastSeq) windowFiles[path] = { intent, lastSeq: event.seq }
    }
    next = { ...next, windowFiles }
  }

  // 3. Version boundary.
  if (isReplacementSurfaceEvent(event)) {
    next = freezeVersion(next, event)
  }

  return next
}

/** Count file modes of one version's touched files (timeline badge input). */
export function countFileModes(touchedFiles) {
  const counts = { created: 0, modified: 0, deleted: 0 }
  for (const file of touchedFiles) {
    if (file.mode === 'created') counts.created += 1
    else if (file.mode === 'modified') counts.modified += 1
    else if (file.mode === 'deleted') counts.deleted += 1
  }
  return counts
}

/**
 * The client-visible wire value (what `ctx.sessionProjections` serves in
 * `session/projection` frames and `snapshot()`). Compact per-version summary
 * plus the full touched-file list (the HTTP `/versions` route serves this
 * same shape; rollback/detail reads files lazily in P1).
 */
export function viewVersionIndex(state) {
  return {
    versions: state.versions.map((record) => ({
      versionId: record.versionId,
      boundarySeq: record.boundarySeq,
      createdAt: record.createdAt,
      kind: record.kind,
      markerText: record.markerText,
      messageCount: record.messageCount,
      fileCounts: countFileModes(record.touchedFiles),
      touchedFiles: record.touchedFiles,
      git: record.git,
    })),
  }
}
