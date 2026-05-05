# Onereach Desktop -- Quickstart

There are two apps in this one repo: the **full app** (root) and **Onereach Lite** (`lite/`). Both are Electron. You only need a few commands.

> Paste this whole file as the first message in your Cursor chat. Cursor will use it as ground truth for setup.

## 1. Setup (one time)

```bash
git clone https://github.com/wilsr7000/onereach_desktop.git
cd onereach_desktop
npm install
git config user.name  "Your Name"
git config user.email "you@onereach.com"
```

Requires Node 20+ and macOS Xcode CLT (`xcode-select --install`).

## 2. Run

```bash
npm run lite     # Onereach Lite
npm start        # full app
```

That is it. `npm run lite` builds and launches every time. Don't run anything else; the other `lite:*` scripts exist only for release engineering.

If you see "Another instance is already running":

```bash
pkill -f "Onereach.ai Lite" ; pkill -f Electron
```

## 3. Test (before opening a PR)

```bash
npm run lite:test:all   # Lite: typecheck + dep-check + unit + integration
npm test                # full app: unit
```

## 4. Fix a bug

1. Branch off main: `git checkout main && git pull && git checkout -b fix/<short-slug>`
2. Make the change. Run the app. Confirm the fix.
3. Run the tests for whichever app you touched.
4. Commit with the right prefix:
   - `[lite]` for changes inside `lite/`
   - `[full]` for changes outside `lite/` and outside `lib/`
   - `[lib]` for shared `lib/` (heads-up: dual-app review)
5. Push and open a PR:
   ```bash
   git push -u origin HEAD
   gh pr create
   ```
6. Request review from `@wilsr7000`. He merges.

**Do not push directly to `main`.** It's protected for a reason.

## 5. Where to find things

- Bugs to pick up: `PUNCH-LIST.md` (full) and `lite/LITE-PUNCH-LIST.md` (Lite)
- Strategic roadmap: `ROADMAP.md`
- The Lite rules you must follow: `lite/LITE-RULES.md` (10 rules; the only one you really need to remember: **Lite imports only from `lite/` and `lib/`**)
- Workspace conventions Cursor enforces: `.cursorrules`

## 6. Quick log triage while the app is running

```bash
# Lite
curl -s http://127.0.0.1:47392/health | python3 -m json.tool
curl -s "http://127.0.0.1:47392/logs?level=error&limit=20" | python3 -m json.tool

# Full app
curl -s http://127.0.0.1:47292/health | python3 -m json.tool
curl -s "http://127.0.0.1:47292/logs?level=error&limit=20" | python3 -m json.tool
```

## 7. Hard rules Cursor will hold you to

- No emojis in any UI text. Use `lib/icon-library.js`.
- No keyboard shortcuts unless the user asked by name.
- All AI/LLM calls go through `lib/ai-service.js`.
- In Lite, cross-module imports go through `<module>/api.ts` only -- never reach into `store.ts` or `main.ts`.
- Never log secrets (TOTP codes, OneReach tokens, Neon passwords, API keys).
- Update the relevant punch list when you finish a bug.

That's everything. If something doesn't work, the error message and the command you ran are enough -- ping with both.
