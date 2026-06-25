# Onereach.ai Lite — Manual QA Checklist

_Generated 2026-06-22 for **v0.0.19+** (`feat/lite-planning-wiser-playbooks`)._
_Grounded against the actual wired UI (verified by source inspection). The one genuinely-unbuilt area is listed under §13 so testers don't chase it._

Priority key: **P0** = regression-test first (touched this session, high blast radius) · **P1** = core flows · **P2** = edges/persistence/security.

---

## 0. 60-second smoke test (run before anything else)
- [ ] App launches → lands on **Home**, tab bar visible, **OR/Spaces button + Home pill** present, nothing clipped.
- [ ] Click **Spaces (OR) button** → Spaces window opens with the home dashboard.
- [ ] Open an **IDW** from the IDW menu → loads as a tab, **auto-logs-in** (no OneReach login wall).
- [ ] In Spaces, **add a text asset** → tile appears → open it → content renders.
- [ ] Quit + relaunch → tabs/IDWs/spaces still there, **still lands on Home** (not a stale tab).

---

## 1. P0 — Fixes made this session (regression-test FIRST)

### 1.1 Boot lands on Home (was: hung on a stale/login tab)
- [ ] Open 2–3 IDW tabs, leave one **active**, quit. Relaunch → **Home is active**, IDW pills present but inactive.
- [ ] Relaunch with a previously login-stuck tab → app is **not** stuck; Home shows.

### 1.2 Tab bar 48px / no clipping (`CHROME_HEIGHT_PX = 48`)
- [ ] Tab bar renders at full height; **Spaces button + Home + IDW pills not cut off** at the bottom.
- [ ] Active tab/feed view starts **flush below** the bar (no overlap, no gap).
- [ ] Resize / maximize / restore → bar stays 48px, content re-fits, nothing clipped.

### 1.3 IDW Home feed as Home-tab content
- [ ] Home shows the IDW feed below the bar; opening an IDW tab covers it; closing all IDW tabs brings it back.
- [ ] Feed URL unreachable → falls back gracefully (no white void / no crash).

### 1.4 Per-IDW **stable, isolated** partitions (`persist:idw-<id>`) — **critical**
- [ ] Open IDW A, sign into its internal system → **close tab → reopen** → still logged in (partition not wiped).
- [ ] Quit + relaunch → reopen IDW A → **still logged in**.
- [ ] Open IDW B → it does **NOT** share A's session (separate cookie jar). Confirm A and B never cross-contaminate.

### 1.5 Full-cookie auto-login injection (was: dropping Google-OAuth cookies)
- [ ] Sign in to OneReach once. Open an IDW that bounces through `auth.<env>.onereach.ai` → **SSO-skip auto-submits, account auto-selects, no login form**.
- [ ] Verify Google-OAuth-backed IDWs auto-login too (the broadened cookie clone).
- [ ] **Do NOT type the saved password manually** — the point is it auto-logs-in from the saved session.

### 1.6 KV persistence round-trip (was: menu/tabs/IDWs not persisting)
- [ ] Add an IDW, open tabs, add a Tool → quit → relaunch → **all survive** (full matrix in §10).

### 1.7 Agents-as-assets (shipped in v0.0.19)
- [ ] Spaces → add-asset modal has an **"Add agent"** tab.
- [ ] Paste **agent text** → "Converting…" → agent created with a **distinct violet tile + ◈ glyph**.
- [ ] Paste an **OKF URL** → fetched + converted (HTTPS-only; private/loopback hosts blocked).
- [ ] Agent detail pane shows the **OKF block + agentType**.
- [ ] Adding an agent to **Home/Uncategorized is rejected** (must be a real Space).
- [ ] Empty input / AI-not-configured / non-JSON Claude response → clear errors, no crash.
- [ ] Persists across relaunch.

### 1.8 Updater (packaged build only — dev/unpackaged is gated)
- [ ] Help → **Check for Updates…** with an older installed build → detects newer GitHub release.
- [ ] Download → **install on quit** → relaunch shows new version (Help → About).
- [ ] Downgrade is refused (`allowDowngrade=false`). Dev/unpackaged → check disabled.

---

## 2. P1 — Auth & login
- [ ] Sign in to OneReach (email/password **user-typed**) → window closes, signed-in state shows.
- [ ] **2FA autofill** from keychain fills the TOTP code automatically; manual entry still works.
- [ ] No saved TOTP secret → prompt/banner to add one in Settings → Two-Factor.
- [ ] **SSO-skip** on the auth interstitial when a valid session exists.
- [ ] **Account-picker auto-select** matches the known accountId.
- [ ] **Sign out** → cookies cleared; reopening an IDW shows a login again.
- [ ] Session **persists across relaunch** (no re-auth needed). Multi-account: two sessions coexist.

## 3. P1 — IDW agents
- [ ] IDW menu lists agents grouped by kind; empty state shows the "start your journey" item.
- [ ] Click an IDW → opens as a tab (deduped — second click focuses existing tab).
- [ ] **OAGI Store / Manage Agents** → add a custom agent (label + URL + kind) → appears in menu + Settings live.
- [ ] Edit / remove an IDW → menu + roster update without restart.

## 4. P1 — Main window (tabs & chrome)
- [ ] Open / close / activate IDW tab pills; close button appears on hover.
- [ ] Closing the active tab falls back to another tab or Home.
- [ ] Tabs persist across relaunch (but boot still starts on Home — see §1.1).
- [ ] Spaces button focuses the existing Spaces window if already open.

## 5. P1 — Spaces (list, wizard, scope)
- [ ] Spaces list renders; switch between spaces; **Uncategorized** intake shows untagged items.
- [ ] **Create a Space via the wizard**: name + description.
- [ ] **AI assist in the wizard**: type a **purpose** → AI drafts **description + objectives**; edit + save.
  - [ ] Empty purpose → "a purpose is required"; AI-not-configured → "add a Claude key" error.
- [ ] **Rename** a Space → updates live.
- [ ] **Soft-delete** a Space → hides + **Undo** restores it.
- [ ] Search/filter the spaces list (if a search box is shown).
- [ ] _Note: space **recolor** is **not** wired — don't test it (see §13)._

## 6. P1 — Assets & detail pane _(add-asset modal tabs: **text · upload · agent**)_
- [ ] **Add asset — text**: title + content (Markdown) → tile appears.
- [ ] **Add asset — upload**: pick a file (or **drag-drop**) → kind auto-detected (image/document/audio/video) → tile + preview.
- [ ] **Add asset — agent**: see §1.7.
- [ ] Per-kind tile rendering: document / image / url / text / audio / video / playbook / ticket / agent.
- [ ] Detail pane: image/binary **preview**; content render (**markdown vs code vs csv**); edit **title**, **description**, **tags** (add/remove), **reclassify kind**, **move/copy to Space**, **delete + restore**.
- [ ] Tile badges: **New** (since last visit) and **✨AI-produced** (`producedBy.kind==='Agent'`); **multi-space chip** when an asset is in >1 space.
- [ ] **Items search** returns matches; empty states (no spaces / no items / no content) read sensibly.

## 7. P1 — Spaces home dashboard & shared-space surface
- [ ] **Home dashboard** cards render: **Counts**, **Recent items**, **Top Contributors**, **Timeline**.
- [ ] **Timeline filters** — **People** vs **Agents** (agent-authored rows flagged); time windows if present.
- [ ] Click a recent item / timeline row → opens its detail pane.
- [ ] **Playbooks**: a shared space shows its current playbook; open/set a playbook.
- [ ] **Tickets**: list tickets; create/update a ticket (status, assignee).
- [ ] **Members/sharing**: members list shows; add/remove a member; current user marked.
> These are wired but may be partial — file bugs against actual behavior; flag anything that no-ops.

## 8. P1 — AI
- [ ] **Auto-enrich on new asset**: created asset gets AI metadata (summary/tags/topics) in the background; visible after refresh.
- [ ] **convertToOkf**: text path + URL path; **SSRF guard** blocks localhost/127.x/10.x/192.168.x/169.254.x/`.local`/IPv6-ULA and non-HTTPS.
- [ ] **Space-creation assist** (purpose → description + objectives) — see §5.
- [ ] Settings → AI: **save / has / delete** the Anthropic key (keychain); status pill updates; key shown masked, never read back.
- [ ] AI-not-configured → AI actions show a clear "add a key" error, app stays usable.

## 9. P1 — Settings · Tools · Files · Downloads · Bug-report · University · Onboarding · TOTP
**Settings** — opens (incl. deep-link to a section); sections: Account, AI, OAGI/Neon (**Test Connection** runs `RETURN 1`; password write-only), IDWs roster, Two-Factor; all persist.
**Tools** — Manage Tools: add/edit/delete a `{label, URL}` → appears in Tools menu → opens URL; persists.
**Files** — upload; signed short-TTL download URL works before expiry, 403 after; failure surfaced.
**Downloads** — picker shows file metadata + Space list; pick a Space + Save → asset created in that Space; last-used Space pre-selected; cancel cancels; signed-out refuses.
**Bug-report** — Help → Report a Bug; **redaction runs (mandatory)**; preview shows redaction count + recent logs; Save persists; list/edit status+notes; attachments upload.
**University** — Help → University lists curated entries; open one in the Learning Browser; external links open in default browser.
**Onboarding** — first-run checklist (signed-in / 2FA-saved / first-agent-opened); steps auto-complete; "later" dismiss sticks; per-account reset.
**TOTP** — store secret via QR scan / paste / manual; live 6-digit code + 30s countdown; Copy; Remove; survives relaunch.

---

## 10. P2 — Persistence matrix (all must survive quit→relaunch)
| KV store | Action | Expected |
|---|---|---|
| main-window tabs | open tabs → relaunch | tab list restored; **boot on Home** |
| onboarding | complete a step → relaunch | progress persists |
| tool entries | add tool → relaunch | in Tools menu |
| IDW entries | add custom agent → relaunch | in menu + Settings |
| bugs | submit report → relaunch | in bug list |
| auth sessions | sign in → relaunch | session restored |
| neon-config | configure → relaunch | endpoint/URI/user shown; **password never returned** |
| idw partitions | login in IDW → relaunch | IDW still logged in (§1.4) |

## 11. P2 — Errors, security, edges
- [ ] Corrupt KV blob → self-heals (warn + reset to defaults), app stays up.
- [ ] Network timeout / offline → graceful errors, no crash; defaults returned where applicable.
- [ ] Signed-out → auth-gated features blocked with a clear message.
- [ ] **Secrets never leak**: no multToken / TOTP secret / Neon password / API key in Health snapshot, logs, or IPC reads.
- [ ] Per-account isolation: switching accounts clears the prior account's KV-scoped data.
- [ ] Single-instance: launching again focuses the existing app.

## 12. Automated-coverage map — is there a test for each?

Four tiers: **unit** (92 files, pure logic/mocks), **integration** (16 files, real in-mem KV/log HTTP), **E2E** (Playwright drives the *built signed app*: `kernel-smoke`, `menu-lifecycle`, `api-docs`, `updater/`×5). Default gate `npm run lite:test` = typecheck + dep-check + **unit + integration only**; **E2E is separate** (`lite:test:e2e`, needs `lite:package:mac` first — run at release).

Legend: **✅✅** logic + real E2E · **✅** logic (unit/integration) · **🟡** adjacent logic only, live path not driven · **❌** no automated test.

| Checklist area | Test(s) | Verdict |
|---|---|---|
| 1.1 Boot lands on Home | `main-window-store` | 🟡 boot ordering logic; **no E2E asserts active==Home** |
| 1.2 Tab bar 48px / clip | `chrome-height-invariant` | ✅ invariant locks CSS==constant |
| 1.3 IDW feed as Home content | `main-window-store` | 🟡 logic only; live swap manual |
| 1.4 Per-IDW partition isolation+persist | `main-window-store` (derivation) | 🟡 derivation only; **isolation/relaunch not E2E'd** |
| 1.5 Full-cookie auto-login | `auth-store`, `sso-skip`, `auth-totp-autofill` | 🟡 logic strong; **real ceremony manual** |
| 1.6 KV persistence round-trip | `kv-migration`,`kv-client`,`sdk-kv-client`, `kv-integration` | ✅ strong |
| 1.7 Agents-as-assets (v0.0.19) | `spaces-sdk-client`,`ai-okf`,`ai-service-okf`,`spaces-renderer`,`spaces-detail-pane` | ✅ strong logic; live add-flow manual |
| 1.8 Updater | 9× `unit/updater/*` + 5× `e2e/updater/*` | ✅✅ incl. built-app E2E (real GitHub install still manual) |
| §2 Auth | `auth-api/-store/-errors/-re-signin/-totp-autofill/-twofa/-window-chrome`,`sso-skip`,`oauth-popup`,`auth-integration` | ✅ logic; sign-in ceremony manual |
| §3 IDW agents | `idw-api/-menu-builder/-store/-types`,`idws-section-form`,`bot-presets`,`idw-integration` | ✅ logic; live tab open manual |
| §4 Main window tabs/chrome | `main-window-api/-store`; menus via `e2e/menu-lifecycle` | ✅ logic + ✅✅ menus; tab UI manual |
| §5 Spaces wizard + AI assist | `spaces-api`,`spaces-renderer`; assist via `ai-api/-client/-enrich` | ✅ logic; live wizard manual · recolor = N/A |
| §6 Assets & detail pane | `spaces-renderer`,`spaces-detail-pane`,`spaces-api`,`spaces-sdk-client`,`spaces-metadata-extractor` | ✅ render/edit logic — **but drag-drop ❌, items-search ❌** |
| §7 Home dashboard / tickets / playbooks / members | `spaces-home-cards`, `integration/spaces/home-flow`; `spaces-sdk-client` | ✅ cards+filters+SDK strong; live UI manual |
| §8 AI | `ai-api/-client/-config/-content/-enrich/-key-store/-metadata/-okf/-service-okf/-chat` | ✅ strong (incl. SSRF guard); real Claude manual |
| §9 Settings/Tools/Files/Downloads/Bug-report/Univ/Onboarding/TOTP | each `*-api`/`*-store`(+integration); `kernel-smoke`(bug-report) + `e2e/api-docs`(Settings→Dev) | ✅ logic; ✅✅ bug-report + api-docs; live UI manual |
| §10 Persistence matrix | `*-store`,`kv-*`,`spaces-window-persistence`,`main-window-store`; `e2e/updater/cross-restart-state` | ✅ logic; ✅✅ updater restart; live relaunch manual |
| §11 Errors/security | `redaction-patterns`,`errors`,`health-store/-api`,`neon-credentials`,`module-/event-name-conformance` | ✅ strong |

### True gaps — no automated test exists (write these or test by hand)
- **Drag-drop upload** (renderer) — ❌ none.
- **Items search** (renderer) — ❌ no direct renderer test.
- **E2E for this session's P0 fixes** — boot active-tab == Home, per-IDW partition **isolation + persistence across relaunch**, the **cookie auto-login ceremony**, IDW-feed↔Home swap. All are unit-tested at the logic level but **not driven against the built app**; the `e2e/` harness (Playwright + real partitions) is the natural place to add them.
- **Auto-login + 2FA — the chain, not the links.** Every link is unit-tested with mocks (cookie capture `auth-store`; full-cookie inject `auth-store:injectTokenIntoPartition`; account auto-select + TOTP autofill `auth-totp-autofill`; 2FA-needs-setup `auth-twofa-needs-setup`; SSO-skip *URL* `sso-skip`; TOTP codegen `totp-*`; OAuth popup `oauth-popup`; re-sign-in `auth-re-signin-prompt`). **Not covered:** (a) no test chains sign-in→inject→open-IDW→SSO-skip→pick-account→2FA together; (b) the inject test seeds only `*.onereach.ai` cookies — the **Google/third-party-OAuth cookie clone** (this session's actual fix) is **not asserted**, so a regression dropping non-OneReach cookies would still pass; (c) SSO-skip's **submit action** and TOTP autofill run only against a **mocked DOM/spy** — selector drift on OneReach's real login/2FA page is caught by nothing, and there is **no `e2e/` auth spec** at all.
- **Agent endpoints** — N/A (feature not built yet; §13).

**Net:** nearly every area has automated *logic* coverage; updater + menus + bug-report + api-docs also have real built-app E2E. The behaviors most worth a human are exactly the P0 live ones above (real cookies/chrome/relaunch), plus the two renderer gaps.

---

## 13. NOT in the UI yet — do **not** test (in-progress / not wired)
- **Agent reachability endpoints (MCP / API / Skill + per-endpoint channels)** — types + graph done; **bridge + add-agent dialog fields + "Reachable via" detail render are mid-build** (`endpoint`/`REACHABLE_VIA`/`mcp` absent from the renderer). Will get its own test pass when it lands.
- **Space recolor** — no UI (create/rename/delete + undo are wired; color picker is not).
- **Bulk multi-select / "select all"** — not a built feature in the current renderer.
