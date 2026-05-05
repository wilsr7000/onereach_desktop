# Onereach Lite -- Quickstart

You'll be working on Onereach Lite (the new strangler app at `lite/`). Three commands. That's it.

> Paste this whole file as the first message in your Cursor chat. Cursor will use it as ground truth.

## Setup (one time)

```bash
git clone https://github.com/wilsr7000/onereach_desktop.git
cd onereach_desktop
npm install
git config user.name  "Your Name"
git config user.email "you@onereach.com"
```

Need: Node 20+ and Xcode CLT (`xcode-select --install`).

## Run

```bash
npm run lite
```

That builds and launches Lite. Done. No other commands.

If a stale instance blocks startup:

```bash
pkill -f "Onereach.ai Lite" ; pkill -f Electron
```

## Test (before opening a PR)

```bash
npm run lite:test
```

That runs typecheck + dep-check + unit + integration. If it passes, you're good.

## Fix a bug

1. `git checkout main && git pull && git checkout -b fix/<short-slug>`
2. Make the change. Run `npm run lite` and verify.
3. `npm run lite:test`
4. Commit with `[lite]` prefix.
5. `git push -u origin HEAD && gh pr create`
6. Request review from `@wilsr7000`. He merges.

**Never push to `main` directly.** It's protected.

## Where the bugs live

- `lite/LITE-PUNCH-LIST.md` -- pick from here
- `lite/LITE-RULES.md` -- the only rule you need to remember: **Lite imports only from `lite/` and `lib/`**
- `.cursorrules` -- workspace conventions Cursor enforces

## Triage logs while the app runs

```bash
curl -s http://127.0.0.1:47392/health | python3 -m json.tool
curl -s "http://127.0.0.1:47392/logs?level=error&limit=20" | python3 -m json.tool
```

## Hard rules Cursor will hold you to

- No emojis in UI.
- No keyboard shortcuts unless explicitly asked by name.
- All AI calls go through `lib/ai-service.js`.
- Cross-module imports inside `lite/` go through `<module>/api.ts` only.
- Never log secrets (TOTP codes, OneReach tokens, passwords, API keys).
- Update `lite/LITE-PUNCH-LIST.md` when you finish a bug.

If something breaks: paste the exact command and the exact error. That's enough.
