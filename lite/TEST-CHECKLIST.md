# Onereach.ai Lite — Feature Test Checklist

> Every user-facing feature, grouped by surface, with how-to-test steps and
> expected results. Sourced from the module inventory (`lite/*/`), menu
> registry, settings sections, and ADRs. Check items off per test pass.
>
> **Prereqs**: signed-in OneReach (edison) account · Anthropic key for AI
> items (Settings → AI) · `npm run lite` (dev) or the packaged app.
> Items marked **NEW** landed 2026-08-05 (ADR-050/051 + fixes) and are
> untested outside this session's live checks.

---

## 1. Boot & App Shell

- [ ] **Launch + single instance** — `npm run lite`; a second launch exits with
      "Another instance is already running." Expected: one app, no crash.
- [ ] **Boot chat** — on boot, the boot-progress chat surface appears and
      compresses events into readable status lines.
- [ ] **Dock icon** — **NEW** blue-gradient squircle (iDW·LITE) in the packaged
      app; transparent corners (no white box).
- [ ] **Auto sign-in** — relaunch after a prior sign-in; session restores
      without manual login; main window loads signed-in.
- [ ] **Signed-out boot is quiet** — sign out, relaunch; `/logs/stats` shows
      `error: 0` after ~70s (no KV/files auth noise).

## 2. Tray (menu bar)

- [ ] **Icon legibility** — **NEW** monochrome hexagon template: crisp on both
      light and dark menu bars (flip macOS appearance to verify).
- [ ] **Version header** — **NEW** first menu row reads
      `Onereach.ai Lite v<version>` (disabled caption).
- [ ] **Show/Hide** — toggles the main window; left-click also toggles.
- [ ] **Spaces… / Settings… / Help** — each opens its window.
- [ ] **Quit** — exits cleanly.
- [ ] **Pulse animation** — icon "breathes" subtly; `LITE_TRAY_ANIMATION=0`
      disables it.

## 3. Auth & Identity

- [ ] **Sign in (edison)** — auth window completes; `mult` + `or` cookies
      captured (verify in Settings → Account).
- [ ] **Multi-env tokens** — sign into staging/dev too; tokens held per-env
      without clobbering edison.
- [ ] **Sign out** — cookies cleared, Spaces cache invalidated (no stale data
      for the next account), menus/windows degrade gracefully.
- [ ] **Re-sign-in prompt** — expire/revoke a token (or wait); on auth
      rejection the re-sign-in prompt appears instead of silent failures.
- [ ] **Settings → Account** — shows email/accountId/dates + both token values
      with Copy buttons; tokens show as cleared after relaunch until re-login.
- [ ] **Two-Factor (Settings → Two-Factor)** — store a TOTP secret (keychain);
      live 6-digit code with countdown; code autofills on OneReach auth pages.
- [ ] **IDW auto-login** — open an IDW; per-IDW partition
      (`persist:idw-<id>`) keeps its session across app restarts; cookies
      injected once.
- [ ] **IDW login-verifier** — force a logged-out IDW tab; "needs user action"
      badge/notification appears instead of an endless reload loop.
      *(Known gap: SSO-skip auto-click selectors are stale — manual click may
      be needed; diagnosed, fix pending.)*

## 4. Main Window

- [ ] **Tabbed browsing** — open several tabs; titles/favicons update; tabs
      persist across restart; closing a tab clears its orphaned partition.
- [ ] **OR-logo Spaces button** — 40×40, breathing animation; opens Spaces.
- [ ] **OAGI + Manage Agents buttons** — open the OAGI store / roster section.
- [ ] **Auto-signin reload** — after sign-in completes, open tabs reload into
      the authenticated state.

## 5. Menus

- [ ] **App menu** — About (version/credits), Settings…, Quit.
- [ ] **Edit menu** — copy/paste/undo work in inputs.
- [ ] **IDW menu** — six sections (IDWs, External Bots, Image Creators, Video
      Creators, Audio Generators with sub-categories, UI Design Tools);
      entries open the agent browser; empty state points to Manage Agents.
- [ ] **Tools menu** — curated tools open in browser windows; `Spaces…` entry;
      `Manage Tools…` opens the manager.
- [ ] **Planning menu** — WISER Playbooks launcher opens.
- [ ] **Agentic University menu** — Open LMS, Quick Starts, View All
      Tutorials, AI Run Times, Wiser Method each open their surface.
- [ ] **Help menu** — help window opens (three-pane docs).
- [ ] **Dev Tools** — toggles devtools on the focused window.

## 6. Spaces — Navigation & Home

- [ ] **Sidebar** — Home, all Spaces (color dots), Uncategorized with count;
      `AI` pill on shared spaces; **NEW** 🔒 pill on restricted spaces.
- [ ] **Home feed** — 5 cards: at-a-glance counts, recent activity, agents
      sample, permissions, just-added; unified timeline with filter chips;
      60s stale-while-revalidate refresh.
- [ ] **Space view** — item cards with multi-space chips; header shows name,
      click-to-edit objective/description; search box filters items
      server-side; New + Refresh buttons.
- [ ] **Middle pane vs detail rail** — open an item: 480px rail on wide
      windows; overlay below 1100px; middle pane never crushes.

## 7. Spaces — Assets (CRUD + preview)

- [ ] **Create text asset** — New → paste text; auto-extracted metadata (word
      count etc.); card appears.
- [ ] **Create file asset (upload)** — **NEW GSX-first**: pick an image/PDF;
      bytes upload to GSX (`lite-spaces/assets/<uuid>-<name>`), graph node
      carries `fileKey` only. Verify preview renders via signed URL and
      `/logs?category=files` shows `files.upload.finish`.
- [ ] **Upload cap** — a >100MB file is rejected with a clear message.
- [ ] **Drag-and-drop upload** — drop a file onto the items region; same flow.
- [ ] **Create agent asset** — Add Agent tab: paste OKF URL/text → AI converts
      → violet agent card + parent `:Agent` node; endpoints (MCP/API/Skill)
      recorded.
- [ ] **Previews (9 kinds)** — image, video, audio, PDF, code, CSV, markdown,
      URL, text each render a sensible preview/download affordance.
      *(markdown: driven-verified 2026-08-05 — upload .md → renders headings /
      bold / code / fence / blockquote / ☐ tasks with ✎ Edit → Save →
      re-render; text tiles show content excerpts.)*
- [ ] **Edit asset** — click-to-edit title, description, content (Save/Cancel,
      ⌘↵/Esc); tag chips add/remove; metadata add/edit/remove with type
      coercion.
- [ ] **Delete / restore** — delete shows undo toast (soft delete); restore
      brings it back.
- [ ] **Move / add-to-space / remove-from-space** — item participates in
      multiple spaces; chips update.
- [ ] **Search** — substring search within a space and globally.
- [ ] **Attribution** — detail shows "Created by … / Last edited …" provenance.
- [ ] **Activity log** — per-asset recent commits timeline renders.
- [ ] **GSX migration sweep** — **NEW**: on boot (~20s after init) any legacy
      base64-stub assets upload to GSX and the node flips to `fileKey`
      (`/logs?category=spaces` → `spaces.gsxMigrate.finish` with counts).

## 8. Spaces — AI (Claude)

- [ ] **Settings → AI** — save Anthropic key (keychain, write-only), status
      pill flips to "Key configured"; Clear key works.
- [ ] **Auto-metadata on create** — with key set, create text/image/PDF
      assets; "✨ Metadata added automatically" toast; `ai_*` keys (summary,
      tags, topics, entities, key points, model) appear in metadata.
- [ ] **Manual ✨ Auto-fill** — button in the detail metadata editor
      re-generates; toast reports field count.
- [ ] **Space assist** — new/edit Space: purpose → drafted description +
      objectives.
- [ ] **No key = silent** — without a key, creates succeed with no AI toasts
      or errors.

## 9. Spaces — Sharing & Visibility

- [ ] **Members (shared dashboard)** — flip a space to `shared`: dashboard
      shows playbook section, tickets (create/update status), member chips;
      `+ Member` adds by email (Person upsert) or agent id; × removes.
- [ ] **Shared-space polling** — dashboard refreshes on its poll cadence.
- [ ] **Visibility toggle** — **NEW**: header chip flips 🔓 Open ⇄ 🔒 Members
      only on ANY space kind; restricting shows "you were added as a member".
- [ ] **Restricted gating** — **NEW**: as a non-member (second account), the
      restricted space vanishes from sidebar, search, Home feed, and direct
      item fetches; members still see everything. Existing spaces stay open
      by default.
- [ ] **Member strip on restricted spaces** — **NEW**: header shows members +
      `+ Member` on restricted user-kind spaces (not just shared ones).
- [ ] **Playbook-backed agents** — Event Manager / Meeting Starter seeded
      agents present; plan→playbook→generate build flow works.

## 10. Downloads

- [ ] **Capture** — download a file from any browser surface in the app; the
      save-to-space picker appears; choosing a space creates a GSX-backed
      asset (sanitized filename).
- [ ] **Skip** — dismissing the picker downloads normally without an asset.

## 11. Tools / IDW / University / API Docs

- [ ] **Manage Tools** — add/edit/remove a curated tool; Tools menu rebuilds
      live; entries persist (KV) across restarts.
- [ ] **Manage Agents ("Your AI Roster")** — inline edit an IDW entry; removal
      asks confirmation; menu updates.
- [ ] **OAGI Store** — catalog loads from the graph (skeleton shimmer →
      cards); install adds to the roster with a toast.
- [ ] **Agent browser windows** — each agent opens in its placeholder browser
      with its own partition.
- [ ] **University surfaces** — LMS / tutorials / Wiser Method pages load.
- [ ] **API Docs window** — reference renders from the generated manifest.

## 12. AI Run Times

- [ ] **Feed** — articles list loads (fetcher + extractor).
- [ ] **TTS playback** — play an article; audio streams; **replay hits the GSX
      cache** (no second OpenAI charge) — *first live-viable test now that
      files auth is fixed (token minter)*.
- [ ] **Store self-heal** — corrupt store blob recovers instead of crashing.

## 13. Settings (remaining)

- [ ] **Neon/OAGI** — endpoint/URI/user/database shown; connection test
      passes; hasPassword true.
- [ ] **Diagnostics** — health snapshot renders (app, windows, account, 2FA,
      OAGI, updater, recent errors); Refresh re-pulls; Copy as JSON works;
      NO secrets present in the copied JSON.
- [ ] **Developer** — dev flags/tools section functions.
- [ ] **Onboarding** — first-run tour appears on a fresh profile; completes
      and never re-prompts (persisted per account).

## 14. Bug Reports

- [ ] **Modal** — opens (menu); description required; Send writes to
      `userData/lite-bugs/` and includes the health snapshot.
- [ ] **Attachments** — attach a screenshot/log (≤10MB, ≤ cap count); **NEW**:
      upload now authenticates via the minted token — verify no
      "Cross account" error in `/logs?category=files`.
- [ ] **Redaction** — payload contains no tokens/secrets (search the JSON).

## 15. Observability & Updater

- [ ] **Log server** — `http://127.0.0.1:47392/logs?category=spaces` (etc.)
      serves events; `/logs/stats` aggregates; every module's actions emit
      `<module>.<op>.start/finish/fail` + `<module>.ipc.*` events (ADR-030).
- [ ] **Updater** — About/menu check finds the latest GitHub release;
      signed-unnotarized auto-update downloads, installs on relaunch.

---

*Cross-cutting invariants worth spot-checking during any pass: dark-mode
scrollbars everywhere; no white-flash on window open; account switch never
shows the previous user's data; kill -9 + relaunch loses no persisted state.*

---

## 15. WISER Playbooks & Cap Chew (landed 2026-08-09/10, v0.0.47–49)

> Pause point: before publishing a release, and after any change to the
> WISER window, the Spaces↔WISER bridge, or the updater. ☠ marks the
> steps that have actually burned us — most dangerous to skip.

### WISER Playbooks window
- [ ] **Open** — Planning → WISER Playbooks: window opens with the PAPER
      header (WISER PLAYBOOKS wordmark + mini cap-chew bullet at right);
      macOS traffic lights sit inset over paper, not over app content.
- [ ] ☠ **Input reaches the app** — scroll the plans list, click a plan,
      type in the editor. (0.0.47 regression: a full-body drag region ate
      every click/scroll. Drag must work ONLY on the 38px bar.)
- [ ] **Drag + zoom** — drag the window by the header bar; double-click
      the bar zooms. Dragging from app content must NOT move the window.
- [ ] **Containment** — external links open in the OS browser; the app
      view never navigates off the Playbooks origin (window.ai preload
      must not leak cross-origin).
- [ ] **Paper end-to-end** — with the paper riff build deployed, header
      and app read as one ivory surface.

### Spaces ↔ WISER bridge
- [ ] **Paper tiles, all three variants** — a playbook renders IVORY in
      the dark grid: (a) grid card, (b) shared-space dashboard card,
      (c) hero treatment (violet→gold foil ring ON paper; pills/progress
      in ink-friendly tints). No dark playbook tile anywhere.
- [ ] **Double-click opens the instrument** — grid card AND shared
      dashboard card: double-click opens the WISER window. Single click
      still opens the detail pane.
- [ ] **Deep link** — an asset with `metadata.riffId` opens WISER at that
      playbook (`?riff=`); without one, WISER opens plainly and the
      detail button's tooltip says so.
- [ ] **Detail button** — paper-primary "Open in WISER Playbooks" in the
      playbook detail rail; absent on non-playbook kinds and on preloads
      without the bridge.

### Session expiry handling (2026-08-11 — the "login broken AGAIN" fix)
- [ ] ☠ **Server-dead session never re-injects** — with a stale session,
      opening an IDW goes to ONE clean sign-in (no 20s probe storm, no
      session-expired bounce loop). Log shows auth.session.server-expired
      then the normal sign-in path.
- [ ] **Boot validation** — start the app with a server-expired session:
      within seconds the app flips to signed-out (log: server session
      validation verdict=dead) instead of pretending hasSession.
- [ ] **Keep-alive** — leave the app running >10 min signed in; log shows
      periodic "server session validation verdict=alive" per env.
- [ ] ☠ **Offline ≠ signed out** — disconnect the network, restart: the
      session survives (verdict=unreachable changes nothing).
- [ ] **Account picker auto-select** — when the picker appears, Lite
      clicks your account row by EMAIL (or the only row) automatically;
      verdict account-picker (not no-session) if it must wait for you.
- [ ] **Multi-env** — sign-in works per env (edison/staging/dev/
      production); sessions, vault entries, and keep-alive are
      independent per env. Production URLs need live verification.

### Asset view audit trail (2026-08-10 — who looked at what, when)
- [ ] **Opening an asset records a view** — open an asset's detail
      pane while signed in; a (:Person)-[:VIEWED]->(:Asset) edge is
      written/updated in the graph (firstAt/lastAt/count).
- [ ] **"Viewed by" shows in the detail pane** — the pane lists who
      has viewed the asset, most-recent first, with a ×N count for
      repeat views. Empty (nothing) when no one has viewed it yet.
- [ ] **Deduped** — rapidly re-rendering the same asset does not
      inflate the count (60s per-asset window).
- [ ] **Signed-out / invisible = no write** — the write no-ops when
      signed out ($viewerId='') or the asset isn't visible to you.

### Onboarding & config provenance (2026-08-10)
- [ ] **Config source is visible** — Settings → OAGI shows "Config
      source": "Your OneReach account" when your KV has a record,
      "Bundle default (temporary)" when signed-in but unprovisioned,
      "Not configured" when neither.
- [ ] ☠ **Public-build posture** — a build launched with
      `LITE_NO_BAKED_GRAPH=1` has NO baked graph creds: Settings shows
      "Not configured" until you sign in + the account is seeded. (This
      is the switch that retires the plaintext-creds blocker.)

### Cap Chew identity
- [ ] **About signs off** — Settings → About shows the real chewed-bullet
      logo (packaged path, not a broken image), "Made with care. Come as
      you are."

### Auth session persistence (2026-08-10 — "sign in once")
- [ ] ☠ **Survives restart** — sign in to OneReach once, open an IDW
      (loads signed-in), then QUIT and reopen Lite: the IDW opens
      signed-in WITHOUT a login page. (Pre-fix: session cookies were
      evicted on quit → login every time. The keychain SessionVault
      restores them on boot.)
- [ ] **One login covers all IDWs** — after that single sign-in, every
      new IDW tab opens signed-in (cookies cloned into each partition).
- [ ] **Sign-out truly signs out** — Settings → Account → Sign out,
      then reopen: no session is resurrected from the vault (it's
      cleared on sign-out).
- [ ] **Expired server session falls through** — if OneReach expires
      the session server-side, the tab shows the login page (restore
      doesn't mask a dead session); signing in re-vaults fresh tokens.

### Updater (the 0.0.46/47 scars)
- [ ] ☠ **Auto-update lives** — Settings → Updates → Check for Updates
      finds the feed and downloads/installs. The "Automatic updates are
      not available in this build" dialog = a DEAD updater (0.0.47 shipped
      one; transitive deps missing). Release-blocking, always.
- [ ] **Out-of-band recovery clears the trail** — with a recorded failed
      attempt on version X, manually installing a NEWER version boots
      with no failure dialog and an emptied update-state.json.
- [ ] **Breaker still guards** — repeated failures of the SAME version
      still escalate to the stop-retrying dialog (bounded retry intact).

### Release pipeline (meta — runs inside release-lite.sh)
- [ ] **Gate** — typecheck + dep-check + unit + integration green.
- [ ] ☠ **Asar tripwires** — main-lite.js, wiser-header.html,
      preload-lite-wiser.js, keytar present. Edit this list ONLY against
      the BUILT bundle's require()s — never source greps (0.0.46 lesson).
- [ ] ☠ **Boot smoke** — the freshly packaged binary boots: banner OR
      the single-instance handoff both pass; a bannerless exit or an
      "electron-updater not available" log line aborts the cut.
- [ ] **Manifest sanity** — latest-mac.yml version + artifacts match the
      tag before anything uploads.

### Known limitation (2026-08-10)
- The e2e suite CANNOT run while the installed app is running: specs
  poll the log server on the baked port 47392 and read the LIVE app
  instead of the test instance (pure timeouts, no product errors).
  Quit the app before `lite:test:e2e`, until ports are env-overridable
  and threaded through lite/test/harness/launch.ts.

### riff app (companion suite — ~/AI First Notes)
- [ ] **Theme integrity** — after adding color classes, re-run
      `node scripts/gen-capchew-theme.mjs`; no dark residue on any screen.
- [ ] **Welcome line** — "Keep chewing until agents can execute it
      without failure." on the empty state; onboarding carries the
      explainer.
- [ ] **Chew cadence** — capChewVoice tests green (1-in-5, never twice in
      a row); persona never explains the metaphor in live chat.

