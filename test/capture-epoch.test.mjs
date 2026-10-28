/**
 * Regression tests for the capture epoch marker.
 *
 * `capture-epoch.json` is the one piece of retrace state that must never move
 * forward: every snapshot captured before it is permanently refused on restore
 * (`predatesCapture` in `lib/versioning.js`). The old implementation wrote it
 * with a bare `writeFile`, so a truncated file made the next load fall through
 * to `Date.now()` — one partial write silently invalidated the user's whole
 * history.
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CAPTURE_EPOCH_FILE, loadCaptureEpoch, parseEpoch, writeFileAtomic } from '../lib/capture-epoch.js'

/** Fresh store root plus a cleanup hook. */
async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'retrace-epoch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const EPOCH_FILE = (root) => join(root, CAPTURE_EPOCH_FILE)

test('首次运行建立 epoch 并落盘', async (t) => {
  const root = await makeRoot(t)
  const epoch = await loadCaptureEpoch(root, { now: () => 1000 })
  assert.equal(epoch, 1000)
  assert.deepEqual(JSON.parse(await readFile(EPOCH_FILE(root), 'utf8')), { epoch: 1000 })
})

test('再次加载不会把 epoch 前移', async (t) => {
  const root = await makeRoot(t)
  await loadCaptureEpoch(root, { now: () => 1000 })
  const again = await loadCaptureEpoch(root, { now: () => 9_999_999 })
  assert.equal(again, 1000, 'epoch 一旦建立就必须钉住；前移会作废全部历史快照')
})

test('截断的 marker 会被抢救，epoch 不前移', async (t) => {
  const root = await makeRoot(t)
  // A partial write: the number is present, the JSON is not closed.
  await writeFile(EPOCH_FILE(root), '{"epoch":1759000000000')
  const epoch = await loadCaptureEpoch(root, { now: () => 9_999_999 })
  assert.equal(epoch, 1_759_000_000_000, '旧实现会在这里返回 now()，把历史全部作废')
  // The marker is repaired so later reads take the fast path again.
  assert.deepEqual(JSON.parse(await readFile(EPOCH_FILE(root), 'utf8')), {
    epoch: 1_759_000_000_000,
  })
})

test('完全无法解析的 marker 用 mtime 重建（不跳到 now），并留下现场副本', async (t) => {
  const root = await makeRoot(t)
  const file = EPOCH_FILE(root)
  await writeFile(file, 'not json at all')
  // The only recoverable signal is when the marker was last written; jumping to
  // now() would invalidate every snapshot captured before this boot.
  const knownMtime = new Date(1_700_000_000_000)
  await utimes(file, knownMtime, knownMtime)
  const epoch = await loadCaptureEpoch(root, { now: () => 4242 })
  assert.equal(epoch, 1_700_000_000_000)
  const entries = await readdir(root)
  assert.ok(
    entries.some((name) => name.startsWith(`${CAPTURE_EPOCH_FILE}.damaged-`)),
    `应保留损坏现场，实际目录内容：${entries.join(', ')}`,
  )
})

test('加载成功后不留下临时文件', async (t) => {
  const root = await makeRoot(t)
  await loadCaptureEpoch(root, { now: () => 1000 })
  await loadCaptureEpoch(root, { now: () => 1000 })
  const leftovers = (await readdir(root)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('parseEpoch 拒绝非数字与负数噪音', () => {
  assert.equal(parseEpoch('{"epoch":123}'), 123)
  assert.equal(parseEpoch('{"epoch":"123"}'), null, '字符串数字不算有效 epoch')
  assert.equal(parseEpoch('{"epoch":null}'), null)
  assert.equal(parseEpoch(''), null)
  assert.equal(parseEpoch(null), null)
})

test('writeFileAtomic 覆盖写入且不残留临时文件', async (t) => {
  const root = await makeRoot(t)
  const file = join(root, 'x.json')
  await writeFileAtomic(file, 'first')
  await writeFileAtomic(file, 'second')
  assert.equal(await readFile(file, 'utf8'), 'second')
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), [])
})
