# GSX Mixed-Channel Node Catalog

A channel-agnostic runtime for multi-channel communication supporting voice, SMS, email, chat, push, and agent desktop.

## Architecture Overview

### Core Concepts

- **One session, many endpoints**: A single `SessionPacket` tracks all channels (voice, SMS, email, etc.)
- **Channel-agnostic nodes**: Logic nodes produce decisions; render/transport handle channel specifics
- **MemoryClipboard**: Portable verified facts + auth state that persist across channels
- **ChannelEnvelope**: Universal output wrapper for all node communications

### Key Rule: "Don't re-auth at L3, but step-up when needed"

The `MemoryClipboard` stores authentication state with TTL. If `auth_level >= required_level` AND not expired, authentication is skipped. Otherwise, `StepUpAuth` is triggered automatically.

## Directory Structure

```
gsx/
├── schemas/
│   ├── common/           # Shared types and schemas
│   │   ├── types.ts      # Core type definitions
│   │   ├── channel-envelope.ts
│   │   └── telemetry-event.ts
│   │
│   ├── session/          # Session state management
│   │   ├── session-packet.ts
│   │   └── memory-clipboard.ts
│   │
│   └── nodes/            # Node implementations
│       ├── base-node.ts  # Base class for all nodes
│       ├── plan-control/ # PlanRunner, Branch, RetryPolicy
│       ├── logic/        # Router, SlotCollector, ToolCall
│       ├── identity-security/
│       │   ├── verify-identity.ts
│       │   └── step-up-auth.ts
│       ├── routing/      # Channel switching nodes
│       ├── messaging/
│       │   └── send-message.ts  # The orchestrator
│       └── channel/
│           ├── render/   # Channel-specific rendering
│           └── transport/ # Delivery adapters
│
├── index.ts              # Main exports
└── README.md
```

## Core Schemas

### SessionPacket

Single source of truth for session continuity:

```typescript
interface SessionPacket {
  session_id: string;
  endpoints: EndpointRegistry;      // voice_call_id, sms_number, email, etc.
  channel_state: ChannelStateMap;   // connected, reachable, quiet_hours
  plan_state: PlanState;            // current_step, pending, completed
  event_subscriptions: EventSubscription[];
  memory: MemoryLayers;             // constitutional, contextual, active
  clipboard: MemoryClipboard;       // ✅ Portable auth + verified facts
  telemetry: TelemetryContext;
}
```

### MemoryClipboard

Portable verified facts that persist across channels:

```typescript
interface MemoryClipboard {
  auth: {
    auth_level: 0 | 1 | 2 | 3;
    method: AuthMethod;
    verified_at: string;
    expires_at: string;
    assurance_tags: AssuranceTag[];
  };
  customer_context: {
    is_customer: boolean;
    customer_id?: string;
    account_ids: string[];
    entitlements: string[];
    risk_flags: RiskFlag[];
  };
  consent: {
    recording_consent: ConsentStatus;
    sms_opt_in: ConsentStatus;
    // ...
  };
  verified_entities: {
    phone_number?: VerifiedEntity<string>;
    email?: VerifiedEntity<string>;
    // ...
  };
}
```

### ChannelEnvelope

Universal output wrapper:

```typescript
interface ChannelEnvelope {
  envelope_id: string;
  correlation_id: string;
  idempotency_key: string;
  channel: 'voice' | 'sms' | 'email' | 'chat' | 'push' | 'agent_desktop';
  audience: 'user' | 'agent' | 'supervisor';
  priority: 'now' | 'soon' | 'async';
  ttl_seconds: number;
  content: StructuredContent;
  render_hints: RenderHints;
  delivery_policy: DeliveryPolicy;
}
```

## Node Categories

### Plan Control (4 nodes)
- `PlanRunner` - Advances execution
- `Branch` - Conditional routing
- `RetryPolicy` - Backoff + escalation
- `CancelOrUndo` - Reverts changes

### Logic (10 nodes)
- `Router`, `SlotCollector`, `Validation`
- `ToolCall`, `PolicyCheck`, `RiskScoring`
- `CaseManagement`, `SummarizeOutcome`
- `RetrieveKnowledge`, `RepairInput`

### Identity & Security (4 nodes) ✅
- `VerifyIdentity` - Checks clipboard, validates auth
- `StepUpAuth` - Raises auth level
- `ConsentCapture` - Recording/SMS opt-in
- `AuthPolicyGate` - Quick gate for sensitive ops

### Routing (4 nodes)
- `OfferChannelSwitch`, `AutoChannelSwitch`
- `ResumeSession`, `SelectBestChannel`

### Messaging (5 nodes)
- `SendMessage` - The orchestrator ✅
- `AskQuestion`, `WaitForReply`
- `WaitForEvent`, `EscalateHiTL`

### Channel Render (5 nodes)
- `RenderVoice`, `RenderSMS`, `RenderEmail`
- `RenderPush`, `RenderAgentDesktop`

### Channel Transport (11 nodes)
- `DeliverSMS`, `DeliverEmail`, `DeliverVoice`
- `StartRecording`, `Transfer`, `Conference`
- `Queue`, `Hold`, `DTMFBridge`
- `VoicemailCapture`, `CallbackSchedule`

## Usage Example

```typescript
import {
  createSessionPacket,
  VerifyIdentityNode,
  StepUpAuthNode,
  SendMessageNode,
  meetsAuthRequirement
} from './gsx';

// Create a session
const session = createSessionPacket('session_123', {
  endpoints: { sms_number: '+1234567890' },
  primary_channel: 'sms'
});

// Check auth before sensitive action
const verifyNode = new VerifyIdentityNode();
const result = await verifyNode.execute({
  session,
  config: {
    node_id: 'verify_1',
    node_type: 'verify-identity',
    params: {
      required_level: 2,
      allow_cached: true,
      on_stepup_step: 'step_up'
    }
  }
});

if (result.context?.stepup_required) {
  // Trigger step-up auth
  const stepUpNode = new StepUpAuthNode();
  // ...
}
```

## Integration with Electron

This module is designed for Electron integration:

- **Main Process**: Run nodes, manage session state
- **Renderer Process**: Display envelopes, capture user input
- **IPC**: Use `SessionPacket` as the message format

```typescript
// In main.js
ipcMain.handle('gsx:execute-node', async (event, nodeType, input) => {
  const node = createNode(nodeType);
  return await node.execute(input);
});

// In renderer
const result = await window.gsx.executeNode('verify-identity', {
  session: currentSession,
  config: { ... }
});
```

## Layering Rules

1. **Logic nodes** produce structured decisions + drafts + state changes
2. **Render nodes** convert `StructuredContentDraft` → channel-specific `StructuredContent`
3. **Transport nodes** deliver only; they do not decide or format
4. **SendMessage** is the only node that applies delivery policy

## Telemetry

All nodes emit telemetry events:

```typescript
interface TelemetryEvent {
  event_type: 'node_start' | 'node_end' | 'auth_stepup' | ...;
  node_id: string;
  node_type: string;
  session_id: string;
  latency_ms?: number;
  auth_stepup_triggered?: boolean;
  policy_violation?: { ... };
  // ...
}
```

## Node Count

- Plan control: 4
- Logic: 10
- Identity/security: 4
- Routing: 4
- Messaging: 5
- Render: 5
- Transport: 11

**Total: ~43 nodes** (tight standard library for enterprise multi-channel runtime)


