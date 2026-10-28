/**
 * 回归测试：已弃用同步事件读接口的调用点只减不增。
 *
 * 上游 `deepseek-harness` 的架构决策记录把 `Session.eventAt()`、
 * `Session.snapshotEvents()`、`Session.ownEvents()` 三者标为 deprecated，
 * 原文是「Existing logic may remain unmigrated for now, but **new calls are
 * prohibited**. New aliases or wrappers that expose the same synchronous
 * historical access are prohibited as well.」
 *
 * 本仓库的整条读路径都建在这三个 reader 上（见 AGENTS.md 的「读契约」一节），
 * 而现在上游**还没有**任何异步替代接口——`@deepseek-ai/dsh-session` 的导出面里
 * 没有 readEvents / eventsAsync，全包唯一的 `async` 是 `SessionStore.flush`。
 * 所以迁移只能等上游落地，当下可做的是把「不许再加新的调用点」这条规则
 * 变成会失败的测试，而不是靠人记。
 *
 * 每个文件的调用数是**上限**：数字只能往下调，不能往上加。修掉一个调用点就
 * 把对应数字减小；新增调用会让测试失败，这正是要的效果。用计数而不是行号，
 * 是因为行号会随上方代码改动漂移，计数不会。
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')

/**
 * 允许存在的调用点上限，按文件。键是从仓库根算起的 posix 相对路径。
 *
 * 数字是 0.4.80 的实测值；`lib/host-core.js` 里 `sessionEvents()` 的**定义**
 * 不计入（它是唯一出口，不是一处调用）。
 */
const ALLOWED = {
  'lib/host-core.js': 10,
  'lib/interrupt-guard.js': 1,
  'lib/prewrite-guard.js': 3,
  'lib/rollback.js': 1,
  'lib/versioning.js': 1,
  'lib/adapter/dsh-writer.js': 4,
}

/** 唯一的同步读出口。 */
const WRAPPER_CALL = /\bsessionEvents\s*\(/g
const WRAPPER_DEF = /export function sessionEvents\s*\(/

/** 递归列出 lib/ 下的 `.js` 源文件；跳过客户端构建产物。 */
function libSources(dir = LIB, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) libSources(full, out)
    else if (entry.name.endsWith('.js') && entry.name !== 'client.bundle.js') out.push(full)
  }
  return out
}

/**
 * 去掉注释后再匹配，否则文档里提到 `sessionEvents()` 也会被算成调用点。
 * 只处理行注释和整行块注释——本仓库没有行尾块注释。
 */
function stripComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, '')
}

/** 每行去掉注释后的源码，保留行号（下标 + 1）。 */
function codeLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).map(stripComments)
}

function keyOf(file) {
  return relative(ROOT, file).split(sep).join('/')
}

test('没有新增的已弃用同步事件读调用点', () => {
  const actual = {}
  for (const file of libSources()) {
    let count = 0
    for (const line of codeLines(file)) {
      if (WRAPPER_DEF.test(line)) continue
      count += (line.match(WRAPPER_CALL) ?? []).length
    }
    if (count > 0) actual[keyOf(file)] = count
  }

  assert.deepEqual(actual, ALLOWED, [
    '已弃用的同步事件读接口调用点发生变化。',
    '上游明令 new calls are prohibited，所以只允许减少：',
    '如果这次是删掉调用点，把 test/deprecated-event-readers.test.mjs 的 ALLOWED 数字调小；',
    '如果是新增，改用已维护的投影状态（session.surface）或走 lib/adapter/normalize.js 的既有出口。',
  ].join('\n'))
})

test('lib/host-core.js 的 sessionEvents 是唯一出口', () => {
  // 上游把「新别名/包装器」也列为禁止，所以除 host-core 那一个定义外，
  // 任何文件都不该出现 `export function sessionEvents`。
  const offenders = []
  for (const file of libSources()) {
    if (keyOf(file) === 'lib/host-core.js') continue
    for (const [index, line] of codeLines(file).entries()) {
      if (WRAPPER_DEF.test(line)) offenders.push(`${keyOf(file)}:${index + 1}`)
    }
  }
  assert.deepEqual(offenders, [], `发现重复的同步读出口：${offenders.join(', ')}`)
})

test('AGENTS.md 记录了这条弃用约束', () => {
  // issue #7 的建议之一：让后来者知道这不是稳定 API，别再往上加调用点。
  const guide = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
  assert.match(guide, /已弃用[\s\S]{0,200}同步/, 'AGENTS.md 需要写明依赖已弃用的同步 reader')
})
