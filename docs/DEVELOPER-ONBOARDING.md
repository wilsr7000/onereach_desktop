# Developer Onboarding -- Onereach Desktop

Bootstrap brief for a new developer joining the repo. Hand this to anyone who needs to clone, run, and start fixing bugs in either the full app or Onereach Lite.

> If you are setting up Cursor for the first time, paste this whole document as the first message in your Cursor chat. It tells Cursor everything it needs to act correctly in this repo.

---

## What this repo is

A monorepo for two Electron apps:

- **Full app** at the repo root -- the production Onereach.ai desktop app (`main.js`, `packages/`, `lib/`, etc.)
- **Onereach Lite** at `lite/` -- a slim strangler app that ships independently, currently being hardened toward v1
- **Shared code** at `lib/` -- both apps read from here, no upward dependencies

Two separate distribution repos exist for releases (you do NOT need write access to fix bugs):

- `wilsr7000/Onereach_Desktop_App` (full)
- `wilsr7000/Onereach_Lite_Desktop_App` (Lite)

---

## 1. One-time setup

```bash
# Clone the source repo
git clone https://github.com/wilsr7000/onereach_desktop.git
cd onereach_desktop

# Install dependencies (postinstall pulls down Claude Code too)
npm install

# Set your git identity for this repo so commits attribute correctly
git config user.name  "Your Name"
git config user.email "you@onereach.com"

# Optional but recommended: GitHub CLI for issues/PRs from the terminal
brew install gh
gh auth login
```

You need at least `write` access on `wilsr7000/onereach_desktop`. The admin (`@wilsr7000`) can grant it via:

```bash
gh api -X PUT repos/wilsr7000/onereach_desktop/collaborators/<your-github-username> -f permission=push
```

---

## 2. Cursor setup

- Open the cloned `onereach_desktop` folder in Cursor.
- Cursor will auto-load `.cursorrules` (workspace conventions) and `.cursor/rules/*.mdc` (per-area rules including `api-integration.mdc` and `testing-guide.mdc`).
- Recommended Cursor settings for this repo:
  - "Auto-run" off for shell commands until you are comfortable -- the repo has destructive scripts under `scripts/`.
  - Use Plan mode for anything touching `lite/` -- the porting ledger expects per-chunk hardening.
  - Keep the chat focused on one bug per session; reset between unrelated tasks so context stays clean.

---

## 3. Read-before-coding (constitutional documents)

Always check these first; they are the source of truth:

- `PUNCH-LIST.md` -- full app bugs/features
- `ROADMAP.md` -- both-app strategic roadmap
- `lite/LITE-RULES.md` -- Lite's 10 rules. The most important one: **Lite imports only from `lite/` and `lib/`. Full does not import from `lite/`. `lib/` has no upward dependencies.**
- `lite/PORTING.md` -- per-port chunk-hardening status
- `lite/DECISIONS.md` -- ADRs
- `lite/LITE-PUNCH-LIST.md` -- Lite-specific bugs
- `CONTRIBUTING.md` -- workflow notes
- `.cursorrules` -- workspace conventions

---

## 4. Run the apps

```bash
# Full app
npm start            # production-ish
npm run dev          # NODE_ENV=development

# Lite
npm run lite         # build + launch
npm run lite:dev     # development mode
npm run lite:dev:updater  # use this when testing the auto-updater
```

Lite logs land at `http://127.0.0.1:47392/logs`; full app logs at `http://127.0.0.1:47292/logs`.

---

## 5. Run tests

```bash
# Full app
npm test                          # vitest unit
npm run test:e2e                  # Playwright
npm run test:journey              # full smoke + API + spaces + settings

# Lite
npm run lite:typecheck            # TS strict
npm run lite:dep-check            # dep-cruiser boundary rules
npm run lite:test:unit            # vitest unit
npm run lite:test:integration     # vitest integration
npm run lite:test:all             # all of the above
```

Always run `lite:typecheck`, `lite:test:unit`, and `lite:build` before sending a PR for any `lite/` change.

---

## 6. Workflow -- branch + PR (REQUIRED)

`main` is protected; all changes go through PRs. **Do not push directly to `main`** even when the rule lets you bypass.

```bash
# Pull latest
git checkout main && git pull origin main

# Branch per bug. Suggested prefixes:
#   fix/<area>-<slug>      bug fix
#   feat/<area>-<slug>     new feature
#   docs/<slug>            documentation only
#   chore/<slug>           tooling / housekeeping
git checkout -b fix/lite-totp-account-picker

# Work, commit small focused commits.
git add <paths>
git commit -m "[lite] fix(auth): <one-line summary>

<why this changes the behavior, and any non-obvious tradeoff>"

# Push and open PR
git push -u origin HEAD
gh pr create \
  --title "[lite] fix(auth): account picker auto-select" \
  --body "Fixes #<issue>

## Summary
- ...

## Test plan
- [ ] npm run lite:typecheck
- [ ] npm run lite:test:unit
- [ ] manual smoke against the real flow
"
```

Commit prefixes (from `lite/LITE-RULES.md`):

- `[lite]` -- changes inside `lite/`
- `[full]` -- changes outside `lite/` and outside `lib/`
- `[lib]` -- changes inside `lib/` (eventually requires dual-app review)

When you port code from the full app into Lite, the commit message also names the borrowed pattern:

```
[lite] foo.ts: borrows X pattern from full/foo.js:NNN-MMM; rewrites Y for lite scope.
```

---

## 7. Bug triage cheat sheet

While Lite is running:

```bash
# Health
curl -s http://127.0.0.1:47392/health | python3 -m json.tool

# Recent errors
curl -s "http://127.0.0.1:47392/logs?level=error&limit=20" | python3 -m json.tool

# Live stream
curl -N "http://127.0.0.1:47392/logs/stream"

# Specific category (e.g. auth, totp, main-window, idw, kv, neon, ai, settings)
curl -s "http://127.0.0.1:47392/logs?category=auth&limit=80" | python3 -m json.tool

# Free-text search
curl -s "http://127.0.0.1:47392/logs?search=auth-totp-autofill&limit=80" | python3 -m json.tool
```

Same endpoints exist on `47292` for the full app.

---

## 8. Hard rules to keep Cursor honest

When asking Cursor to fix something, remind it of these (or rely on `.cursorrules`):

- **No emojis** in any user-facing UI text. Use icons from `lib/icon-library.js`.
- **No keyboard shortcuts / accelerators** unless explicitly requested by name.
- **All AI/LLM calls** go through `lib/ai-service.js` -- never raw fetch to OpenAI/Anthropic.
- **No regex / keyword classifiers** -- use semantic understanding.
- **Lite cross-module imports** go through `<module>/api.ts` only -- never reach into `store.ts` / `main.ts` / internals.
- **Do not log secrets** -- TOTP codes, OneReach tokens, Neon passwords, API keys.
- **Update `PUNCH-LIST.md` / `lite/LITE-PUNCH-LIST.md`** when you finish a bug.

---

## 9. How the admin gets your work

You push a branch, open a PR against `main`, and request review from `@wilsr7000`. CODEOWNERS is set up so changes under `/lite/`, `/lib/`, or constitutional docs auto-request him as a reviewer. Once approved + checks pass, he merges. Releases are cut from the distribution repos by the admin via `npm run release` (full) or `npm run lite:release:mac` (Lite).

---

## 10. Recent context worth knowing

- Most recent Lite work: 2FA auto-fill + account-picker auto-select inside main-window tabs (commit `83c05b3`). Read `lite/auth/totp-autofill.ts` and `lite/auth/store.ts injectTokenIntoPartition` to see the pattern for tab-watcher + cookie injection.
- Lite is still in Phase 0 hardening -- expect frequent changes to the porting ledger (`lite/PORTING.md`).
- Full app is on v5.0.0; macOS notarization is the open critical bug (see `PUNCH-LIST.md`).

That is enough to start. When in doubt, read the constitutional docs first, then ask in PR review.
