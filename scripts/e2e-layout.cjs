#!/usr/bin/env node
// Layout E2E for dsh-retrace — the guardrail for visual/layout changes.
//
// What it does: splices the LOCAL lib/client.bundle.js into the module combo
// the running dsh web serves (route interception, nothing on disk changes),
// then drives the real UI and asserts the chips row contract:
//   BASE    chips inline in the clock·copy row, right edge on the column edge
//   EDIT    editor opens: row transform cleared, sits BELOW the clock·copy
//           row (the 0.4.37 overlap regression), anchor released
//   CANCEL  chips re-park inline
//   ARMED   first recall click arms the chip (READ-ONLY: never a second click)
//   HEAL    clobbering the row's transform self-heals via observer/interval
// plus node --check + mirror-symbol parity on both lib files.
//
// Prerequisites: dsh web running (default http://127.0.0.1:3080) with any
// session that has user messages. Token is read from the server log.
// Env overrides: DSH_WEB_URL, DSH_WEB_LOG, DSH_WEBKIT_PATH.
//
// Usage: node scripts/e2e-layout.cjs   (exit 0 = all green)

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const WEB_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const WEB_LOG = process.env.DSH_WEB_LOG || 'C:/Users/daha/.dsh/logs/dsh-web.stdout.log'
const WEBKIT_PATH = process.env.DSH_WEBKIT_PATH
  || 'C:/dsh/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- phase 0: static checks -------------------------------------------------
const LIB = ['lib/client.js', 'lib/client.bundle.js'].map((f) => path.join(ROOT, f))
for (const file of LIB) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
}
check('syntax: node --check both lib files', true)

const SHARED_SYMBOLS = ['chatActionAnchor', 'chatAnchorTransform', 'alignChatActionRows', 'isLayoutRelevant', 'installChatActionAligner']
const READER_SYMBOLS = ['readerChatNodes', 'readerChatInfo', 'mountReaderChipRow', 'scanReaderClusters', 'READER_MOUNT_FLAG', 'data-reader-anchor']
for (const file of LIB) {
  const text = fs.readFileSync(file, 'utf8')
  const missing = SHARED_SYMBOLS.filter((s) => !text.includes(s))
  const ghost = READER_SYMBOLS.filter((s) => text.includes(s))
  check(`mirror: ${path.basename(file)} symbol parity`,
    missing.length === 0 && ghost.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : ghost.length ? `reader leftovers: ${ghost.join(', ')}` : 'shared symbols present, reader injector absent')
}

// --- phase 1: live UI --------------------------------------------------------
const { webkit } = require(WEBKIT_PATH)
const LOCAL_BUNDLE = fs.readFileSync(path.join(ROOT, 'lib/client.bundle.js'), 'utf8')
const TOKEN = fs.readFileSync(WEB_LOG, 'utf8').match(/token=([^\s)]+)/g).slice(-1)[0].slice(6)

;(async () => {
  const b = await webkit.launch({ headless: true })
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
  p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })

  await p.route((u) => u.pathname.startsWith('/plugins/') && u.search.includes('??'), async (route) => {
    const resp = await route.fetch()
    let body = await resp.text()
    if (body.includes('id: "dsh-retrace"')) {
      const start = body.indexOf('window.__ModuleLoader__.load({id: "dsh-retrace"')
      const next = body.indexOf('window.__ModuleLoader__.load(', start + 10)
      const end = next < 0 ? body.length : next
      body = body.slice(0, start) + LOCAL_BUNDLE + '\n' + body.slice(end)
    }
    await route.fulfill({ response: resp, body })
  })

  await p.goto(`${WEB_URL}/?token=${TOKEN}`, { waitUntil: 'networkidle', timeout: 30000 })
  await p.waitForTimeout(9000)

  let found = false
  for (let k = 0; k < 6 && !found; k++) {
    await p.evaluate((k) => {
      const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
        .filter((el) => !/^(新会话|new session)$/i.test((el.textContent || '').trim()))
      if (rows[k]) rows[k].click()
    }, k)
    await p.waitForTimeout(4500)
    found = await p.evaluate(() => document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row').length > 0)
  }
  if (!found) { console.log('FAIL  no session with chips found (need a session with user messages)'); await b.close(); process.exit(1) }

  const measure = () => p.evaluate(() => {
    const ed = document.querySelector('.dsh-rt-editor')
    const allRows = [...document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row')]
    const row = ed ? ed.closest('.dsh-rt-user-row') : allRows[allRows.length - 1]
    const chips = row ? row.querySelector('.dsh-rt-user-actions') : null
    const flow = row ? row.closest('[data-chat-flow-kind]') : null
    let prev = flow ? flow.previousElementSibling : null
    while (prev && prev.hasAttribute('hidden')) prev = prev.previousElementSibling
    const copy = prev ? prev.querySelector('button[aria-label="复制"], button[aria-label="Copy"]') : null
    const metaRow = copy ? copy.parentElement : null
    const er = ed ? ed.getBoundingClientRect() : null
    const mr = metaRow ? metaRow.getBoundingClientRect() : null
    const cr = chips ? chips.getBoundingClientRect() : null
    return {
      editorOpen: !!ed,
      rowTransform: row ? (row.style.transform || 'NONE') : 'NOROW',
      anchorTransform: metaRow ? (metaRow.style.transform || 'NONE') : 'NOMETA',
      gapBelowMeta: er && mr ? +(er.top - mr.bottom).toFixed(1) : null,
      editorRight: er && mr ? +Math.abs(er.right - mr.right).toFixed(1) : null,
      chipsInline: cr && mr ? (cr.left > mr.left - 1 && Math.abs(cr.top - mr.top) < 10) : null,
      chipsRightAtColEdge: cr && prev ? Math.abs(cr.right - prev.getBoundingClientRect().right) < 4 : null
    }
  })

  // BASE — chips parked inline on the clock·copy row
  const base = await measure()
  check('base: chips inline with clock·copy row', base.chipsInline === true, JSON.stringify(base))
  check('base: chips right edge on column edge', base.chipsRightAtColEdge === true)
  check('base: official row shifted left', base.anchorTransform.startsWith('translateX(-'))

  // EDIT — editor must clear the parked translate and sit below the meta row
  await p.evaluate(() => {
    const ghosts = [...document.querySelectorAll('.dsh-rt-ghost:not(.dsh-rt-ghost-danger)')]
    ghosts[ghosts.length - 1].scrollIntoView({ block: 'center' })
    ghosts[ghosts.length - 1].click()
  })
  await p.waitForTimeout(900)
  const ed = await measure()
  check('edit: editor opens', ed.editorOpen === true)
  check('edit: parked row translate cleared (0.4.37)', ed.rowTransform === 'NONE', ed.rowTransform)
  check('edit: editor below clock·copy row', ed.gapBelowMeta !== null && ed.gapBelowMeta >= 0, `gap ${ed.gapBelowMeta}px`)
  check('edit: editor right edge flush with meta row', ed.editorRight !== null && ed.editorRight < 2, `Δ${ed.editorRight}px`)
  await p.screenshot({ path: 'C:/dsh/e2e-shots/e2e-layout-editor.png' })

  // CANCEL — chips re-park inline
  await p.evaluate(() => { const c = document.querySelector('.dsh-rt-editor-cancel'); if (c) c.click() })
  await p.waitForTimeout(900)
  const back = await measure()
  check('cancel: chips re-park inline', back.editorOpen === false && back.chipsInline === true)
  check('cancel: chips right edge on column edge', back.chipsRightAtColEdge === true)

  // HEAL — clobber the transform; the filtered observer must restore it
  // fast (under half a second — the 1.5s interval backstop has NOT fired yet,
  // so this pass proves relevant mutations still schedule rescans).
  await p.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row')]
    rows[rows.length - 1].style.transform = ''
  })
  await p.waitForTimeout(400)
  const healed = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row')]
    const row = rows[rows.length - 1]
    return row ? (row.style.transform || 'NONE') : 'NOROW'
  })
  check('heal: clobbered transform self-restores', healed.startsWith('translate('), healed)

  // ARMED — read-only: ONE click, assert the armed chip, never confirm
  await p.evaluate(() => {
    const chips = [...document.querySelectorAll('.dsh-rt-ghost.dsh-rt-ghost-danger')]
    chips[chips.length - 1].click()
  })
  await p.waitForTimeout(350)
  const armed = await p.evaluate(() => {
    const a = document.querySelector('.dsh-rt-ghost-armed')
    if (!a) return null
    const r = a.getBoundingClientRect()
    return { text: a.textContent.trim(), right: +r.right.toFixed(1), visible: r.width > 0 }
  })
  check('armed: two-step confirm arms (no second click)', armed !== null && armed.visible === true, JSON.stringify(armed))
  await p.waitForTimeout(3200)
  const disarmed = await p.evaluate(() => document.querySelectorAll('.dsh-rt-ghost-armed').length)
  check('armed: auto-disarm after 3s', disarmed === 0)

  check('page: zero console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

  await b.close()
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length}/${results.length} CHECKS FAILED`)
  process.exit(failed.length === 0 ? 0 : 1)
})().catch((e) => { console.error(e.stack); process.exit(1) })
