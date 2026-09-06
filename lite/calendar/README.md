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
- `setArmed({ flowId, botId, armed })` — arm (activate) or disarm (deactivate) a scheduled flow through the deployer, polling its check route until the platform reports done; resolves with the refreshed flow. The payloads are the deployer SDK's own: activate `POST /flows/deploy { flowId, flowAlias, interactiveDebug: false, role }`, deactivate `DELETE /flows/deploy { flow: { id }, role }` (a bare flowId is a 400), `role` from `flow.data.deploy.role`.
- `flowLinks({ flowId, botLabel?, refresh? })` — where a flow lives and came from: Spaces it is an item in (the ADR-091 Designer mirror's agent asset with `gsxFlowId`, or any asset with `flowId` or a URL naming the flow), the playbook that built it (the flow-build watcher's KV queue names `{ playbookId, flowId }` per slot; slot bodies are read once per session), and journey maps in those Spaces or in a Space named like the GSX space. Every Space passes the ADR-084 sight rule, so a button is offered only for what the viewer may open.

Events (`events.ts`): `calendar.snapshot.*`, `calendar.space-events.*`, `calendar.flow-logs.*`, `calendar.set-armed.*`, `calendar.flow-links.*` spans; `calendar.open-window`, `calendar.open-flow`, `calendar.armed`, `calendar.disarmed`, `calendar.export-ics`.

## The schedule index

`index.ts` remembers, per flow id, the version (and modified time) last examined and what it showed: no schedule, or the parsed events. A cold space is read once with the bulk projection (main-tree steps); afterwards a scan lists only flow heads (`FLOW_HEAD_PROJECTION`, a few KB per space) and fetches a body only when a version is new. Flows that vanish from a space that listed fine are dropped; a space that fails to list keeps its entries. The index lives in a local file under userData and is mirrored to the account's KV (`calendar` / `schedule-index:<accountId>`) so a platform-side feed regenerator can share it (`index-store.ts`). Steady state: bots + heads, zero bodies.

## Space events and log summaries

- `spaceEvents({ fromMs, toMs, timeZone, refresh? })` — activity commits the viewer may see (sight-filtered like the Home tab), grouped per local day and per Space; the day link and the events modal read it. Unavailable without NEON; the calendar still shows flows.
- `flowLogSummary({ flowId, botId, fromMs, toMs, refresh? })` — on demand only: the deployer's log events for the run window, summarised (executions by request id, billed duration and peak memory from REPORT lines, END seen, steps, errors) plus a model narrative when configured. Cached five minutes.
- Flow descriptions ride along in both projections and the schedule index and show in the detail and day panes.

## Armed and not armed, arm / disarm, views, export (2026-09-05, evening)

- **Not armed is visible.** The header filter (All / Armed / Not armed) picks whose runs the grid shows; runs of a flow that is not armed are drawn dimmed with a dashed edge and say so in their tooltip. Under the day pane, "In this account" lists every scheduled flow with its state (armed / active · no trigger / not armed) and opens its detail on click.
- **Arm / Disarm** sits in the detail pane with an inline confirmation (no `window.confirm` in renderers); while the platform works the buttons are disabled and the question says so; on success the calendar reloads and toasts, on refusal the platform's message is the toast. A flow whose every schedule window has ended is told so before arming — and warned when the platform still holds a trigger for it.
- **Space, playbook & journey map** buttons appear in the detail pane when `flowLinks` finds any: "In Space · X" (the flow is an item there), "Near Space · X" (the playbook's Space or a Space named like the GSX space), "Open playbook · title" (WISER, `spaces.openWiser`), "Open journey map · title" (Journey Map Builder). None → one plain line.
- **Deep link to a Space.** The events modal's "Open Space" and the Space buttons call `spaces.open({ spaceId })`; main hands the id to a Spaces window that is still booting (`takePendingFocus`) or pushes `lite:spaces:focus-space` to a live one, and the Spaces renderer lands on that Space.
- **Week and Day views** (Month / Week / Day toggle; ← → move by the view's unit): seven Sunday-first columns with every run in time order, and a 24-hour agenda with runs grouped per hour. Both keep the Space-events link.
- **Export .ics** saves the runs in view (respecting the filter) through a save dialog: one VEVENT per run with a stable UID (`flowId.eventId.atMs`), UTC stamps, the flow description; a (flow, event) that fires more than twelve times on one day becomes a single all-day marker ("×288, every 5 min"). Pure builder in `ics.ts`.
- **Grey means it will not fire.** Every scheduled run is drawn. A run of an armed flow keeps its series colour; a run of a flow that is not armed is plain grey. The authored end date is advisory: the platform keeps firing an armed flow past it (observed live: the _ReportingAdapters "5min" flow, window ended 2020-02-01, fires every five minutes), so runs after the end are produced, flagged `pastWindow`, and explained in the tooltip. The subtitle counts runs that fire and grey runs separately. Occurrence cap 60,000 per window.
- **Rollup in a day cell.** One line per flow — the name, then the number (`×288`) or the time of a single run — at most three, then `+N more · M runs` (each flow's count in its tooltip). The event name appears only when one flow has several series that day. Cells are at least 118 px tall and the grid scrolls when the window is short.
- **Flows first.** The grid paints from the datahub as soon as it answers; Space events land when the graph answers (or not: a hanging graph — observed 2026-09-06, `RETURN 1` took the server's full 29 s — leaves the grid alone).
- **Timeouts.** Listings keep the 8 s budget; deployer calls (logs, deploy, check) get 30 s — a day-wide log scan took 9.8 s live and used to be cut at 8.
