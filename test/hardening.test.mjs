/**
 * Regression tests for the 0.4.79 hardening pass.
 *
 * Covers the pure helpers introduced for the audit findings: loopback request
 * gating (Host header alone is forgeable), caller-span stripping, malformed
 * tool arguments in fold summaries, and bounded model-derived paths in the
 * version index.
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { hostNameOf, isLoopbackRequest, loopbackAddress, withoutClientSpan } from '../lib/request-guard.js'
import { buildFoldSummary } from '../lib/fold-summary.js'
import { applyVersionIndex, createVersionIndexState, pathsFromToolCallArguments } from '../lib/version-index.js'
import { parseEpoch } from '../lib/capture-epoch.js'

/** Minimal request shape: only the fields the gate reads. */
function request(remoteAddress, host, headers = {}) {
  return { socket: { remoteAddress }, headers: { host, ...headers } }
}

test('loopbackAddress accepts loopback forms and rejects everything else', () => {
  assert.equal(loopbackAddress('127.0.0.1'), true)
  assert.equal(loopbackAddress('127.9.9.9'), true)
  assert.equal(loopbackAddress('::1'), true)
  assert.equal(loopbackAddress('[::1]'), true)
  assert.equal(loopbackAddress('::ffff:127.0.0.1'), true)
  // Dual-stack peers may arrive with the mapped IPv4 written in hex.
  assert.equal(loopbackAddress('::ffff:7f00:1'), true)
  assert.equal(loopbackAddress('::ffff:7f00:2'), true)
  assert.equal(loopbackAddress('::ffff:0a00:1'), false)
  assert.equal(loopbackAddress('10.0.0.5'), false)
  assert.equal(loopbackAddress('0.0.0.0'), false)
  assert.equal(loopbackAddress('evil.example'), false)
  assert.equal(loopbackAddress(undefined), false)
})

test('hostNameOf strips the port and tolerates IPv6 brackets', () => {
  assert.equal(hostNameOf('127.0.0.1:56185'), '127.0.0.1')
  assert.equal(hostNameOf('[::1]:56185'), '[::1]')
  assert.equal(hostNameOf('localhost'), 'localhost')
  assert.equal(hostNameOf('a b'), '')
  assert.equal(hostNameOf(''), '')
})

test('loopback gate checks the socket peer, not only the Host header', () => {
  assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1:56185')), true)
  assert.equal(isLoopbackRequest(request('::ffff:127.0.0.1', 'localhost:56185')), true)
  // Forged Host from another interface must not pass.
  assert.equal(isLoopbackRequest(request('10.0.0.5', '127.0.0.1:56185')), false)
  // DNS rebinding: Host and Origin can agree on an external name.
  assert.equal(isLoopbackRequest(request('127.0.0.1', 'rebind.evil.example:56185')), false)
  // The old whitelist entry had no legitimate use.
  assert.equal(isLoopbackRequest(request('127.0.0.1', '0.0.0.0:56185')), false)
  // Explicit tunnel opt-in keeps the previous behaviour.
  assert.equal(isLoopbackRequest(request('10.0.0.5', 'tunnel.example'), { remoteAllowed: true }), true)
})

test('withoutClientSpan drops only the span field', () => {
  const args = { sessionId: 's', seq: 4, span: { start: 0, end: 99, shadowedSeqs: [] } }
  const stripped = withoutClientSpan(args)
  assert.deepEqual(stripped, { sessionId: 's', seq: 4 })
  assert.equal(args.span.start, 0, 'the input object must not be mutated')
  assert.equal(withoutClientSpan(stripped), stripped, 'no span → same reference')
})

test('fold summary survives malformed tool arguments', () => {
  const events = [
    { seq: 0, type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改一下这个文件' }] } },
    { seq: 1, type: 'tool/call', time: 2, data: { name: 'fs.write', arguments: '{"path": "src/a.ts"' } },
    { seq: 2, type: 'tool/call', time: 3, data: { name: 'bash', arguments: '{"command":"pnpm test"}' } },
    { seq: 3, type: 'tool/result', time: 4, data: {} },
  ]
  const summary = buildFoldSummary(events, { start: 0, end: 3 })
  assert.match(summary, /pnpm test/, 'the valid command still lands in the summary')
  assert.match(summary, /尾输入: "改一下这个文件"/)
  assert.match(summary, /工具结果: 1 次/)
})

test('version index ignores oversized and control-character paths', () => {
  const args = JSON.stringify({
    path: 'x'.repeat(2000),
    files: ['src/ok.ts', 'bad\u0000path', 'y'.repeat(4000)],
  })
  assert.deepEqual(pathsFromToolCallArguments('fs.write', args), ['src/ok.ts'])
})

test('version index truncates marker text to a display-sized bound', () => {
  const state = createVersionIndexState()
  const event = {
    seq: 10,
    type: 'user/message',
    time: 1,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    data: { id: 'retrace-edit-abc', editor: { text: 'z'.repeat(5000) }, source: { kind: 'plugin:retrace' }, content: [] },
  }
  const next = applyVersionIndex(state, event)
  assert.equal(next.versions.length, 1)
  assert.equal(next.versions[0].markerText.length, 512)
  // No-op events must keep the same state reference (projection change feed).
  assert.equal(applyVersionIndex(next, { seq: 11, type: 'tool/result', data: {} }), next)
})

test('capture epoch salvage refuses a truncated short number', () => {
  // `{"epoch":17000` is a half-written marker; trusting it would pin the epoch
  // to 1970 and silently disable predatesCapture forever.
  assert.equal(parseEpoch('{"epoch":17000'), null)
  assert.equal(parseEpoch('{"epoch":1759000000000'), 1_759_000_000_000)
  assert.equal(parseEpoch('{"epoch":1759000000000}'), 1_759_000_000_000)
})
