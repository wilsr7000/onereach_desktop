# HUD Core - Port Contracts

The HUD extraction is **complete**. This doc describes the ports
that consumers (GSX flows, WISER Playbooks, CLIs) must supply to
get a full routing pipeline online.

**Ports actually used by shipped modules:**

| Port | Module(s) that use it | Requirement |
| - | - | - |
| `ai` | `task-decomposer` (Phase 5) | Required for auto-decomposition of composite requests. Omit to always treat input as single-task. |
| `log` | Many (via constructor) | Optional. Default: silent logger. |
| `now` | `conversation-continuity`, `dedup`, `affect-tracker` (naturalness), `bid-protocol.createTimeoutPolicy` | Optional. Default: `Date.now`. |
| `spaces` | Not required by hud-core directly; the naturalness layer uses it. Consumers may plug it in for their own persistence. | Optional. |

**Ports NOT required for a full hud-core pipeline:**

- `agents` / `bidder` / `executor` / `taskStore` / `conversationHistory` / `settingsManager` — these are consumer-provided infrastructure, but hud-core's decision logic doesn't call them directly. The **shape** of these is documented below so different consumers produce interchangeable implementations.

## Port summary

| Port | Required by (eventual module) | Shape |
| - | - | - |
| `agents` | Winner selection, vote aggregation | `{ list(): Promise<Agent[]>, get(id): Promise<Agent\|null> }` |
| `bidder` | Bid collection | `{ collect(task, agents): Promise<Bid[]>, timeoutMs?: number }` |
| `executor` | Agent execution | `{ execute(agent, task): Promise<ExecutionResult> }` |
| `conversationHistory` | Continuity heuristic, multi-turn routing | `{ add(role, content, meta?), recent(limit?), clear() }` |
| `taskStore` | Duplicate detection, pending task routing | `{ recent(limit?), markDuplicate(id), findPending(): Task\|null }` |
| `spaces` | Agent memory, task rubrics, debug logs | `{ files: { read, write, delete } }` (same shape as naturalness) |
| `log` | All modules | `{ info, warn, error }` |
| `now` | Timestamps in stored decisions, TTL on continuity | `() => number` |
| `settingsManager` | Flag resolution | `{ get(key), set(key, value) }` (optional) |
| `ai` | LLM-based disambiguation, task decomposition | `{ call(prompt, opts): Promise<{content: string}>}` |

## Port details

### `agents`

The registry of available agents. Unlike the desktop app's live
WebSocket connections (`localAgentConnections` Map in exchange-bridge),
this port works with agent **metadata** only -- the object a bidder
needs to decide whether an agent is a candidate, not a live socket.

```ts
interface Agent {
  id: string;
  name: string;
  voice?: string;
  executionType: 'informational' | 'action' | 'system';
  defaultSpaces?: string[];
  bidExcluded?: boolean;
  // ... per-agent fields
}

interface AgentsPort {
  list(): Promise<Agent[]>;
  get(id: string): Promise<Agent | null>;
}
```

Consumers in a distributed setting (GSX flow, WISER) can back this
port with a Spaces lookup or a remote registry service.

### `bidder`

Collects bids from the eligible agent pool. In the desktop app this
is `lib/hud-api.js`'s WebSocket broadcast + collection; in a GSX flow
it would be an HTTP Gateway fan-out step.

```ts
interface Bid {
  agentId: string;
  confidence: number; // 0..1
  reasoning?: string;
  plan?: string;
  hallucinationRisk?: number;
  result?: string;
  criteria?: Array<{ id: string; score: number; comment?: string }>;
}

interface BidderPort {
  collect(
    task: Task,
    agents: Agent[],
    options?: { timeoutMs?: number }
  ): Promise<Bid[]>;
}
```

The `council-adapter` already in the package consumes `Bid[]` and
produces the consolidator-shape evaluations; it's port-agnostic.

### `executor`

Runs the winning agent's `execute()`. Wrapping this as a port lets
the HUD core stay out of the agent lifecycle -- the host decides
whether execution is local, RPC'd, sandboxed, etc.

```ts
interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  microUI?: object;
  // ... per-agent execution contract
}

interface ExecutorPort {
  execute(agent: Agent, task: Task): Promise<ExecutionResult>;
}
```

### `conversationHistory`

Shared history access. Different consumers will have different
backing stores (in-memory for CLI, Spaces for desktop, DB for WISER)
but the shape is the same.

```ts
interface HistoryTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  agentId?: string;
  timestamp?: number;
}

interface HistoryPort {
  add(role: string, content: string, meta?: object): void;
  recent(limit?: number): HistoryTurn[];
  clear(): void;
}
```

### `taskStore`

Minimal task state. Needed for:
- **Dedup:** the same utterance arriving twice within a short window
  (Realtime partial + final, or multi-source submission)
- **Pending-task routing:** a pending multi-turn context ("what city?")
  should route a plain noun back to the asker

```ts
interface Task {
  id: string;
  content: string;
  priority?: number;
  metadata?: object;
  spaceId?: string;
  criteria?: Array<{ id: string; name: string; weight?: number }>;
}

interface TaskStorePort {
  recent(limit?: number): Task[];
  markDuplicate(id: string): void;
  findPending(): Task | null;
  put(task: Task): void;
}
```

### `spaces`

Identical shape to the naturalness layer's Spaces port. See
`docs/naturalness/ports.md` for the shape. The HUD uses it for:
- Agent memory stores
- Task rubric cache
- Debug logs

### `log`, `now`, `settingsManager`, `ai`

Same shapes as the naturalness layer. See `docs/naturalness/ports.md`.
Reusing identical port contracts across both layers means a consumer
implements each adapter once and gets both layers for free.

## Shared ports with naturalness

The bold takeaway: **a consumer implementing the naturalness ports
already has 6 of the 10 HUD ports covered** (`spaces`, `log`, `now`,
`settingsManager`, `ai`, and partially `conversationHistory` via
`getHistory`). The remaining four (`agents`, `bidder`, `executor`,
`taskStore`) are HUD-specific.

## Consuming the package with zero ports

The currently-shipped Phase-1 extraction modules (`task-command-router`,
`voter-pool`, `council-adapter`, `identity-correction`) are pure --
no ports required. Consumers can use them today:

```js
const { isCriticalCommand, voterPool, councilAdapter, identityCorrection } =
  require('./lib/hud-core');

if (isCriticalCommand(userText)) { /* handle locally */ }
const eligible = voterPool.filterEligibleAgents(agents, task);
const evals    = councilAdapter.bidsToEvaluations(bids, { criteria: task.criteria });
```

## When to add a new port

Each extraction pass adds at most one new port. Before adding a port,
confirm:
1. The extracted module genuinely needs the capability (not just
   "might be convenient").
2. No existing port already covers it (reuse `spaces` for KV storage,
   `log` for all observability).
3. The port shape can be implemented by BOTH a local desktop adapter
   AND a server-side adapter without weird feature gating.

Ports that fail these checks should be pushed back onto the module
(make it more self-contained) rather than accepted.
