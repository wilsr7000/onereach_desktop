/**
 * Critical Meeting Rules Engine
 *
 * Decides whether a calendar event is "critical" (should fire an alarm) by
 * combining four composable rule sources. The sources are OR-merged: if any
 * source flags the event, it's critical. The merge collects reasons from all
 * matching sources and takes the union of lead times and channels.
 *
 * Sources, in priority order (all optional):
 *   1. Agent memory (.md file in Spaces)        -- PRIMARY, day-one editable UX.
 *      Sections: ## VIP Attendees, ## Keyword Triggers, ## Rules, ## Lead Times,
 *      ## Channels, ## Exclusions. Structured sections are parsed deterministically.
 *      The free-form ## Rules section is LLM-parsed once when the memory file
 *      changes and cached in RAM.
 *   2. Event tag                                -- per-event overrides. "[!]" or
 *      "[critical]" prefix, or "!critical" anywhere in title/description.
 *   3. Neon graph queue                         -- optional cross-device/app rules.
 *      Off until the user provides their Cypher template in Settings; stubbed
 *      here so the merge logic stays simple.
 *   4. LLM inference                            -- last-resort opt-in fallback.
 *      Off by default; toggled via the agent memory.
 *
 * Usage:
 *   const rules = require('./critical-meeting-rules');
 *   await rules.reloadFromMemory(agentMemory);     // call on init + on mtime change
 *   const verdict = await rules.evaluate(event, { now, userEmail });
 *   // -> { critical: bool, score: 0-1, reasons: [...], leadTimesMin: [15,5,1],
 *   //      channels: { hud, voice, os, sound }, exclusions: [] }
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ────────────────────────────────────────────────────────────────────────────
// Default policy
// Used when the memory file hasn't been seeded yet, or sections are empty.
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_LEAD_TIMES_MIN = [15, 5, 1];
const DEFAULT_CHANNELS_BY_LEAD = {
  15: { hud: true, voice: false, os: false, sound: false },
  5: { hud: true, voice: true, os: false, sound: false },
  1: { hud: true, voice: true, os: true, sound: true },
};

function _emptyChannels() {
  return { hud: false, voice: false, os: false, sound: false };
}

// ────────────────────────────────────────────────────────────────────────────
// DI hooks (test-only overrides)
// ────────────────────────────────────────────────────────────────────────────

let _injectedAiService = null;
let _injectedGraphClient = null;

function _resolveAi() {
  if (_injectedAiService) return _injectedAiService;
  try {
    return require('./ai-service');
  } catch (_) {
    return null;
  }
}

function _resolveGraphClient() {
  if (_injectedGraphClient) return _injectedGraphClient;
  try {
    const mod = require('../omnigraph-client');
    return typeof mod.getOmniGraphClient === 'function' ? mod.getOmniGraphClient() : null;
  } catch (_) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parsed rule set derived from the agent memory file.
// Refreshed by reloadFromMemory() when the file's mtime/version changes.
// ────────────────────────────────────────────────────────────────────────────

const SECTION_NAMES = {
  vipAttendees: 'VIP Attendees',
  keywords: 'Keyword Triggers',
  rules: 'Rules',
  leadTimes: 'Lead Times (minutes)',
  channels: 'Channels',
  exclusions: 'Exclusions',
  settings: 'Settings',
};

const RULES_SEED_TEMPLATES = {
  [SECTION_NAMES.vipAttendees]:
    'Any event that has one of these emails in the attendee list is critical.\n*None yet. Add one email per line prefixed with "- ".*',
  [SECTION_NAMES.keywords]:
    'Substrings in the event title or description that flag criticality.\n*None yet. Add one keyword per line prefixed with "- ".*',
  [SECTION_NAMES.rules]:
    "Free-form natural-language rules. I parse these with a small LLM call once when the file changes.\n*None yet. Example: 'Any event organized by Jennifer is always critical.'*",
  [SECTION_NAMES.leadTimes]: '- 15, 5, 1',
  [SECTION_NAMES.channels]:
    '- 15: hud\n- 5: hud, voice\n- 1: hud, voice, os, sound',
  [SECTION_NAMES.exclusions]:
    'Event titles that should never alarm, even if they match above.\n*None yet. One title per line prefixed with "- ".*',
  [SECTION_NAMES.settings]:
    '- llmFallback: false\n- graphQueue: false',
};

let _currentRuleSet = _buildEmptyRuleSet();
let _rulesSignature = null; // hash of the parsed sections so we can detect changes

function _buildEmptyRuleSet() {
  return {
    vipAttendees: new Set(),
    keywordTriggers: [],
    freeFormRules: [], // parsed by LLM into structured objects
    leadTimesMin: DEFAULT_LEAD_TIMES_MIN.slice(),
    channelsByLead: _cloneChannelsByLead(DEFAULT_CHANNELS_BY_LEAD),
    exclusions: new Set(),
    settings: { llmFallback: false, graphQueue: false },
  };
}

function _cloneChannelsByLead(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = { ...v };
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Seed / parse the memory file
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the agent memory file has all the rule sections. Writes only the
 * sections that are missing, so hand-added content is preserved.
 *
 * @param {AgentMemoryStore} memory
 * @returns {Promise<boolean>} true if any section was added
 */
async function seedMemorySections(memory) {
  if (!memory || !memory.isLoaded || !memory.isLoaded()) return false;
  const existing = new Set(memory.getSectionNames());
  let changed = false;
  for (const [name, seed] of Object.entries(RULES_SEED_TEMPLATES)) {
    if (!existing.has(name)) {
      memory.updateSection(name, seed);
      changed = true;
    }
  }
  if (changed && typeof memory.save === 'function') {
    try {
      await memory.save();
    } catch (err) {
      log.warn('agent', 'critical-meeting-rules: failed to save seeded sections', { error: err.message });
    }
  }
  return changed;
}

function _parseListSection(memory, section) {
  const raw = memory.getSection(section);
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('#'));
}

function _parseLeadTimes(memory) {
  const raw = memory.getSection(SECTION_NAMES.leadTimes) || '';
  const nums = [];
  for (const token of raw.match(/\d+/g) || []) {
    const n = parseInt(token, 10);
    if (Number.isFinite(n) && n > 0 && n <= 1440) nums.push(n);
  }
  // Dedup and sort descending (largest lead first, matching how humans read it)
  const out = Array.from(new Set(nums)).sort((a, b) => b - a);
  return out.length ? out : DEFAULT_LEAD_TIMES_MIN.slice();
}

function _parseChannels(memory) {
  const kv = memory.parseSectionAsKeyValue(SECTION_NAMES.channels) || {};
  const out = {};
  for (const [key, value] of Object.entries(kv)) {
    const minutes = parseInt(String(key).match(/\d+/)?.[0] || '', 10);
    if (!Number.isFinite(minutes)) continue;
    const flags = _emptyChannels();
    for (const tok of String(value).split(/[,\s]+/).map((t) => t.trim().toLowerCase())) {
      if (tok && tok in flags) flags[tok] = true;
    }
    out[String(minutes)] = flags;
  }
  return Object.keys(out).length ? out : _cloneChannelsByLead(DEFAULT_CHANNELS_BY_LEAD);
}

function _parseSettings(memory) {
  const kv = memory.parseSectionAsKeyValue(SECTION_NAMES.settings) || {};
  const out = { llmFallback: false, graphQueue: false };
  for (const [k, v] of Object.entries(kv)) {
    const key = String(k).trim();
    const val = String(v).trim().toLowerCase();
    if (key === 'llmFallback') out.llmFallback = val === 'true' || val === 'yes' || val === '1';
    if (key === 'graphQueue') out.graphQueue = val === 'true' || val === 'yes' || val === '1';
  }
  return out;
}

/**
 * Compute a cheap signature of the parsed-structured sections plus the raw
 * free-form rules text. If the signature matches the cached one, we skip the
 * (expensive) LLM re-parse of ## Rules.
 */
function _signatureOf({ memory, structured }) {
  const freeFormRaw = memory.getSection(SECTION_NAMES.rules) || '';
  const parts = [
    JSON.stringify(Array.from(structured.vipAttendees).sort()),
    JSON.stringify(structured.keywordTriggers.slice().sort()),
    JSON.stringify(Array.from(structured.exclusions).sort()),
    JSON.stringify(structured.leadTimesMin),
    JSON.stringify(structured.channelsByLead),
    JSON.stringify(structured.settings),
    freeFormRaw,
  ].join('||');
  // Djb2 hash -- no crypto needed, just change detection
  let hash = 5381;
  for (let i = 0; i < parts.length; i++) hash = ((hash << 5) + hash + parts.charCodeAt(i)) | 0;
  return `${hash}:${parts.length}`;
}

const FREE_FORM_RULES_SYSTEM_PROMPT = `You are parsing a user's free-form list of "critical meeting" rules into structured JSON.
Each rule the user wrote should become one item in the output. Return STRICT JSON:

{
  "rules": [
    {
      "description": "The user's original phrasing, verbatim or lightly paraphrased.",
      "matchKind":   "organizer_email" | "attendee_email" | "keyword" | "title_regex" | "attendee_count_gt" | "llm_check",
      "pattern":     "the thing to match (lowercase email, lowercase substring, regex, or integer)",
      "negate":      false,
      "leadTimesMin": [15, 5, 1] | null,
      "channels":    ["hud", "voice"] | null
    }
  ]
}

Guidelines:
  - "organizer_email"     -> pattern is a lowercase email (e.g. "jennifer@company.com")
  - "attendee_email"      -> pattern is a lowercase email
  - "keyword"             -> pattern is a lowercase substring matched against title + description
  - "title_regex"         -> pattern is a valid JavaScript regex string (no surrounding slashes)
  - "attendee_count_gt"   -> pattern is an integer (e.g. "20")
  - "llm_check"           -> fallback for rules that need semantic judgement at evaluation time
  - Set negate: true if the rule is exclusionary (e.g. "never alarm for X").
  - Set leadTimesMin / channels only when the rule overrides the defaults.
  - If a line is empty, a placeholder, or starts with "*", skip it.
  - If you can't cleanly parse a rule, use matchKind: "llm_check" and put the whole sentence in "pattern".`;

async function _parseFreeFormRulesWithLLM(rawText, options = {}) {
  const body = String(rawText || '').trim();
  if (!body || body.startsWith('*')) return [];

  // Fast pre-filter: split into lines and drop decorative ones so the LLM
  // doesn't waste tokens on the section preamble.
  const lines = body
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('*') && !l.startsWith('#'));
  if (!lines.length) return [];

  const ai = _resolveAi();
  if (!ai || typeof ai.json !== 'function') return [];

  const prompt =
    'Parse these free-form rules into structured JSON per the system prompt:\n\n' +
    lines.map((l, i) => `${i + 1}. ${l}`).join('\n');

  try {
    const parsed = await ai.json(prompt, {
      profile: options.profile || 'fast',
      system: FREE_FORM_RULES_SYSTEM_PROMPT,
      maxTokens: 900,
      temperature: 0.1,
      feature: 'critical-meeting-rules:parse',
    });
    if (!parsed || !Array.isArray(parsed.rules)) return [];
    return parsed.rules
      .map((r) => _normalizeFreeFormRule(r))
      .filter(Boolean);
  } catch (err) {
    log.warn('agent', 'critical-meeting-rules: LLM parse failed', { error: err.message });
    return [];
  }
}

function _normalizeFreeFormRule(r) {
  if (!r || typeof r !== 'object') return null;
  const validKinds = new Set([
    'organizer_email',
    'attendee_email',
    'keyword',
    'title_regex',
    'attendee_count_gt',
    'llm_check',
  ]);
  const matchKind = validKinds.has(r.matchKind) ? r.matchKind : 'llm_check';
  const pattern = String(r.pattern || '').trim();
  if (!pattern) return null;
  const leadTimesMin = Array.isArray(r.leadTimesMin)
    ? r.leadTimesMin.filter((n) => Number.isFinite(n) && n > 0 && n <= 1440)
    : null;
  const channels = Array.isArray(r.channels)
    ? r.channels.filter((c) => ['hud', 'voice', 'os', 'sound'].includes(String(c).toLowerCase()))
    : null;
  return {
    description: String(r.description || pattern).slice(0, 240),
    matchKind,
    pattern,
    negate: r.negate === true,
    leadTimesMin: leadTimesMin && leadTimesMin.length ? leadTimesMin : null,
    channels: channels && channels.length ? channels : null,
  };
}

/**
 * Parse the agent memory file into the module-level rule set. The free-form
 * ## Rules section is LLM-parsed only when its text has actually changed.
 *
 * @param {AgentMemoryStore} memory
 * @param {Object} [options]
 * @param {boolean} [options.forceReparse]
 * @returns {Promise<{ changed: boolean, ruleSet }>}
 */
async function reloadFromMemory(memory, options = {}) {
  if (!memory || !memory.isLoaded || !memory.isLoaded()) {
    return { changed: false, ruleSet: _currentRuleSet };
  }

  const structured = {
    vipAttendees: new Set(_parseListSection(memory, SECTION_NAMES.vipAttendees).map((e) => e.toLowerCase())),
    keywordTriggers: _parseListSection(memory, SECTION_NAMES.keywords).map((k) => k.toLowerCase()),
    freeFormRules: _currentRuleSet.freeFormRules, // carry over; may re-parse below
    leadTimesMin: _parseLeadTimes(memory),
    channelsByLead: _parseChannels(memory),
    exclusions: new Set(_parseListSection(memory, SECTION_NAMES.exclusions).map((t) => t.toLowerCase())),
    settings: _parseSettings(memory),
  };

  const newSig = _signatureOf({ memory, structured });
  const textUnchanged = newSig === _rulesSignature;
  if (textUnchanged && !options.forceReparse) {
    return { changed: false, ruleSet: _currentRuleSet };
  }

  // Only re-parse free-form rules when the ## Rules section text changed.
  const prevRulesRaw = _currentRuleSet._rulesRaw || '';
  const newRulesRaw = memory.getSection(SECTION_NAMES.rules) || '';
  if (options.forceReparse || newRulesRaw !== prevRulesRaw) {
    structured.freeFormRules = await _parseFreeFormRulesWithLLM(newRulesRaw);
  }
  structured._rulesRaw = newRulesRaw;

  _currentRuleSet = structured;
  _rulesSignature = newSig;
  log.info('agent', 'critical-meeting-rules: rule set reloaded', {
    vips: structured.vipAttendees.size,
    keywords: structured.keywordTriggers.length,
    rules: structured.freeFormRules.length,
    exclusions: structured.exclusions.size,
    leadTimes: structured.leadTimesMin,
  });
  return { changed: true, ruleSet: _currentRuleSet };
}

// ────────────────────────────────────────────────────────────────────────────
// Event helpers
// ────────────────────────────────────────────────────────────────────────────

function _eventText(event) {
  const title = String(event?.summary || event?.title || '');
  const desc = String(event?.description || '');
  return `${title}\n${desc}`.toLowerCase();
}

function _eventAttendees(event) {
  const list = Array.isArray(event?.attendees) ? event.attendees : [];
  return list
    .map((a) => (a?.email || '').toLowerCase())
    .filter(Boolean);
}

function _eventOrganizerEmail(event) {
  return String(event?.organizer?.email || event?.creator?.email || '').toLowerCase();
}

function _isExcluded(event, exclusions) {
  if (!exclusions || exclusions.size === 0) return false;
  const title = String(event?.summary || event?.title || '').toLowerCase().trim();
  for (const ex of exclusions) {
    if (!ex) continue;
    if (title === ex || title.includes(ex)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-evaluators
// Each returns { critical: bool, score, reasons[], leadTimesMin?, channels? }
// or null (no opinion).
// ────────────────────────────────────────────────────────────────────────────

function _evaluateEventTag(event) {
  const text = _eventText(event);
  const title = String(event?.summary || event?.title || '');
  const reasons = [];
  let score = 0;

  if (/^\s*\[!\]\s*/i.test(title) || /^\s*\[critical\]\s*/i.test(title)) {
    reasons.push('Title is tagged as critical ("[!]" or "[critical]").');
    score = Math.max(score, 0.95);
  }
  if (/!critical\b/i.test(text)) {
    reasons.push('Event contains the "!critical" marker.');
    score = Math.max(score, 0.9);
  }
  if (!reasons.length) return null;
  return { critical: true, score, reasons };
}

function _evaluateAgentMemory(event, ruleSet) {
  if (!ruleSet) return null;
  const text = _eventText(event);
  const attendees = _eventAttendees(event);
  const organizer = _eventOrganizerEmail(event);
  const reasons = [];
  let score = 0;
  const leadTimesAgg = new Set();
  const channelsAgg = _emptyChannels();
  let matched = false;
  let hadChannelOverride = false;

  // VIP attendees (exact email match)
  for (const vip of ruleSet.vipAttendees) {
    if (!vip) continue;
    if (attendees.includes(vip) || organizer === vip) {
      matched = true;
      reasons.push(`VIP attendee "${vip}" is on the invite.`);
      score = Math.max(score, 0.9);
    }
  }

  // Keyword triggers (substring match on title+description)
  for (const kw of ruleSet.keywordTriggers) {
    if (!kw) continue;
    if (text.includes(kw)) {
      matched = true;
      reasons.push(`Keyword trigger "${kw}" matched.`);
      score = Math.max(score, 0.75);
    }
  }

  // Free-form rules parsed by the LLM
  for (const rule of ruleSet.freeFormRules || []) {
    const hit = _freeFormRuleMatches(rule, { event, text, attendees, organizer });
    if (!hit) continue;
    if (rule.negate) {
      // Negated rule is treated as a strong exclusion signal. We don't set
      // critical=false here (the exclusion section is for that), but we do
      // record the negation reason so the caller can surface it.
      reasons.push(`Negated rule: ${rule.description}`);
      continue;
    }
    matched = true;
    reasons.push(`Rule: ${rule.description}`);
    score = Math.max(score, 0.8);
    if (Array.isArray(rule.leadTimesMin)) {
      for (const lt of rule.leadTimesMin) leadTimesAgg.add(lt);
    }
    if (Array.isArray(rule.channels)) {
      hadChannelOverride = true;
      for (const c of rule.channels) if (c in channelsAgg) channelsAgg[c] = true;
    }
  }

  if (!matched) return null;
  return {
    critical: true,
    score,
    reasons,
    leadTimesMin: leadTimesAgg.size ? Array.from(leadTimesAgg).sort((a, b) => b - a) : null,
    channels: hadChannelOverride ? channelsAgg : null,
  };
}

function _freeFormRuleMatches(rule, ctx) {
  const { text, attendees, organizer, event } = ctx;
  switch (rule.matchKind) {
    case 'organizer_email':
      return organizer === rule.pattern.toLowerCase();
    case 'attendee_email':
      return attendees.includes(rule.pattern.toLowerCase());
    case 'keyword':
      return text.includes(rule.pattern.toLowerCase());
    case 'title_regex':
      try {
        const re = new RegExp(rule.pattern, 'i');
        return re.test(String(event?.summary || event?.title || ''));
      } catch (_) {
        return false;
      }
    case 'attendee_count_gt': {
      const n = parseInt(rule.pattern, 10);
      return Number.isFinite(n) && Array.isArray(event?.attendees) && event.attendees.length > n;
    }
    case 'llm_check':
      // Evaluated at runtime by a separate pass if settings.llmFallback is on.
      // We signal "unresolved" so the merge can optionally run that pass.
      return false;
    default:
      return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Graph queue placeholder
// Off until the user wires in their Neon schema. See PUNCH-LIST for the
// default Cypher template. Left as a no-op so the merge stays simple.
// ────────────────────────────────────────────────────────────────────────────

async function _evaluateGraphQueue(_event, _ruleSet) {
  // TODO(user): wire up Cypher against Neon once the schema is shared.
  // Intentionally returning null so we don't block alarms on an unconfigured graph.
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Merge
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate all enabled sources against an event and merge the results.
 */
async function evaluate(event, context = {}) {
  if (!event) return _nonCritical();
  const ruleSet = context.ruleSet || _currentRuleSet;

  // Exclusions first -- they override everything.
  if (_isExcluded(event, ruleSet.exclusions)) {
    return {
      critical: false,
      score: 0,
      reasons: ['Event title matches an exclusion line.'],
      leadTimesMin: [],
      channels: _emptyChannels(),
      ruleSet,
    };
  }

  const results = [];
  const tag = _evaluateEventTag(event);
  if (tag) results.push(tag);

  const mem = _evaluateAgentMemory(event, ruleSet);
  if (mem) results.push(mem);

  if (ruleSet.settings?.graphQueue) {
    const graphClient = _resolveGraphClient();
    if (graphClient && typeof graphClient.isReady === 'function' && graphClient.isReady()) {
      const graph = await _evaluateGraphQueue(event, ruleSet);
      if (graph) results.push(graph);
    }
  }

  if (!results.length) {
    return {
      critical: false,
      score: 0,
      reasons: [],
      leadTimesMin: [],
      channels: _emptyChannels(),
      ruleSet,
    };
  }

  // Merge: OR the criticality, max the score, concat reasons, union lead
  // times, OR each channel flag. Per-rule overrides take precedence over the
  // ruleSet default when provided.
  const merged = {
    critical: true,
    score: 0,
    reasons: [],
    leadTimesMin: new Set(),
    channels: _emptyChannels(),
    overrodeChannels: false,
  };
  for (const r of results) {
    merged.score = Math.max(merged.score, r.score || 0);
    merged.reasons.push(...(r.reasons || []));
    if (Array.isArray(r.leadTimesMin) && r.leadTimesMin.length) {
      for (const lt of r.leadTimesMin) merged.leadTimesMin.add(lt);
    }
    if (r.channels && typeof r.channels === 'object') {
      merged.overrodeChannels = true;
      for (const [k, v] of Object.entries(r.channels)) if (v) merged.channels[k] = true;
    }
  }
  const leadTimesMin = merged.leadTimesMin.size
    ? Array.from(merged.leadTimesMin).sort((a, b) => b - a)
    : ruleSet.leadTimesMin.slice();

  // Channels fallback: when no rule overrode, use the per-lead-time map from
  // the memory file (or default).
  const channelsByLead = ruleSet.channelsByLead;
  const channelsForLead = (minutes) => {
    if (merged.overrodeChannels) {
      return { ...merged.channels };
    }
    return { ...(channelsByLead[String(minutes)] || DEFAULT_CHANNELS_BY_LEAD[minutes] || _emptyChannels()) };
  };

  return {
    critical: true,
    score: Math.min(1, merged.score),
    reasons: merged.reasons,
    leadTimesMin,
    channelsForLead, // function: (lead:number) -> { hud, voice, os, sound }
    channelsByLead,
    ruleSet,
  };
}

function _nonCritical() {
  return {
    critical: false,
    score: 0,
    reasons: [],
    leadTimesMin: [],
    channels: _emptyChannels(),
    channelsForLead: () => _emptyChannels(),
    channelsByLead: _cloneChannelsByLead(DEFAULT_CHANNELS_BY_LEAD),
    ruleSet: _currentRuleSet,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

module.exports = {
  SECTION_NAMES,
  RULES_SEED_TEMPLATES,
  DEFAULT_LEAD_TIMES_MIN,
  DEFAULT_CHANNELS_BY_LEAD,

  seedMemorySections,
  reloadFromMemory,
  evaluate,

  // Test-only hooks
  _setAiService: (svc) => {
    _injectedAiService = svc;
  },
  _setGraphClient: (client) => {
    _injectedGraphClient = client;
  },
  _resetInjections: () => {
    _injectedAiService = null;
    _injectedGraphClient = null;
  },
  _getRuleSet: () => _currentRuleSet,
  _setRuleSet: (rs) => {
    _currentRuleSet = rs;
  },
  _clearRuleSet: () => {
    _currentRuleSet = _buildEmptyRuleSet();
    _rulesSignature = null;
  },

  // Exposed for the agent + tests
  parseFreeFormRulesWithLLM: _parseFreeFormRulesWithLLM,
};
