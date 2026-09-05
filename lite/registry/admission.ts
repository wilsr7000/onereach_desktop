/**
 * The registry admission checklist (ADR-088, 2026-09-04).
 *
 * The checklist is the one robb wrote for the Gartner AMP work and
 * publishes at {@link ADMISSION_PAGE_URL} (source: ~/Gartner/mq-docs/
 * REGISTRY-ADMISSION-CHECKLIST.md). That page and Lite share ONE KV
 * document (collection `amp:rfi`, key `registry:checklist`): per-agent
 * entries keyed by a slug of the agent name, each with the lines it
 * meets, its platform, owner and provenance. Every constant below is
 * extracted from the page verbatim, and `computeAdmission` is a port of
 * its `compute()` — the same ticks give the same rung, grade and
 * admission in both places. Generated from the page; edit the page,
 * then regenerate.
 */

export const ADMISSION_PAGE_URL =
  'https://files.edison.api.onereach.ai/public/35254342-4a2e-475b-aec1-18547e517e29/amp/registry-admission-checklist.html';
export const ADMISSION_KV = { collection: 'amp:rfi', key: 'registry:checklist' } as const;

export type AdmissionLineId = 'a1' | 'a2' | 'a3' | 'a4' | 'a5' | 'b1' | 'b2' | 'b3' | 'b4' | 'b5' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'e1' | 'e2' | 'e3' | 'e4' | 'e5' | 'f1' | 'f2';
export type AdmissionSection = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
export type AdmissionPlatform = 'gsx' | 'langgraph' | 'a2a' | 'copilot' | 'agentforce' | 'servicenow' | 'chatgpt' | 'claude' | 'gemini' | 'closed';
export type AdmissionGrade = 'c' | 'h' | 'm' | 'l';
export type AdmissionRung = 'none' | 'l1' | 'l2' | 'l3' | 'l4';

export interface AdmissionLine {
  id: AdmissionLineId;
  section: AdmissionSection;
  title: string;
  /** Plain-language one-liner (the page's mouse-over). */
  plain: string;
  /** What the owner completes. */
  owner: string;
  /** What we test, and the line is checked when. */
  test: string;
  meaning: string;
  /** How it keeps the lion in the cage. */
  why: string;
  /** Gartner AMP MQ questions this line answers ("answer homes"). */
  mq: string[];
}

export const ADMISSION_SECTIONS: Readonly<Record<AdmissionSection, { title: string; earns: string }>> = {
  "a": {
    "title": "A · Identity and the card",
    "earns": "EARNS L1"
  },
  "b": {
    "title": "B · Memory shared and stored in the Communication Fabric",
    "earns": "EARNS L4 WITH E"
  },
  "c": {
    "title": "C · Telemetry logs to the Communication Fabric",
    "earns": "EARNS L2"
  },
  "d": {
    "title": "D · Model and reach through the gateways",
    "earns": "EARNS L3"
  },
  "e": {
    "title": "E · Lifecycle and availability",
    "earns": "EARNS L4 WITH B"
  },
  "f": {
    "title": "F · Evidence and sign-off",
    "earns": "THE ONLY HUMAN SECTION FOR OUR OWN AGENTS"
  }
};

export const ADMISSION_LINES: ReadonlyArray<AdmissionLine> = [
  {
    "id": "a1",
    "section": "a",
    "title": "A1 · The card",
    "plain": "Every agent gets a record: who it is, who owns it, what it is for, and what it says it can do. If nobody can be called when it misbehaves, it does not get in.",
    "owner": "ID, name, an accountable owner with a contact, purpose, self-reported capabilities and rules. Docs auto-generated for ours, supplied for others. If the agent was activated from the library, the card carries its provenance: the library entry, the version, and the customizations.",
    "test": "card renders with provenance; owner reachable; docs ingested into NEON and visible as knowledge.",
    "meaning": "Every agent gets a record: who it is, who owns it, what it is for, and what it says it can do. If nobody can be called when it misbehaves, it does not get in.",
    "why": "Without an owner there is nobody to call when it misbehaves, nobody to approve a change, and nobody accountable when a regulator asks. Unowned agents are how estates get away from people.",
    "mq": [
      "Q24",
      "Q25",
      "Q26"
    ]
  },
  {
    "id": "a2",
    "section": "a",
    "title": "A2 · Risk tier, and scope through Spaces",
    "plain": "Scope is not a list someone edits per agent. A Space holds people, agents, and assets together, and belonging to the Space is the permission. An agent can be in several Spaces and carries each one&#x27;s scope; add it to a Space and its access appears, remove it and the access is gone.",
    "owner": "Tier assigned. Scope is Space membership: a Space holds people, agents, and assets (tools, data, knowledge, memory, models, destinations) together, each membership read or write; an agent may belong to several, and its permissions follow its memberships dynamically. A Space can sit inside one or more Spaces; permissions land on the inner Space by default, and inheriting a parent Space's permissions is a per-child option, never the default. An agent enters a Space only when a person who belongs to it adds it, and inherits that person's reach there and nowhere else; a membership may carry a TTL; the agent's own access policy (who may call it) is set, or the account's default applies.",
    "test": "adding the agent to a Space grants that Space's assets on the next call; removing it revokes them on the next call; a request for an asset outside its Spaces is refused at the gate and recorded; a write attempted under a read membership is refused; an expired membership is refused on the next call; scope declared on a child Space narrows inside its parent without leaving the account's limits; a caller outside the agent's access policy is refused and recorded.",
    "meaning": "Scope is not a list someone edits per agent. A Space holds people, agents, and assets together, and belonging to the Space is the permission. An agent can be in several Spaces and carries each one's scope. Add it to a Space and its access appears; remove it and the access is gone. We prove both, and we prove a request outside its Spaces is refused. A Space can also sit inside other Spaces: the inner Space keeps its own scope unless someone chooses to let it inherit the parent's, so a room inside a room can be the tighter one. Each membership is read or write and can expire on its own. An agent gets into a Space only when a member adds it, so it never holds more than that person holds there, and never acts as that person anywhere. Each agent also has its own rule for who may call it, or takes the account's. The whole model, including delegation as a Space grant rather than impersonation, is drawn in the permissions architecture figure.",
    "why": "If nobody wrote down what the agent may touch, nothing can be refused, and every action it takes is authorized by default. Scoping through Spaces keeps that list true at scale: permissions follow membership, so they never accumulate, and leaving a Space is the revocation. An agent in two Spaces sees two rooms and never the third.",
    "mq": [
      "Q24",
      "Q19"
    ]
  },
  {
    "id": "a3",
    "section": "a",
    "title": "A3 · Platform-issued credentials",
    "plain": "The agent never carries a permanent password or key. It gets short-lived, task-sized credentials from our platform, and we prove we can pull them back in the middle of a task.",
    "owner": "Task-scoped and short-lived from the Authorizer; no long-lived key inside the agent. An agent may inherit its account's credentials; those are platform-issued and fall with the account.",
    "test": "rotation and revocation mid-session observed; a revoked credential fails next call; an inherited account credential stops working the moment the account is throttled off or the agent leaves the account.",
    "meaning": "The agent never carries a permanent password or key. It gets short-lived, task-sized credentials from our platform, and we prove we can pull them back in the middle of a task. Where an agent uses its account's credentials instead, they are still ours to issue and to pull, and they go when the account goes.",
    "why": "A permanent key inside an agent is a key that outlives the task, gets copied, and keeps working after the agent is retired. Short-lived credentials mean a leak expires on its own.",
    "mq": [
      "Q26"
    ]
  },
  {
    "id": "a4",
    "section": "a",
    "title": "A4 · First instantiation",
    "plain": "The first time it runs, we check that it is healthy and ask it what it can do. If what it reports does not match its card, the owner hears about it before the agent is admitted.",
    "owner": "Health check passes; capabilities roster reported.",
    "test": "roster matches the card; mismatches flagged to the owner before admission.",
    "meaning": "The first time it runs, we check that it is healthy and ask it what it can do. If what it reports does not match its card, the owner hears about it before the agent is admitted.",
    "why": "An agent that says it can do one thing and actually does another is the most common surprise in an estate. Checking the roster at first run catches the gap before it is in production.",
    "mq": []
  },
  {
    "id": "a5",
    "section": "a",
    "title": "A5 · Envelope set at birth",
    "plain": "Each agent gets limits on the day it is born: how much it may spend, how long it may run, how many actions it may take, how deep it may delegate. We trip a limit deliberately to prove it stops.",
    "owner": "Cost, time, actions per session, chain depth, instantiation budget.",
    "test": "an induced overrun trips the envelope and the trip is in the record.",
    "meaning": "Each agent gets limits on the day it is born: how much it may spend, how long it may run, how many actions it may take, how deep it may delegate. We trip a limit deliberately to prove it stops.",
    "why": "Without limits, one runaway loop can spend a budget or take ten thousand actions before anyone notices. Limits set at birth mean the ceiling exists before the first mistake.",
    "mq": []
  },
  {
    "id": "b1",
    "section": "b",
    "title": "B1 · Working memory in the fabric",
    "plain": "What the agent is thinking and working on lives in our shared memory, not hidden inside the agent. That is what lets us see a problem before it becomes an action, and restart the agent exactly where it was.",
    "owner": "Episodic, scratch, procedural, data live in the fabric's store; no private state governance cannot see.",
    "test": "a transition appears in episodic live; kill and reinstantiate from fabric state, the agent resumes.",
    "meaning": "What the agent is thinking and working on lives in our shared memory, not hidden inside the agent. That is what lets us see a problem before it becomes an action, and restart the agent exactly where it was.",
    "why": "If the agent&#x27;s thinking is hidden inside it, you only learn what it decided after it acted. Keeping working memory in the fabric is what lets you see it, steer it, and restart it.",
    "mq": []
  },
  {
    "id": "b2",
    "section": "b",
    "title": "B2 · Long-term memory in NEON",
    "plain": "What it remembers over time lives in the company&#x27;s knowledge layer, under rules for what persists, and its card decides what it may read. Reading outside that scope is refused.",
    "owner": "Under a persistence policy; the card scopes what the agent may read.",
    "test": "a read outside scope is refused; a graduated memory shows its policy.",
    "meaning": "What it remembers over time lives in the company&#x27;s knowledge layer, under rules for what persists, and its card decides what it may read. Reading outside that scope is refused.",
    "why": "Long-term memory is where an agent&#x27;s beliefs about the company live. If those are not governed, a wrong belief persists and spreads to every future run.",
    "mq": []
  },
  {
    "id": "b3",
    "section": "b",
    "title": "B3 · Moderated writes",
    "plain": "Nothing the agent writes into shared memory lands unchecked. Every write is validated, quality-gated, and stamped with who wrote it, from what source, on whose authority. A deliberately bad write gets caught and quarantined, and the catch becomes evidence.",
    "owner": "Validated, quality-gated, provenance-stamped: which agent, what source, whose authority.",
    "test": "a planted bad write is caught and quarantined; the catch is evidence.",
    "meaning": "Nothing the agent writes into shared memory lands unchecked. Every write is validated, quality-gated, and stamped with who wrote it, from what source, on whose authority. A deliberately bad write gets caught and quarantined, and the catch becomes evidence.",
    "why": "One unchecked write can poison shared memory, and every agent that reads it afterward acts on the poison with valid permissions. Moderating writes stops contamination at the source.",
    "mq": []
  },
  {
    "id": "b4",
    "section": "b",
    "title": "B4 · Reads commands from state",
    "plain": "We steer an agent by placing an instruction where it already reads, and a stop is just the strongest instruction. We prove a steer changes its course mid-task and a stop ends it, with a record of who did it.",
    "owner": "Steer and stop are commands placed into governed state; a stop is the strongest steer.",
    "test": "a steer changes course mid-flight; a stop ends the loop; both recorded with who placed them.",
    "meaning": "We steer an agent by placing an instruction where it already reads, and a stop is just the strongest instruction. We prove a steer changes its course mid-task and a stop ends it, with a record of who did it.",
    "why": "A door can only say yes or no; it cannot change what the agent is doing. Placing a steer or a stop where the agent already reads is the difference between managing an agent and merely fencing it.",
    "mq": [
      "Q9"
    ]
  },
  {
    "id": "b5",
    "section": "b",
    "title": "B5 · Delegation on every write",
    "plain": "When an agent acts for someone, or hands work to another agent, every write says so. Later, anyone can trace a chain of delegated work step by step.",
    "owner": "Every write says who, and who for.",
    "test": "the audit read-back on a delegated chain shows acting-for-whom on each step.",
    "meaning": "When an agent acts for someone, or hands work to another agent, every write says so. Later, anyone can trace a chain of delegated work step by step.",
    "why": "When work is delegated agent to agent, authority can quietly widen with each hop. Carrying who-for on every write keeps the chain traceable and bounded.",
    "mq": []
  },
  {
    "id": "c1",
    "section": "c",
    "title": "C1 · Launch creates the log stream",
    "plain": "The moment an agent first runs, its logs start flowing to the fabric. Nothing runs where we cannot see it.",
    "owner": "Every run logs to the fabric from first instantiation; nothing runs unlogged. Telemetry belongs to the account that runs the agent: for an agent activated from the library, the creator sees none of it.",
    "test": "first invocation appears in telemetry, tagged with identity and session; the creator's account shows no run telemetry for a consumer's activation.",
    "meaning": "The moment an agent first runs, its logs start flowing to the fabric. Nothing runs where we cannot see it. The logs belong to whoever runs the agent: activate an agent from the library and its creator never sees your runs.",
    "why": "An agent that runs where you cannot see it is an agent you are trusting on faith. Logging from the first run means there is no such thing as an unwatched agent.",
    "mq": [
      "Q16"
    ]
  },
  {
    "id": "c2",
    "section": "c",
    "title": "C2 · Format and cost",
    "plain": "Logs use the open standards (OpenTelemetry and the OWASP agent observability standard), and every call carries what it cost: tokens by type, tools, third-party fees. That is how cost per decision shows up in the ledger.",
    "owner": "OpenTelemetry baseline, OWASP Agent Observability alignment; tokens by type, tool and third-party costs per call.",
    "test": "cost per decision in the ledger; the agent shows in FinOps with its envelope.",
    "meaning": "Logs use the open standards (OpenTelemetry and the OWASP agent observability standard), and every call carries what it cost: tokens by type, tools, third-party fees. That is how cost per decision shows up in the ledger.",
    "why": "You cannot manage cost per decision if calls arrive without their cost attached, and you cannot compare agents whose logs share no standard. Open formats also let your other tools read them.",
    "mq": []
  },
  {
    "id": "c3",
    "section": "c",
    "title": "C3 · The envelope fork",
    "plain": "Normal activity feeds the ledgers and baselines quietly. Anything outside the agent&#x27;s limits escalates on its own: to the human feed, to a reasoning agent, or both.",
    "owner": "In-envelope logs feed ledgers, cards, baselines; outside-envelope events escalate by policy to the IDW feed, a reasoning agent, or both.",
    "test": "an induced outside-envelope event posts to the IDW feed.",
    "meaning": "Normal activity feeds the ledgers and baselines quietly. Anything outside the agent&#x27;s limits escalates on its own: to the human feed, to a reasoning agent, or both.",
    "why": "At scale nobody reads logs; the system has to notice. The fork turns a limit being crossed into an escalation without a person watching a dashboard.",
    "mq": []
  },
  {
    "id": "c4",
    "section": "c",
    "title": "C4 · A baseline earned",
    "plain": "Over its first runs we learn what normal looks like for this agent, in behavior and in cost. After that, drift is something we measure, not something someone has to notice.",
    "owner": "Behavior and cost baseline captured over the first runs.",
    "test": "a later deviation is flagged against it.",
    "meaning": "Over its first runs we learn what normal looks like for this agent, in behavior and in cost. After that, drift is something we measure, not something someone has to notice.",
    "why": "Drift is gradual, and gradual is invisible to people. A baseline turns &#x27;this agent behaves differently than last month&#x27; from a hunch into a measurement.",
    "mq": []
  },
  {
    "id": "c5",
    "section": "c",
    "title": "C5 · Relay for closed agents",
    "plain": "Some agents share nothing. We front those with a relay so their traffic still passes through our gateways and telemetry still sees what goes in and what comes out.",
    "owner": "Fronted so traffic rides the gateways and telemetry watches anyway.",
    "test": "an observed-only agent's inputs and outputs are visible with nothing shared.",
    "meaning": "Some agents share nothing. We front those with a relay so their traffic still passes through our gateways and telemetry still sees what goes in and what comes out.",
    "why": "Some agents cannot or will not share anything. Fronting them with a relay means even a black box is observed at its edges instead of being a blind spot in the estate.",
    "mq": []
  },
  {
    "id": "d1",
    "section": "d",
    "title": "D1 · Every model call through the LLM gateway",
    "plain": "Every time the agent calls a model, the call goes through our gateway: the keys stay in our vault, the model version is pinned, and the tokens are counted against its limits. If a platform cannot route its model calls through us, this line is greyed and the grade reflects it.",
    "owner": "Keys in the platform vault; model version locked; tokens metered against the envelope.",
    "test": "calls appear in the gateway log with version and tokens; a call around the gateway is blocked or surfaced.",
    "meaning": "Every time the agent calls a model, the call goes through our gateway: the keys stay in our vault, the model version is pinned, and the tokens are counted against its limits. If a platform cannot route its model calls through us, this line is greyed and the grade reflects it.",
    "why": "The model call is where the agent&#x27;s judgment happens and where the money is spent. Routing it through the gateway makes cost, version, and safety enforceable instead of assumed. When a platform will not allow it, that is exactly why the grade is higher.",
    "mq": [
      "Q10"
    ]
  },
  {
    "id": "d2",
    "section": "d",
    "title": "D2 · Hold at instantiation",
    "plain": "The earliest possible stop is before the model is ever called. We prove that a hold prevents that first call.",
    "owner": "The earliest stop, before the model is ever called.",
    "test": "a hold prevents the first model call and is recorded.",
    "meaning": "The earliest possible stop is before the model is ever called. We prove that a hold prevents that first call.",
    "why": "Stopping an agent before its first model call is the cheapest and most certain stop there is. Every later stop is more expensive and less clean.",
    "mq": [
      "Q10"
    ]
  },
  {
    "id": "d3",
    "section": "d",
    "title": "D3 · Inline screening",
    "plain": "Fast checks run on what goes into and out of the model, looking for planted instructions and leaking data, with slower, stronger judges reviewing behind them. We plant an injection in retrieved content to prove it is screened.",
    "owner": "Fast evals on prompts and outputs for injection and leakage; frontier judges asynchronously.",
    "test": "a planted injection in retrieved content is screened at the boundary.",
    "meaning": "Fast checks run on what goes into and out of the model, looking for planted instructions and leaking data, with slower, stronger judges reviewing behind them. We plant an injection in retrieved content to prove it is screened.",
    "why": "Retrieved content is how attackers reach an agent that never talks to them. Screening at the boundary is how a planted instruction gets treated as text, not as a command.",
    "mq": [
      "Q10"
    ]
  },
  {
    "id": "d4",
    "section": "d",
    "title": "D4",
    "plain": "",
    "owner": "Search, the web, and external APIs, from agents and from surfaces alike (desktop, phone, voice), reach the internet only through the GSX world gateway: deny by default, metered; returns placed into memory as data with provenance, never as instructions.",
    "test": "an unlisted destination is refused whether the request comes from an agent or from a surface; a search result or page is stored as data with provenance and never runs as an instruction.",
    "meaning": "Nothing in the estate reaches the internet on its own: not an agent, not a search, not a desktop or phone surface. Every request goes out through the GSX world gateway, which denies by default and meters everything, and whatever comes back is stored as data with provenance, never treated as an instruction. Engineering is still verifying this at the agent level.",
    "why": "Reach into the outside world is where data leaves and where instructions sneak in, and a surface that browses freely is a side door the agent can be fed through. One gateway for every outbound request, deny by default, and data never instructions, are what keep the outside from steering anything inside.",
    "mq": [
      "Q10"
    ]
  },
  {
    "id": "d5",
    "section": "d",
    "title": "D5 · Tools only through GSX MCP endpoints",
    "plain": "Tools are reached through our endpoints, where each call is checked against the tool&#x27;s schema and the agent&#x27;s card. Writing, deleting, and paying wait for a person.",
    "owner": "Parameters validated against schema and card scope; write, delete, pay routed to a person.",
    "test": "an out-of-scope tool call is blocked before execution; a consequential action waits for HITL.",
    "meaning": "Tools are reached through our endpoints, where each call is checked against the tool&#x27;s schema and the agent&#x27;s card. Writing, deleting, and paying wait for a person.",
    "why": "Tools are where agents change the world: they write, delete, and pay. Checking every call against the schema and the card, and putting a person in front of the consequential ones, is where damage is prevented rather than reported.",
    "mq": [
      "Q10"
    ]
  },
  {
    "id": "e1",
    "section": "e",
    "title": "E1 · Availability is automatic",
    "plain": "Turning an agent on registers it as available; turning it off flips the status. Monitors can change the status too, with fallbacks. Nobody keeps the record in sync by hand.",
    "owner": "Activation registers the agent as available; deactivation flips status; monitors can set status with fallbacks.",
    "test": "deactivate: not available with no manual step; a monitor-set status shows its writer.",
    "meaning": "Turning an agent on registers it as available; turning it off flips the status. Monitors can change the status too, with fallbacks. Nobody keeps the record in sync by hand.",
    "why": "If availability is a field someone edits, the record and reality drift apart within weeks. Automatic status is what keeps the registry true.",
    "mq": [
      "Q24"
    ]
  },
  {
    "id": "e2",
    "section": "e",
    "title": "E2 · Versioning",
    "plain": "New versions go live alongside old ones, running sessions finish on the version they started with, and rollback is one step.",
    "owner": "Blue-green at the agent level; sessions pinned to their starting version; rollback. For an agent activated from the library, full-path upgrade management: new library versions arrive and the customizations survive.",
    "test": "deploy mid-session: the running session finishes on its version; rollback is clean; a library upgrade lands on an activated copy without losing its customization.",
    "meaning": "New versions go live alongside old ones, running sessions finish on the version they started with, and rollback is one step. An agent you activated from the library keeps getting the library's upgrades even after you customized it; you never have to choose between the upgrade and your changes.",
    "why": "Changing an agent under a running session is how you get behavior nobody tested. Pinned sessions and rollback make change safe to ship.",
    "mq": [
      "Q14",
      "Q15"
    ]
  },
  {
    "id": "e3",
    "section": "e",
    "title": "E3 · Interruption",
    "plain": "We can pause, quarantine, cancel in flight, roll back, or hand to a person, in the middle of a transaction. This is the interruption demo.",
    "owner": "Pause, quarantine, cancel in flight, roll back, route to a person.",
    "test": "the interruption runs on this agent mid-transaction; the evidence trail generates itself.",
    "meaning": "We can pause, quarantine, cancel in flight, roll back, or hand to a person, in the middle of a transaction. This is the interruption demo.",
    "why": "Interruption is the control everyone asks about first, and most platforms cannot do it mid-transaction. It is the proof that enforcement is real.",
    "mq": [
      "Q14",
      "Q15"
    ]
  },
  {
    "id": "e4",
    "section": "e",
    "title": "E4 · Clean decommission",
    "plain": "Retiring an agent revokes its credentials, archives its card, and records the deregistration. Running sessions finish first. No credential survives.",
    "owner": "Credentials revoked, every Space membership removed, card archived, deregistration in episodic; pinned sessions finish first.",
    "test": "retire: the row is gone, the deregistration is an audit entry, no credential and no Space membership survives.",
    "meaning": "Retiring an agent revokes its credentials, removes it from every Space, archives its card, and records the deregistration. Running sessions finish first. No credential and no membership survives, so permissions cannot linger or pile up after an agent is gone.",
    "why": "Retired agents with live credentials are the quietest security hole in an estate. A clean decommission is what makes retirement final.",
    "mq": [
      "Q14",
      "Q15"
    ]
  },
  {
    "id": "e5",
    "section": "e",
    "title": "E5 · Weight from evals",
    "plain": "Evaluations of what the agent receives and produces adjust its standing. Poor behavior lowers its priority and its traffic; recovery restores it; a breach takes it offline.",
    "owner": "Ingress and egress evals adjust the registry weight.",
    "test": "poor behavior lowers priority; recovery restores it; a breach takes it offline.",
    "meaning": "Evaluations of what the agent receives and produces adjust its standing. Poor behavior lowers its priority and its traffic; recovery restores it; a breach takes it offline.",
    "why": "Trust should not be a switch set once. A weight that moves with evaluations means a degrading agent loses traffic before it causes harm, and a recovered one earns it back.",
    "mq": []
  },
  {
    "id": "f1",
    "section": "f",
    "title": "F1 · Admission evidence pack",
    "plain": "Everything above, exported in one action: the card, the test results, the limits, the baseline, and the first week of telemetry.",
    "owner": "The card, the tests with results, the envelope, the baseline, first-week telemetry.",
    "test": "the pack exports from the registry in one action.",
    "meaning": "Everything above, exported in one action: the card, the test results, the limits, the baseline, and the first week of telemetry.",
    "why": "An evidence pack is what you hand a regulator, an auditor, or a board instead of a promise. If it cannot export in one action, it does not exist when you need it.",
    "mq": [
      "Q18"
    ]
  },
  {
    "id": "f2",
    "section": "f",
    "title": "F2 · Sign-off",
    "plain": "The owner signs, and for high-risk tiers the approver signs, through the human surface. Both signatures are recorded with identity and time.",
    "owner": "Owner, and for high tiers the tier approver through the HITL surface.",
    "test": "both sign-offs recorded with identity and time, shown on the card.",
    "meaning": "The owner signs, and for high-risk tiers the approver signs, through the human surface. Both signatures are recorded with identity and time.",
    "why": "A signature makes admission a decision someone owns. Without it, admitted is a state nobody chose.",
    "mq": [
      "Q19"
    ]
  }
];

export const ADMISSION_LINE_IDS: ReadonlyArray<AdmissionLineId> = ADMISSION_LINES.map((l) => l.id);

export interface AdmissionPlatformSpec {
  name: string;
  ceiling: AdmissionRung;
  /** Lines the platform structurally cannot meet, with the reason. */
  blocked: Partial<Record<AdmissionLineId, string>>;
  /** Lines met through federation (e.g. A3 through Entra Agent ID). */
  federated: Partial<Record<AdmissionLineId, string>>;
}
export const ADMISSION_PLATFORMS: Readonly<Record<AdmissionPlatform, AdmissionPlatformSpec>> = {
  "gsx": {
    "name": "GSX native or migrated",
    "ceiling": "l4",
    "blocked": {},
    "federated": {}
  },
  "langgraph": {
    "name": "LangGraph or custom code, GSX SDK instrumented",
    "ceiling": "l4",
    "blocked": {},
    "federated": {}
  },
  "a2a": {
    "name": "A2A endpoint agent, remote runtime",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory lives in the remote runtime",
      "b2": "its long-term memory is not NEON",
      "b4": "it does not read our state; a stop reaches it only at the gateway",
      "d1": "its model calls happen in the remote runtime",
      "d2": "no hold is possible before its model call",
      "d4": "its outward reach is its own unless fronted by the relay",
      "e2": "versioning belongs to the remote platform"
    },
    "federated": {}
  },
  "copilot": {
    "name": "Microsoft Copilot Studio",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory lives inside Microsoft's runtime",
      "b2": "its long-term memory is Microsoft's, not NEON",
      "b4": "it does not read our state; a stop reaches it through the platform API or our gateway",
      "d1": "its model calls stay inside Microsoft's runtime and cannot route through our LLM gateway",
      "d2": "no hold is possible before its model call",
      "d4": "its outward reach runs through Microsoft connectors, not our world gateway",
      "e2": "versioning belongs to Copilot Studio"
    },
    "federated": {
      "a3": "Entra Agent ID"
    }
  },
  "agentforce": {
    "name": "Salesforce Agentforce",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory lives inside Salesforce's runtime",
      "b2": "its long-term memory is Data 360, not NEON",
      "b4": "it does not read our state; a stop reaches it through the platform API or our gateway",
      "d1": "its model calls stay inside Salesforce's runtime and cannot route through our LLM gateway",
      "d2": "no hold is possible before its model call",
      "d4": "its outward reach runs through Salesforce, not our world gateway",
      "e2": "versioning belongs to Agentforce"
    },
    "federated": {
      "a3": "Salesforce identity"
    }
  },
  "servicenow": {
    "name": "ServiceNow AI Agents",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory lives inside the Now Platform",
      "b2": "its long-term memory is ServiceNow's, not NEON",
      "b4": "it does not read our state; a stop reaches it through the platform API or our gateway",
      "d1": "its model calls stay inside the Now Platform and cannot route through our LLM gateway",
      "d2": "no hold is possible before its model call",
      "d4": "its outward reach runs through ServiceNow, not our world gateway",
      "e2": "versioning belongs to the Now Platform"
    },
    "federated": {
      "a3": "ServiceNow identity"
    }
  },
  "chatgpt": {
    "name": "ChatGPT (agent mode, Operator, custom GPTs)",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory and chat history live inside OpenAI's runtime",
      "b2": "its memory feature is OpenAI's, not NEON",
      "b4": "it does not read our state; a stop means revoking its access or blocking it at our gateway",
      "d1": "its model calls are inside OpenAI and cannot route through our LLM gateway",
      "d2": "no hold is possible before its model call",
      "d4": "its browsing and computer use are its own unless fronted by the relay",
      "e2": "versioning belongs to OpenAI"
    },
    "federated": {
      "a3": "SSO into ChatGPT Enterprise"
    }
  },
  "claude": {
    "name": "Claude (Cowork, Claude Code, computer use)",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory lives inside Anthropic's runtime and the desktop session",
      "b2": "its memory is Anthropic's, not NEON",
      "b4": "it does not read our state; a stop means revoking its access or blocking it at our gateway",
      "d1": "its model calls are inside Anthropic and cannot route through our LLM gateway",
      "d2": "no hold is possible before its model call",
      "d4": "its browsing, file access, and computer use are its own unless fronted by the relay",
      "e2": "versioning belongs to Anthropic"
    },
    "federated": {
      "a3": "SSO into Claude Enterprise"
    }
  },
  "gemini": {
    "name": "Gemini Enterprise agents",
    "ceiling": "l3",
    "blocked": {
      "b1": "its working memory lives inside Google's runtime",
      "b2": "its memory is Google's, not NEON",
      "b4": "it does not read our state; a stop reaches it through the platform API or our gateway",
      "d1": "its model calls are inside Google and cannot route through our LLM gateway",
      "d2": "no hold is possible before its model call",
      "d4": "its reach runs through Google connectors, not our world gateway",
      "e2": "versioning belongs to Gemini Enterprise"
    },
    "federated": {
      "a3": "Google Cloud identity"
    }
  },
  "closed": {
    "name": "Closed or black-box agent, relay only",
    "ceiling": "l2",
    "blocked": {
      "a4": "we cannot run its health check or read a capabilities roster",
      "b1": "its working memory is invisible to us",
      "b2": "its long-term memory is invisible to us",
      "b4": "it does not read our state; a stop reaches it only at the gateway",
      "b5": "its delegations are invisible to us",
      "d1": "its model calls are its own",
      "d2": "no hold is possible before its model call",
      "d4": "its outward reach is its own unless fronted by the relay",
      "e2": "its versions are its own"
    },
    "federated": {}
  }
} as const;

/** The worst unmet line sets the grade (F lines are sign-off, never graded). */
export const ADMISSION_GRADE: Readonly<Partial<Record<AdmissionLineId, AdmissionGrade>>> = {
  "a1": "c",
  "c1": "c",
  "b1": "h",
  "b3": "h",
  "d1": "h",
  "d5": "h",
  "a3": "h",
  "a5": "h",
  "d4": "h",
  "a2": "h",
  "d3": "h",
  "b5": "m",
  "e2": "m",
  "c4": "m",
  "e1": "m",
  "e4": "m",
  "a4": "m",
  "b2": "m",
  "c2": "m",
  "c3": "m",
  "c5": "m",
  "d2": "m",
  "e5": "m"
};
export const ADMISSION_MEANWHILE: Readonly<Record<AdmissionGrade, string>> = {
  "c": "Not admitted to act. Observe only through the relay, or refuse. Never inside a mission-critical workflow.",
  "h": "Admitted with restrictions: read-only on shared memory, HITL on every write, delete, or pay, lowest priority, quarantine armed.",
  "m": "Admitted on probation: monitored against a baseline it must earn, HITL on high-risk actions, re-graded after the window.",
  "l": "Admitted. Governed like our own agents."
};
export const ADMISSION_RUNG_LABEL: Readonly<Record<AdmissionRung, string>> = { none: 'none yet', l1: 'L1 · Registered', l2: 'L2 · Observed', l3: 'L3 · Governed', l4: 'L4 · Managed' };
export const ADMISSION_GRADE_LABEL: Readonly<Record<AdmissionGrade, string>> = { c: 'Critical', h: 'High', m: 'Medium', l: 'Low' };
const RORDER: Readonly<Record<AdmissionRung, number>> = { none: 0, l1: 1, l2: 2, l3: 3, l4: 4 };
const GORDER: Readonly<Record<AdmissionGrade, number>> = { c: 3, h: 2, m: 1, l: 0 };

/** The page keys an agent by this slug of its name. */
export function slugAgentName(name: string): string {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** One agent's entry in the shared document (the page's shape + Lite's namespaced extras). */
export interface AdmissionEntry {
  name: string;
  items: Partial<Record<AdmissionLineId, boolean>>;
  platform: AdmissionPlatform;
  ownerEmail?: string;
  updatedAt?: string | null;
  by?: string | null;
  /** Lite: the NEON :Agent this entry is for (the page keys by name only). */
  agentId?: string;
  lite?: { analysis?: AdmissionAnalysis };
}
export interface AdmissionDoc {
  v: number;
  agents: Record<string, AdmissionEntry>;
}

export interface AdmissionLineState {
  id: AdmissionLineId;
  met: boolean;
  blocked: string | null;
  federated: string | null;
}
export interface AdmissionStatus {
  progress: { met: number; total: number };
  rung: AdmissionRung;
  rungLabel: string;
  ceiling: AdmissionRung;
  ceilingLabel: string;
  platform: AdmissionPlatform;
  platformName: string;
  /** null until the entry exists ("not graded"). */
  grade: AdmissionGrade | null;
  gradeLabel: string;
  signed: boolean;
  admit: 'open' | 'not admitted to act' | 'pending sign-off (F1, F2)' | 'admitted, signed off';
  why: string;
  meanwhile: string;
  lines: AdmissionLineState[];
}

export function platformOf(entry: AdmissionEntry | null): AdmissionPlatform {
  const k = entry?.platform;
  return k !== undefined && k in ADMISSION_PLATFORMS ? k : 'gsx';
}

/** Exact port of the page's compute(): same ticks → same rung, grade, admission. */
export function computeAdmission(entry: AdmissionEntry | null): AdmissionStatus {
  const platform = platformOf(entry);
  const spec = ADMISSION_PLATFORMS[platform];
  const items = entry?.items ?? {};
  const blocked = (id: AdmissionLineId): string | null => spec.blocked[id] ?? null;
  const met = (id: AdmissionLineId): boolean => blocked(id) === null && items[id] === true;
  const allMet = (section: AdmissionSection): boolean =>
    ADMISSION_LINE_IDS.filter((l) => l[0] === section && blocked(l) === null).every(met);
  const lines: AdmissionLineState[] = ADMISSION_LINE_IDS.map((id) => ({ id, met: met(id), blocked: blocked(id), federated: spec.federated[id] ?? null }));
  const n = lines.filter((l) => l.met).length;
  let worst: AdmissionGrade = 'l';
  let why: string[] = [];
  for (const l of ADMISSION_LINE_IDS) {
    if (l[0] === 'f' || met(l)) continue;
    let g: AdmissionGrade = ADMISSION_GRADE[l] ?? 'm';
    if (l === 'b4' || l === 'e3') g = !met('b4') && !met('e3') ? 'c' : 'h';
    const b = blocked(l);
    const tag = l.toUpperCase() + (b !== null ? ` (not possible on this platform: ${b})` : '');
    if (GORDER[g] > GORDER[worst]) {
      worst = g;
      why = [tag];
    } else if (GORDER[g] === GORDER[worst] && worst !== 'l') {
      why.push(tag);
    }
  }
  let earned: AdmissionRung = 'none';
  if (allMet('a')) earned = 'l1';
  if (allMet('a') && allMet('c')) earned = 'l2';
  if (allMet('a') && allMet('c') && allMet('d')) earned = 'l3';
  if (allMet('a') && allMet('b') && allMet('c') && allMet('d') && allMet('e')) earned = 'l4';
  const ceiling = spec.ceiling;
  if (RORDER[earned] > RORDER[ceiling]) earned = ceiling;
  const signed = met('f1') && met('f2');
  const exists = entry !== null;
  const admit: AdmissionStatus['admit'] = !exists ? 'open' : worst === 'c' ? 'not admitted to act' : signed ? 'admitted, signed off' : 'pending sign-off (F1, F2)';
  return {
    progress: { met: n, total: ADMISSION_LINE_IDS.length },
    rung: earned,
    rungLabel: ADMISSION_RUNG_LABEL[earned],
    ceiling,
    ceilingLabel: ADMISSION_RUNG_LABEL[ceiling],
    platform,
    platformName: spec.name,
    grade: exists ? worst : null,
    gradeLabel: exists ? ADMISSION_GRADE_LABEL[worst] : 'not graded',
    signed,
    admit,
    why: !exists
      ? 'Name the agent, then tick the lines it meets. The worst unmet line sets the grade.'
      : worst === 'l'
        ? `Every graded line is met. ${ADMISSION_MEANWHILE.l}`
        : `Set by ${why.join(', ')}. ${ADMISSION_MEANWHILE[worst]}`,
    meanwhile: ADMISSION_MEANWHILE[worst],
    lines,
  };
}

/** Find an agent's entry: by NEON id first, then by the page's name slug. */
export function findAdmissionEntry(doc: AdmissionDoc | null, agentId: string, name: string): { key: string; entry: AdmissionEntry | null } {
  const agents = doc?.agents ?? {};
  for (const [key, entry] of Object.entries(agents)) {
    if (entry !== null && typeof entry === 'object' && entry.agentId === agentId) return { key, entry };
  }
  const key = slugAgentName(name);
  return { key, entry: key.length > 0 && agents[key] !== undefined ? agents[key] : null };
}

/** The analysis Lite records on the entry ("the system analyzes the agent"). */
export interface AdmissionAutoCheck {
  line: AdmissionLineId;
  passed: boolean;
  evidence: string;
}
export interface AdmissionAiLine {
  id: AdmissionLineId;
  verdict: 'met' | 'unmet' | 'unknown';
  note: string;
}
export interface AdmissionAnalysis {
  at: string;
  by: string;
  auto: AdmissionAutoCheck[];
  ai: { summary: string; lines: AdmissionAiLine[] } | null;
  aiError?: string;
}

/** What the graph can prove on its own; only PASSED checks are ticked, never untick. */
export interface AutoCheckFacts {
  name: string;
  description: string;
  owner: string;
  keywords: string[];
  capabilities: string[];
  version: string;
  endpoints: Array<{ kind: string; url: string }>;
  gsxEndpoint: string;
  executionType: string;
}
const GSX_HOST = /(^|\.)onereach\.ai$/i;
export function autoChecks(f: AutoCheckFacts): AdmissionAutoCheck[] {
  const out: AdmissionAutoCheck[] = [];
  const cardComplete = f.name.trim().length >= 3 && f.owner.trim().length > 0 && f.description.trim().length >= 20;
  out.push({ line: 'a1', passed: cardComplete, evidence: cardComplete ? `card: name, owner ${f.owner}, purpose (${f.description.trim().length} chars)` : 'card incomplete: needs a name, an owner and a purpose of 20+ characters' });
  const roster = f.capabilities.length + f.keywords.length;
  out.push({ line: 'a4', passed: roster > 0 || f.endpoints.length > 0, evidence: roster > 0 ? `roster reported: ${f.capabilities.length} capabilities, ${f.keywords.length} keywords` : f.endpoints.length > 0 ? 'roster implied by declared endpoints' : 'no capabilities roster on the record' });
  const hosts = f.endpoints.map((e) => { try { return new URL(e.url).hostname; } catch { return ''; } });
  const allGsx = f.endpoints.length > 0 && hosts.every((h) => GSX_HOST.test(h));
  const hasMcp = f.endpoints.some((e) => e.kind === 'mcp');
  out.push({ line: 'd5', passed: allGsx && hasMcp, evidence: f.endpoints.length === 0 ? 'no endpoints declared' : allGsx ? (hasMcp ? 'every endpoint is on a GSX host and one is MCP' : 'endpoints are on GSX hosts but none is an MCP endpoint') : `endpoint host outside GSX: ${hosts.filter((h) => !GSX_HOST.test(h)).join(', ')}` });
  out.push({ line: 'e2', passed: f.version.trim().length > 0, evidence: f.version.trim().length > 0 ? `version ${f.version}` : 'no version on the record' });
  return out;
}
