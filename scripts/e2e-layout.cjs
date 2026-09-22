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
//   RECALL  a REAL two-step recall in a throwaway session this script creates
//           and then archives (v0.1.7 removed session delete): the recalled
//           entry must not abdicate, and the follow-up message must still get
//           its chips (v0.4.40 regression — a mid-hook early return used to
//           crash the seat with React #300)
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
// dsh web writes its token to different logs depending on how it was started
// (start-dsh-web.bat → ~/.dsh/dsh-web.log; the launcher → logs/*.stdout.log)
// and every restart rotates the token, so collect candidates from the freshest
// log first and fall back in the UI if the app does not boot with it.
const LOG_PATHS = [...new Set([WEB_LOG, 'C:/Users/daha/.dsh/dsh-web.log', 'C:/Users/daha/.dsh/logs/dsh-web.stdout.log'])]
  .filter((f) => { try { return fs.statSync(f).size > 0 } catch { return false } })
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
const TOKENS = [...new Set(LOG_PATHS.flatMap((f) => (fs.readFileSync(f, 'utf8').match(/token=([^\s)]+)/g) || []).map((t) => t.slice(6))))]
const WEBKIT_PATH = process.env.DSH_WEBKIT_PATH
  || 'C:/dsh/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'
if (TOKENS.length === 0) { console.error('no dsh web token found in', LOG_PATHS); process.exit(1) }

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

  // Pick a token the RUNNING server actually accepts (every restart rotates
  // it): 401 = stale log entry, anything else = accepted.
  const probeToken = async (t) => {
    try {
      const res = await fetch(`${WEB_URL}/?token=${t}`, { redirect: 'manual' })
      return res.status !== 401
    } catch { return false }
  }
  let token = null
  for (const t of TOKENS) { if (await probeToken(t)) { token = t; break } }
  if (token === null) { console.log('FAIL  no candidate token accepted by the running server'); await b.close(); process.exit(1) }

  await p.goto(`${WEB_URL}/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  let booted = false
  for (let i = 0; i < 30; i++) {
    booted = await p.evaluate(() => document.querySelectorAll('[class*="sessionRow"]').length > 0)
    if (booted) break
    await p.waitForTimeout(1000)
  }
  if (!booted) console.log('WARN  app did not boot with the accepted token; continuing')
  await p.waitForTimeout(1500)

  // --- helpers for the real-recall regression (v0.4.40) ---------------------
  // Session rows expose their exact title through the row menu's aria-label
  // (`会话“<title>”的操作`), so we can find/verify/delete by exact title.
  const listSessionTitles = () => p.evaluate(() => [...document.querySelectorAll('button[aria-label*="的操作"]')].map((b) => {
    const m = (b.getAttribute('aria-label') || '').match(/会话[“"](.+)[”"]的操作/)
    return m ? m[1] : null
  }).filter(Boolean))

  // Title of the currently ACTIVE session row — the row the UI switched to
  // after creating the throwaway session (precise identity for cleanup).
  const activeSessionTitle = () => p.evaluate(() => {
    const row = [...document.querySelectorAll('[class*="sessionRow"]')].find((el) => (el.className || '').toString().includes('selected'))
    const btn = row && row.querySelector('button[aria-label*="的操作"]')
    const m = btn && (btn.getAttribute('aria-label') || '').match(/会话[“"](.+)[”"]的操作/)
    return m ? m[1] : null
  })

  const clickSessionByTitle = (title) => p.evaluate((t) => {
    const btn = [...document.querySelectorAll('button[aria-label*="的操作"]')].find((b) => {
      const m = (b.getAttribute('aria-label') || '').match(/会话[“"](.+)[”"]的操作/)
      return m && m[1] === t
    })
    const row = btn && btn.closest('[class*="sessionRow"]')
    if (!row) return false
    row.click()
    return true
  }, title)

  // v0.1.7 removed the session-delete menu item (pin/rename/fork/archive only),
  // so cleanup archives instead: archived rows leave the default list view,
  // which is what the "left behind" checks below assert against.
  const archiveSessionByTitle = async (title) => {
    const opened = await p.evaluate((t) => {
      const btn = [...document.querySelectorAll('button[aria-label*="的操作"]')].find((b) => {
        const m = (b.getAttribute('aria-label') || '').match(/会话[“"](.+)[”"]的操作/)
        return m && m[1] === t
      })
      if (!btn) return 'NO_ROW'
      btn.click()
      return 'MENU_OPEN'
    }, title)
    if (opened !== 'MENU_OPEN') return opened
    await p.waitForTimeout(600)
    const item = await p.evaluate(() => {
      const it = [...document.querySelectorAll('[role="menuitem"], button')].filter((n) => n.offsetParent !== null).find((n) => /^归档会话$/.test((n.textContent || '').trim()))
      if (!it) return 'NO_ITEM'
      it.click()
      return 'ARCHIVE_ITEM'
    })
    if (item !== 'ARCHIVE_ITEM') { await p.keyboard.press('Escape'); return item }
    await p.waitForTimeout(900)
    // An idle session archives directly; only running work raises the
    // 停止并归档 confirmation dialog, so click through it when present.
    await p.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((n) => n.offsetParent !== null)
      if (!d) return
      const btn = [...d.querySelectorAll('button')].find((b) => /^停止并归档$/.test((b.textContent || '').trim()))
      if (btn) btn.click()
    })
    for (let i = 0; i < 60; i++) {
      await p.waitForTimeout(1000)
      const still = await p.evaluate((t) => [...document.querySelectorAll('button[aria-label*="的操作"]')].some((b) => {
        const m = (b.getAttribute('aria-label') || '').match(/会话[“"](.+)[”"]的操作/)
        return m && m[1] === t
      }), title)
      if (!still) return true
    }
    return 'TIMEOUT'
  }

  // Wait until the conversation stops growing (reply finished) — the host
  // refuses recall while the agent is still responding.
  const waitReplySettled = async (tag, maxMs = 240000) => {
    const t0 = Date.now()
    let prev = await p.evaluate(() => document.body.innerText.length)
    let stable = 0
    while (Date.now() - t0 < maxMs) {
      await p.waitForTimeout(5000)
      const cur = await p.evaluate(() => document.body.innerText.length)
      stable = cur === prev ? stable + 1 : 0
      prev = cur
      if (stable >= 2) return true
    }
    console.log(`  [${tag}] reply did not settle within ${maxMs}ms; continuing`)
    return false
  }

  const typeAndSend = async (text) => p.evaluate((text) => {
    const box = document.querySelector('[contenteditable="true"]')
    if (!box) return 'NO_BOX'
    box.focus()
    document.execCommand('selectAll')
    document.execCommand('delete')
    document.execCommand('insertText', false, text)
    return 'TYPED'
  }, text).then(async (typed) => {
    await p.waitForTimeout(400)
    const sent = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('发送消息'))
      if (!btn) return 'NO_BTN'
      if (btn.disabled) return 'DISABLED'
      btn.click()
      return 'SENT'
    })
    return `${typed}/${sent}`
  })

  let found = false
  let baseSessionTitle = null
  // the sidebar may render late: wait for its rows before picking a session
  for (let i = 0; i < 20; i++) {
    const n = await p.evaluate(() => document.querySelectorAll('[class*="sessionRow"]').length)
    if (n > 0) break
    await p.waitForTimeout(1000)
  }
  // render every session row the sidebar paginates away, so the pre-run title
  // snapshot is complete (collapsed rows popping in later must not look "new")
  for (let i = 0; i < 10; i++) {
    const clicked = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /^展开其余\s*\d+\s*个会话/.test((b.textContent || '').trim()) && b.offsetParent !== null)
      if (!btn) return false
      btn.click()
      return true
    })
    if (!clicked) break
    await p.waitForTimeout(300)
  }
  const picked = []
  for (let k = 0; k < 6 && !found; k++) {
    await p.evaluate((k) => {
      const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
        .filter((el) => !/^(新会话|new session)$/i.test((el.textContent || '').trim()))
      if (rows[k]) rows[k].click()
    }, k)
    await p.waitForTimeout(5500)
    const st = await p.evaluate(() => ({
      rows: document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row').length,
      users: document.querySelectorAll('[data-chat-flow-kind="user"]').length,
      slotErrors: document.querySelectorAll('[data-slot-error]').length,
      styles: !!document.querySelector('style[data-plugin-css="dsh-retrace-css"]'),
    }))
    picked.push({ k, ...st })
    found = st.rows > 0
    if (found) {
      baseSessionTitle = await p.evaluate((k) => {
        const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
          .filter((el) => !/^(新会话|new session)$/i.test((el.textContent || '').trim()))
        const btn = rows[k] && rows[k].querySelector('button[aria-label*="的操作"]')
        const m = btn && (btn.getAttribute('aria-label') || '').match(/会话[“"](.+)[”"]的操作/)
        return m ? m[1] : null
      }, k)
    }
  }
  if (!found) {
    const titles = await p.evaluate(() => [...document.querySelectorAll('[class*="sessionRow"]')].map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)).slice(0, 8))
    console.log('FAIL  no session with chips found (need a session with user messages)')
    console.log('      sidebar rows:', JSON.stringify(titles))
    console.log('      per-click:', JSON.stringify(picked))
    await b.close()
    process.exit(1)
  }

  const measure = () => p.evaluate(() => {
    const ed = document.querySelector('.dsh-rt-editor')
    const allRows = [...document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row')]
    const row = ed ? (ed.previousElementSibling && ed.previousElementSibling.classList.contains('dsh-rt-user-row') ? ed.previousElementSibling : allRows[allRows.length - 1]) : allRows[allRows.length - 1]
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
      editorRight: er && prev ? +Math.abs(er.right - prev.getBoundingClientRect().right).toFixed(1) : null,
      chipsInline: cr && mr ? (cr.left > mr.left - 1 && Math.abs(cr.top - mr.top) < 10) : null,
      chipsRightAtColEdge: cr && prev ? Math.abs(cr.right - prev.getBoundingClientRect().right) < 4 : null
    }
  })

  // BASE — chips parked inline on the clock·copy row
  const base = await measure()
  check('base: chips inline with clock·copy row', base.chipsInline === true, JSON.stringify(base))
  check('base: chips right edge on column edge', base.chipsRightAtColEdge === true)
  check('base: official row shifted left', base.anchorTransform.startsWith('translateX(-'))

  // RECALL (v0.4.40 regression) — a REAL recall must not abdicate the seat.
  // Runs in a throwaway session this script creates and deletes itself: send a
  // message, recall it with the real two-step flow, then send another message —
  // which must still get its chips. Before 0.4.40 the recalled entry dropped a
  // hook mid-sequence (React #300) and the slot registration abdicated for the
  // rest of the page, so every later message lost its edit/recall chips.
  const sessionTitlesBefore = await listSessionTitles()
  let recallTitle = null
  try {
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '新建会话' && (b.className || '').includes('newSession'))
      if (btn) btn.click()
    })
    await p.waitForTimeout(3000)
    console.log('  [recall] send1:', await typeAndSend(`撤回回归测试 ${Date.now()}：只需回复「收到」，不要调用任何工具。`))
    await waitReplySettled('recall-msg1')
    const seeded = await p.evaluate(() => ({
      seats: document.querySelectorAll('[data-chat-flow-kind="user-actions"] .dsh-rt-user-row').length,
      slotErrors: document.querySelectorAll('[data-slot-error]').length,
    }))
    check('recall: throwaway message has chips', seeded.seats === 1 && seeded.slotErrors === 0, JSON.stringify(seeded))
    recallTitle = await activeSessionTitle()
    console.log('  [recall] throwaway session title:', JSON.stringify(recallTitle))

    await p.evaluate(() => {
      const seats = [...document.querySelectorAll('[data-chat-flow-kind="user-actions"]')]
      const chip = seats.length ? seats[seats.length - 1].querySelector('.dsh-rt-ghost.dsh-rt-ghost-danger') : null
      if (chip) { chip.scrollIntoView({ block: 'center' }); chip.click() }
    })
    await p.waitForTimeout(500)
    check('recall: first click arms the two-step confirm', await p.evaluate(() => !!document.querySelector('.dsh-rt-ghost-armed')))
    await p.evaluate(() => { const a = document.querySelector('.dsh-rt-ghost-armed'); if (a) a.click() })
    await p.waitForTimeout(3500)
    await waitReplySettled('recall-confirm', 45000)
    const recalled = await p.evaluate(() => ({
      markers: document.querySelectorAll('.dsh-rt-marker').length,
      slotErrors: document.querySelectorAll('[data-slot-error]').length,
    }))
    check('recall: real recall executed (marker written)', recalled.markers > 0, JSON.stringify(recalled))
    check('recall: no dead cells after the recall (v0.4.40)', recalled.slotErrors === 0, JSON.stringify(recalled))

    console.log('  [recall] send2:', await typeAndSend('撤回回归测试乙：只需回复「好」，不要调用任何工具。'))
    await waitReplySettled('recall-msg2')
    const afterRecall = await p.evaluate(() => {
      const seats = [...document.querySelectorAll('[data-chat-flow-kind="user-actions"]')]
      const last = seats[seats.length - 1]
      // Match each user message to its action seat by message id: the seat key
      // is `<len>:retrace-actions<id>` and the user row key `<len>:input-message<id>`.
      const userIds = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
        .map((u) => (u.getAttribute('data-chat-anchor-key') || '').replace(/^\d+:input-message/, ''))
      const seatIds = seats.map((s) => (s.getAttribute('data-chat-anchor-key') || '').replace(/^\d+:retrace-actions/, ''))
      // Census of every flow row: which message actually survived the recall —
      // the text tells msg1 ("测试") apart from msg2 ("测试乙"), and a steering
      // or unknown row would explain a missing user row the ids alone cannot.
      const census = [...document.querySelectorAll('[data-chat-flow-kind]')].map((el) => ({
        kind: el.getAttribute('data-chat-flow-kind'),
        id: (el.getAttribute('data-chat-anchor-key') || '').replace(/^\d+:[a-z-]+/, ''),
        text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 36),
      }))
      return {
        seats: seats.length,
        seatIds,
        userIds,
        missingSeatFor: userIds.filter((id) => id && !seatIds.includes(id)),
        census,
        lastHasActions: !!(last && last.querySelector('.dsh-rt-user-actions')),
        lastGhosts: last ? last.querySelectorAll('.dsh-rt-ghost').length : 0,
        lastRowPresent: !!(last && last.querySelector('.dsh-rt-user-row')),
        slotErrors: document.querySelectorAll('[data-slot-error]').length,
      }
    })
    check('recall: NEW message after recall STILL has chips (core v0.4.40)', afterRecall.lastHasActions === true && afterRecall.lastGhosts === 2, JSON.stringify(afterRecall))
    check('recall: no dead cells after the follow-up message', afterRecall.slotErrors === 0, JSON.stringify(afterRecall))
  } catch (e) {
    check('recall: section completed without exceptions', false, String(e).slice(0, 200))
  }

  // back to the base session for the layout checks, then clean up throwaways.
  // The session title is rewritten by the async title-LLM mid-run (raw
  // timestamped text → summary), so resolve the throwaway FRESH at cleanup
  // time: exact recallTitle if still listed, else the 撤回回归测试 prefix not
  // present in the pre-run snapshot (prior leftovers are excluded by that).
  if (baseSessionTitle !== null) { await clickSessionByTitle(baseSessionTitle); await p.waitForTimeout(4500) }
  const isThrowaway = (t) => /^撤回回归测试/.test(t)
  const currentTitles = await listSessionTitles()
  const target = (recallTitle !== null && currentTitles.includes(recallTitle) && !sessionTitlesBefore.includes(recallTitle)
    ? recallTitle : null) ?? currentTitles.find((t) => isThrowaway(t) && !sessionTitlesBefore.includes(t)) ?? null
  if (target !== null) {
    const r = await archiveSessionByTitle(target)
    check(`recall: throwaway session archived (${target})`, r === true, r === true ? undefined : String(r))
    const leftovers = (await listSessionTitles()).filter((t) => isThrowaway(t) && !sessionTitlesBefore.includes(t))
    check('recall: no throwaway session left behind', leftovers.length === 0, leftovers.length === 0 ? 'no leftovers' : leftovers.join(' | '))
  } else {
    check('recall: throwaway session cleaned up', false, `could not identify the created session (recallTitle=${JSON.stringify(recallTitle)}, throwawayTitles=${JSON.stringify(currentTitles.filter(isThrowaway))})`)
  }

  // EDIT — chips stay parked (0.4.39); the editor card is a flow sibling that
  // must sit below the clock·copy row and stay clear of it.
  await p.evaluate(() => {
    const ghosts = [...document.querySelectorAll('.dsh-rt-ghost:not(.dsh-rt-ghost-danger)')]
    ghosts[ghosts.length - 1].scrollIntoView({ block: 'center' })
    ghosts[ghosts.length - 1].click()
  })
  await p.waitForTimeout(900)
  const ed = await measure()
  check('edit: editor opens', ed.editorOpen === true)
  check('edit: chips stay mounted while editing (0.4.39)', ed.chipsInline === true, JSON.stringify(ed))
  check('edit: editor below clock·copy row', ed.gapBelowMeta !== null && ed.gapBelowMeta >= 0, `gap ${ed.gapBelowMeta}px`)
  check('edit: editor right edge flush with meta row', ed.editorRight !== null && ed.editorRight < 2, `Δ${ed.editorRight}px`)
  await p.screenshot({ path: 'C:/dsh/e2e-shots/e2e-layout-editor.png' })

  // CANCEL — chips re-park inline
  await p.evaluate(() => { const c = document.querySelector('.dsh-rt-editor-cancel'); if (c) c.click() })
  await p.waitForTimeout(900)
  const back = await measure()
  check('cancel: editor closes, chips still inline', back.editorOpen === false && back.chipsInline === true)
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

  // Environmental noise (transient resource 502s / another plugin's gateway
  // poll) must not mask real page or plugin errors.
  const NOISE = [
    /^CONSOLE: Failed to load resource/,
    /^CONSOLE: \[ui-cordis\] reading the Cordis inventory failed/,
  ]
  const hardErrors = errors.filter((e) => !NOISE.some((re) => re.test(e)))
  check('page: zero console/page errors', hardErrors.length === 0,
    hardErrors.slice(0, 3).join(' | ') || `${errors.length} benign resource-load message(s) filtered`)

  await b.close()
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed.length}/${results.length} CHECKS FAILED`)
  process.exit(failed.length === 0 ? 0 : 1)
})().catch((e) => { console.error(e.stack); process.exit(1) })
