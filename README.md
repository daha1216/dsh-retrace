# 🧭 dsh-retrace

> A session time machine for DeepSeek Harness — a personal compatibility-fix fork of
> [yamingmou/dsh-retrace](https://github.com/yamingmou/dsh-retrace). Current version: **0.4.79**.

Recall a whole turn, edit-and-resend a past prompt, or regenerate a reply — while the
conversation state and the workspace files it touched are versioned together. Every rollback
is a legal append-only session event, so the log stays clean and `/compact` keeps working.

**简体中文** · [中文详细说明](./README.zh.md)

---

## 📦 Install

```sh
# Desktop
dsh plugin --profile desktop add github:daha1216/dsh-retrace

# Web deployment
dsh plugin --profile web add github:daha1216/dsh-retrace
```

Restart DSH (and refresh the page) after installing or updating — a running app does not
hot-load bundles. If `dsh` is not on your PATH, prefix the command with
`npx --yes -p @deepseek-ai/dsh`.

> This fork is not published to npm under its own name; `add dsh-retrace` installs the
> upstream package and does **not** include the fixes below. Install from GitHub, or from a
> local checkout with `dsh plugin --profile desktop add /path/to/dsh-retrace`.

---

## ✨ Features

- **↩ Recall** — remove an entire turn (prompt + reply + tool rows) from both model context
  and the chat view; the original prompt is echoed back into the composer.
- **✎ Edit & resend** — edit a past user message in place and re-answer, with a collapsible
  "original prompt" reference.
- **↻ Regenerate** — keep the prompt, hide the previous reply, and let the agent answer again.
- **🕘 Version timeline** — every rollback becomes a version (kind / time / message count /
  file changes), pushed live via `session/projection`.
- **↩️ Artifact rollback** — conversation only, files only, or both, with a dry-run preview;
  git when the boundary recorded the exact committed bytes, content-addressed snapshots
  otherwise; a rollback is itself a new version.
- **🧭 Fork map & lineage** — visualize branch points and parent-session lineage.
- **🗂️ Session archaeology CLI** — read-only index / query / extract / file-history over
  persisted session logs.

---

## 🔄 Recent changes (0.4.50 → 0.4.79)

- **0.4.79** — adversarial-audit hardening pass. The request gate now checks the socket peer as
  well as the `Host` header (a forged header no longer opens the loopback-only route), caller-supplied
  spans are stripped, internal 5xx messages are redacted, session ids / artifact shas / model-derived
  paths are validated and bounded, and snapshot reads are size-capped. Undo and restore re-check the
  workspace realpath and the file version, and git rollback falls back to content snapshots for files
  created in the window or captured from a dirty tree. Fold markers gained their missing *Expand*
  control, `git/init` is written to the operations log, and a corrupted `capture-epoch.json` recovers
  from the file mtime instead of advancing the epoch (which invalidated every existing snapshot).

- **0.4.78** — two contributor fixes landed, plus the paths the plugin derives from `DSH_HOME`:
  `regenerate` now reads windowed logs through `eventAt` (a bare index picked the neighbouring row,
  resending someone else's text), `capture-epoch.json` is written atomically and a truncated marker is
  salvaged instead of advancing the epoch (which silently invalidated every existing snapshot), the
  interrupt guard keeps one entry per turn (crash → recover → crash used to report nothing) and now
  reads the host's `snapshotEvents()`, and the session-file lookup honours `DSH_HOME`.
- **0.4.77** — the legacy badge prefix is now removed when a session is loaded, not only
  during the startup sweep, so sessions opened later are covered too.
- **0.4.76** — sessions opened after startup also get their legacy badge prefix removed:
  every plugin request reports which session it touched, and the cleanup runs once per session.
- **0.4.75** — the title cleanup matches badges case-insensitively (`dd833FF000`, not just
  lowercase hex), so existing prefixed titles are actually stripped.
- **0.4.74** — the short code is display-only again: no operation rewrites a session title, and
titles that older builds prefixed with `[badge]` are cleaned back to the text the user wrote.
- **0.4.73** — the undo toast tells the truth about its own scope: when a rollback also
  rewound the conversation it says the conversation part cannot be undone and labels the
  button as undoing file changes only.
- **0.4.72** — a rollback that overwrites files now leaves an undo behind: the bytes are
  captured before any write, the timeline shows a toast with an Undo button, and the ticket
  works once within 30 minutes. Recall chips also say what recall really does (hide this
  message and everything after it), and timeline rows lead with relative time while the
  version id and exact timestamp live in the tooltip.
- **0.4.71** — every reference keeps its own capture time, so reusing bytes that were
  stored long ago (deduplication) no longer makes a fresh boundary look unprovable and
  get refused at restore time. Rows written before 0.4.71 have no such field and fall
  back to the old boundary-time column, which is why pre-epoch references stay racy.
- **0.4.70** — the store now repairs itself at startup: rows that lost both their
  references and their object (ledger residue from the pre-0.4.50 GC, 608 of them on the
  machine this was found on) are dropped through the storage domain, so the in-memory
  tables and the JSON file stay in step. Legacy pre-0.4.58 refs are never rewritten; a
  `legacy-frozen.json` sidecar records once why they stay unattributable. No manual CLI
  run and no maintenance window required.
- **0.4.69** — boundary capture only records boundaries created after the plugin
  started. The projection replays a session's whole history when it loads, and each
  replayed boundary used to trigger a snapshot of the *current* workspace, storing
  today's bytes as that boundary's content. Replayed history is now skipped, a
  capture that lands late is marked racy, and every snapshot recorded before the
  first 0.4.69 run is treated as racy at restore time (`capture-epoch.json`) instead
  of being deleted.
- **0.4.68** — `retrace store migrate` freezes the legacy era explicitly. Refs written
  before 0.4.58 carry no session id and their `versiongit` rows do not either, so there
  is no honest way to attribute them; the command records that fact in
  `legacy-frozen.json` and drops only refcount rows whose object is already gone. It
  never rewrites a ref and never deletes a blob. Run it with the host stopped — the
  live process holds the domain file in memory.
- **0.4.67** — boundary-time capture and the sweep are on. Every version boundary now
  snapshots the files that boundary touched (4 MB per file, deduplicated by content) and
  records the git HEAD/dirty pair, so the timeline can show what actually changed. The
  sweep that releases refs and deletes unreferenced objects runs again, with the 10-minute
  grace and the in-flight guard from 0.4.59. Artifact restore stays off — it is the only
  path that writes user files, and it should be exercised against real captured history first.
- **0.4.66** — the dynamic-plugin entry points are gone. `lib/dynamic-client.js` and
  `lib/dynamic-host.js` had been frozen at 0.4.43, which meant anyone using that path got
  single-click recall, no request gate and no rollback ticket. The files and their `exports`
  entries were removed; install the bundle form instead.
- **0.4.65** — the artifact store can be inspected and cleaned offline.
  `retrace store inventory` classifies every object as live, legacy (refs written
  before 0.4.58 that carry no session id), dangling or orphan; `retrace store gc`
  is a dry run unless you pass `--apply --yes`, and it only ever deletes objects
  nothing points at — legacy refs are kept because their owner cannot be
  recovered. The command needs no host and no session-log dependency.
- **0.4.64** — the bundle is generated again. `node scripts/build-client.mjs`
  rebuilds `lib/client.bundle.js` from `lib/client.js` with a deterministic
  transform (react through `require`, `badge.js` inlined, exports mapped), so the
  two files can no longer drift. `node scripts/check-syntax.mjs` checks syntax,
  version consistency and bundle sync in one pass, and the `build` / `check`
  entries in package.json now point at scripts that actually exist.
- **0.4.63** — the rollback dialog behaves like a dialog. It carries
  `role="dialog"`, `aria-modal`, moves focus to Cancel on open and returns it
  on close, and Escape cancels — except while a rollback is running. Recalled
  images are now bound to the draft that started them: if the echoed text was
  already sent, the images are dropped instead of landing in the next message.
- **0.4.62** — the marker hide plan is linear again. Every marker used to
  rescan the whole node map to resolve its shadowed rows, so a 2 000-row session
  with 200 markers cost 444 400 node visits per snapshot; one shared seq index
  brings the same case to 6 600 (34–67× fewer, measured by the isolated client
  suite). Jumping to a version's anchor now reads the current host snapshot
  shape and seeks with `loadThrough` instead of paging 50 rows at a time — the
  old `snapshot.chat.nodes` path made every jump give up silently.
- **0.4.61** — the plugin API is reachable only from this host's own UI. Every
  request must come from a loopback host (a tunnel or LAN address is opt-in via
  `DSH_RETRACE_ALLOW_REMOTE=1`), every mutating request must carry the
  `x-retrace-client` header that only the plugin's page can set without a
  preflight, and `git/init` now needs an explicit confirmation flag and fails
  closed when the session's sandbox policy cannot be resolved. Read-only GETs
  stay reachable without credentials — they expose no file contents beyond what
  the workspace already contains.
- **0.4.60** — rollback is a two-step operation with a server-issued ticket.
  Preview returns a single-use `planId` bound to the session, version, scope and
  current revision; execute refuses to run without it (`plan-required`), refuses
  a second use (`plan-used`) and refuses a preview that a newer boundary made
  stale (`plan-stale`). A context rollback that would have to bring back messages
  the session no longer shows is refused (`restore-unsupported`) instead of
  writing a marker that cannot reproduce the target surface. Every executed
  rollback appends one line to `~/.dsh/dsh-retrace/operations.jsonl` (ids, scope
  and per-file status only — never message text or file contents), and artifact
  restores are serialized per workspace so two sessions cannot write the same
  files at once.
- **0.4.59** — snapshot writes are transactional. References to one object are
  serialized per content address (two files with identical content used to lose
  one of the two references), a reference write that fails drops the object it
  just published instead of leaving an orphan, and a sweep waits for in-flight
  snapshots so it can no longer delete a blob another session published a moment
  ago. A boundary capture that could not be proven to belong to its version (a
  later boundary touched the same path first) is marked racy and refused by
  restore, rather than writing newer content over older state.
- **0.4.58** — session-scoped artifact storage. Snapshot references and git
  facts are now keyed by session (`<sessionId>|<versionId>|<path>`), so two
  sessions that both reach seq 10 no longer write the same key: the audit showed
  one session's rollback could resolve the other session's bytes and its git
  facts could overwrite the other's. Rows written before this release have no
  session id and are treated as unattributable: they are never released by GC
  and never match a session-scoped lookup, because the owner cannot be recovered
  reliably. The sweep now releases only the sweeping session's own truncated
  versions. `GET /api/plugins/retrace/storage` reports what the store holds
  (objects, references, legacy rows, orphans) without deleting anything.
- **0.4.57** — host contract unification. Every reader now goes through one
  normalisation layer (`lib/adapter/normalize.js`) that understands both marker
  generations (legacy `data.message.id`, current top-level `data.id`), derives
  event rows through a `baseSeq`-aware lookup instead of `events[seq]`, and treats
  the host's own surface fold as the only authority. Consequences: recall, fold
  and restore markers written by this build are recognised by the plugin's own
  readers (previously every fold written since the marker format changed was
  invisible to `unfold`, and restore refused its own markers); sessions whose log
  is a window (forked or compacted) no longer read the wrong event row when
  computing a span; `waterLevel` and the round/range boundary helpers share the
  same envelope handling. At startup the plugin probes the running host for
  `Session.prototype.snapshotEvents`; if the contract is not recognised it runs
  read-only (edits answer `capability-disabled`, HTTP 503) and reports that through
  `GET /api/plugins/retrace/capabilities`, instead of guessing compatibility.
- **0.4.56** — safety stop-loss: artifact rollback and automatic GC now ship disabled.
  The audit could not prove boundary-time capture, snapshot write-back or the automatic
  sweep safe against the current host contracts, so they are host-enforced capability
  gates (`lib/capabilities.js`). 0.4.67 opened the two read-only ones —
  `artifactCapture` (boundary-time snapshots + git facts, never writes the workspace) and
  `artifactGc` (sweep that only deletes objects nothing references) — while
  `contextRestore` and `artifactRestore` stay off. Gated operations answer
  `capability-disabled` (HTTP 503), the
  timeline hides the artifact rollback entry, `GET /api/plugins/retrace/capabilities`
  reports the active gates, and an operator can re-enable one with
  `DSH_RETRACE_CAPABILITIES='{"artifactGc":true}'`. Also fixes three client issues:
  mounting the timeline or fork map no longer writes session titles, the rollback confirm
  button stays disabled until the preview loads, a dirty work tree blocks only artifact
  scopes instead of context-only restores, and a partially applied rollback or persistence
  warning keeps the dialog open with the failed files listed.
- **0.4.55** — dark-mode visual fixes. Several tokens were used with the wrong semantics or
  never defined at all, which broke the recall editor, marker pills, reference blocks and the
  settings switches in dark theme: `--dsw-alias-bg-elevated`, `--dsw-alias-fill-l2`,
  `--dsw-alias-state-warning-primary`, `--dsw-alias-state-info-primary`,
  `--dsw-alias-state-success-bg` and `--dsw-font-mono` are undefined in DSH; they now map to
  `--dsw-alias-bg-layer-3`, `--dsw-alias-interactive-bg-hover`,
  `--dsw-alias-state-warn-primary`, `--dsw-alias-state-business-primary`,
  `--dsw-alias-state-success-tertiary` and `--ds-font-family-code`. The orange send button's
  white label sat at 2.26:1 on orange and is now dark `#20160b` (7.86:1), with the error
  confirm button that reuses its styles restoring its own foreground. The settings switches
  now follow the host's token pairing (off: `border-l3` + `switch-thumb`; on:
  `button-primary-fill` + `label-primary-foreground`), lifting knob contrast from about 2:1
  to 18:1 in dark theme. Hard-coded `rgba(0,0,0,…)` shadows moved to
  `--dsw-shadow-lv1` / `--dsw-shadow-lv2`. The orange palette is the plugin's own design
  language and stays as is.
- **0.4.54** — `git init` now passes the session's sandbox policy, fixing `.gitignore` writes
  being denied under `workspace-write`.
- **0.4.53** — fixed `git init` passing a string path where the fs seam expects a resolved
  target (TypeError); hardened the create-if-absent `.gitignore` path.
- **0.4.52** — settings changes merge instead of overwriting and sync across tabs; HTTP errors
  carry real status codes (400/403/404/409/413/503); dead code paths removed.
- **0.4.51** — span failures report distinct codes (`log-unavailable` vs `target-shadowed`);
  flush failures surface as warnings instead of being swallowed; session-log reads are cached
  by size+mtime; client hook lookups are indexed (no more O(N²) per row); switching sessions no
  longer leaks state between views.
- **0.4.50** — fixed cross-session GC deleting other sessions' snapshots; serialized GC against
  snapshot writes with a 10-minute grace window; `retentionLimit` now actually bounds snapshots;
  artifact rollback uses the version boundary's HEAD and refuses to overwrite a dirty worktree;
  `session.vN.jsonl.zstd` logs are resolved correctly; plugin HTTP routes enforce same-origin +
  JSON-only with reflected CORS; badge / title / water-level operations are reachable over HTTP;
  shared per-session locks; 15-second agent-stop timeout; two-step assistant recall; composer
  draft protection and IME-safe key handling.

---

## ⚙️ Settings → Recall

| Setting | Default | Notes |
|---|---|---|
| Show original-prompt reference | on | Collapsible reference under a resent message (display only). |
| Start from a new conversation after edit | off | Hide everything before the edited prompt as well. |
| Hide replaced messages by marker | on | Auto-degrades to visible when a marker would hide >40% of the conversation. |
| Version & artifact snapshots | on | Records a version per rollback; off = context-only rollback. |
| Git integration | on | Uses git when the workspace is a repo; one-click init is available in the timeline. |
| Version retention limit | 50 | Keeps snapshots for the most recent N versions (1–1000); the timeline keeps its own records (up to 200). |

---

## ⚠️ Requirements & limits

- Only user messages can be edited; recall works for both user and assistant messages.
- The agent must be idle. A running reply is cancelled and awaited, up to 15 seconds
  (`agent-stop-timeout`).
- Recall / edit target the active model surface: compressed or already-shadowed messages are
  rejected (`target-shadowed`), and unreadable or sparse session events report
  `log-unavailable`.
- Artifact rollback refuses to run when the worktree has uncommitted changes
  (`working-tree-dirty`); commit or discard them first.
- Regenerate resends only the text part of the prompt; prompts with images fall back to
  text-only.

---

## 🛠️ Development notes

This repo ships the source, not the private build toolchain:

```
lib/host-core.js       # transport-agnostic host logic
lib/index.js           # published host: service wiring + HTTP routes
lib/client.js          # client source (readable, React)
lib/client.bundle.js   # runtime entry (self-registering loader), kept in sync with client.js
lib/http.js            # HTTP seam (same-origin, JSON-only, status-coded errors)
lib/versioning.js      # snapshots, GC, git facts
lib/rollback.js        # context / artifact rollback executor
lib/artifact-store.js  # content-addressed store (~/.dsh/dsh-retrace/objects)
lib/git-adapter.js     # git status / checkout / init over the subprocess seam
lib/adapter/           # DSH session-log adapter + marker writer
scripts/e2e-layout.cjs # layout E2E (needs an external playwright install)
```

- `scripts/build-client.mjs`, `scripts/check-syntax.mjs` and `test/` are part of the
  checkout; run them with plain `node` (there is no `node_modules` — don't run
  `pnpm install` / `pnpm build`).
- Client changes must be made in **both** `lib/client.js` and `lib/client.bundle.js`, and both
  must pass `node --check`.
- The dynamic-plugin entry points (`lib/dynamic-*.js` and their `exports`) were removed in
  0.4.66: they had been frozen at 0.4.43 and silently skipped every safety fix since.
- Syntax check: `node scripts/check-syntax.mjs` (every `lib/**/*.js`, no exceptions).

---

## 📄 License

MIT. Original project © OfferKuai / Zhaofeng (Yaming); this fork maintained by
[daha1216](https://github.com/daha1216).
