# Calendar — scheduled flows (ADR-090)

The GSX menu's **Calendar** opens this window: the signed-in account's scheduled flows on a month grid, with a day pane and a detail pane that opens the flow in GSX Designer. It replaced a link to `calendar.<env>.onereach.ai`, a host that does not exist.

**What "scheduled" means.** A flow is scheduled when its canvas carries the platform's **Schedule execution** step (template `5d352cdd-…`). At activation the step hands the Event Manager its schedule events — Quartz cron expressions (`expressions`), a time zone, a start and an end, recurring or once — and the Event Manager fires the flow. The Event Manager publishes no listing, so the Calendar reads the flow definitions, the same data the step registers.

**How it reads GSX** (`datahub.ts`, plain fetch, no SDK dependency): the account token from `em.<env>.api.onereach.ai/http/<account>/refresh_token` (the source the full app and the podscan tools use), the `data-hub-pg` service from discovery, then `/bots` and `/flows?query={"botId":…}`. `schedule.ts` finds the step and its events; `cron.ts` evaluates the expressions in their time zone (5–7 Quartz fields, lists, ranges, steps, names, `L`, `n#k`).

## API

`export interface CalendarApi`

- `snapshot({ refresh? })` — every scheduled flow (bots, flows, events, per-bot errors), cached 5 minutes.
- `occurrences({ fromMs, toMs, refresh? })` — runs within the window (≤ 400 days), ascending, capped at 20,000.
- `status()` — signed-in state, cache age, last error; no network.
- `openFlow({ flowId, botId })` — the flow in Lite's GSX window (`studio.<env>.onereach.ai/flows/<bot>/<flow>`).
- `openWindow()` — open or focus the Calendar.

Events (`events.ts`): `calendar.snapshot.*` span, `calendar.open-window`, `calendar.open-flow`.

## The schedule index

`index.ts` remembers, per flow id, the version (and modified time) last examined and what it showed: no schedule, or the parsed events. A cold space is read once with the bulk projection (main-tree steps); afterwards a scan lists only flow heads (`FLOW_HEAD_PROJECTION`, a few KB per space) and fetches a body only when a version is new. Flows that vanish from a space that listed fine are dropped; a space that fails to list keeps its entries. The index lives in a local file under userData and is mirrored to the account's KV (`calendar` / `schedule-index:<accountId>`) so a platform-side feed regenerator can share it (`index-store.ts`). Steady state: bots + heads, zero bodies.
