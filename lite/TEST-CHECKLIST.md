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
