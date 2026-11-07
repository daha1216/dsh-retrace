/**
 * Regression tests for the marker preflight's message-projection plumbing.
 *
 * The official replay (`Session.fromRestore`) validates the whole seed, and a
 * plugin-owned message change — `image/offload` today — has no built-in
 * interpreter. Passing five arguments left `projections` empty, so any session
 * that had offloaded an image failed its own preflight with
 * "requires a message projection" and every recall in that session was
 * refused (reported against index 4109). The guard must borrow the host
 * registry and still fail closed when no definition exists anywhere.
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createMarkerGuard } from '../lib/prewrite-guard.js'

const IMAGE_PROJECTION = { type: 'image/offload', project: () => [] }

/** Seed with the plugin-owned message change that needs an interpreter. */
function sessionWithOffload(overrides = {}) {
  return {
    id: 'session-projection-fixture',
    snapshotEvents: () => [
      { seq: 0, type: 'user/message', data: { id: 'm0' } },
      { seq: 1, type: 'image/offload', data: { id: 'm1' } },
    ],
    header: { version: 4 },
    inheritedEventCount: 0,
    ...overrides,
  }
}

/**
 * Stand-in for the host Session: mirrors only the projection requirement the
 * guard has to satisfy, and records every argument tuple it was handed.
 */
function stubSession(calls) {
  return class StubSession {
    static fromRestore(id, seed, header, inherited, eventState, projections) {
      calls.push({ id, seed, header, inherited, eventState, projections })
      const needs = (seed ?? []).filter((event) => event.type === 'image/offload')
      const supplied = Array.isArray(projections) ? projections : []
      for (const event of needs) {
        if (!supplied.some((item) => item.type === event.type)) {
          throw new Error(
            `session event "${event.type}" requires a message projection; load its owning plugin or supply its projection definition`,
          )
        }
      }
      return {
        appended: [],
        append(type, data, meta) {
          this.appended.push({ type, data, meta })
        },
      }
    }
  }
}

const MARKER = { type: 'retrace/marker', data: { id: 'marker' }, surfaceOp: { op: 'append' }, sourceEventSeqs: [] }

test('preflight passes the host message projections into the official replay', async () => {
  const calls = []
  const guard = createMarkerGuard({ sessionCtor: stubSession(calls), projections: () => [IMAGE_PROJECTION] })
  await guard.validateMarkerAppend(sessionWithOffload(), MARKER)

  assert.equal(calls.length, 1)
  const [call] = calls
  // Six arguments, and the borrowed registry arrives whole rather than copied:
  // the host compares definitions by identity when it decides a projection was
  // "removed or replaced".
  assert.equal(call.projections.length, 1)
  assert.equal(call.projections[0], IMAGE_PROJECTION)
  assert.equal(call.eventState, 'shared-frozen')
  assert.equal(call.inherited, 0)
})

test('preflight still fails closed when no projection definition exists', async () => {
  const calls = []
  const guard = createMarkerGuard({ sessionCtor: stubSession(calls), projections: () => [] })
  await assert.rejects(
    () => guard.validateMarkerAppend(sessionWithOffload(), MARKER),
    (error) => {
      assert.equal(error.code, 'marker-rejected')
      assert.match(error.message, /requires a message projection/)
      return true
    },
  )
})

test('a broken registry falls back to the live session borrowed projections', async () => {
  const calls = []
  const guard = createMarkerGuard({
    sessionCtor: stubSession(calls),
    projections: () => {
      throw new Error('registry unloaded mid-write')
    },
  })
  await guard.validateMarkerAppend(sessionWithOffload({ surfaceManager: { projections: [IMAGE_PROJECTION] } }), MARKER)
  assert.equal(calls[0].projections[0], IMAGE_PROJECTION)
})

test('a non-array registry answer falls back instead of disabling the replay', async () => {
  const calls = []
  const guard = createMarkerGuard({
    sessionCtor: stubSession(calls),
    projections: () => null,
  })
  await guard.validateMarkerAppend(sessionWithOffload({ surfaceManager: { projections: [IMAGE_PROJECTION] } }), MARKER)
  assert.deepEqual(calls[0].projections, [IMAGE_PROJECTION])
})

test('sessions without plugin-owned events keep working with an empty registry', async () => {
  const calls = []
  const guard = createMarkerGuard({ sessionCtor: stubSession(calls), projections: () => [] })
  const plain = sessionWithOffload({ snapshotEvents: () => [{ seq: 0, type: 'user/message', data: { id: 'm0' } }] })
  await guard.validateMarkerAppend(plain, MARKER)
  assert.deepEqual(calls[0].projections, [])
})
