const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['USER', 'ADMIN', 'SUPER_ADMIN']);
const VALID_MERGE_TYPES = new Set(['session', 'thread', 'shared', 'global']);
const VALID_SHAPES = new Set([
  'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up',
  'bubble-left', 'bubble-right',
  'circle', 'diamond', 'hexagon', 'octagon', 'pentagon',
  'plus', 'square', 'star', 'sun', 'triangle',
  'rectangle', 'empty',
]);
const VALID_ICON_TYPES = new Set(['default', 'custom']);
const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'verbose', 'debug', 'silly']);
const HTTP_GATEWAY_TPL_ID = 'd476f639-c460-4b35-a4f9-0ef94db22937';

const INFRA_CRITICAL_INPUTS = {
  'f08d2d37-8047-400e-aa94-e3f6e3435b1b': ['body'],
  'd042fa69-0da9-440b-90da-849d786ec514': ['key', 'collection'],
  '39c8bcee-82f4-453b-ac8d-c1677f9260e9': ['key', 'collection'],
  'd476f639-c460-4b35-a4f9-0ef94db22937': ['path', 'httpMethods'],
  'd476f639-38d0-42c2-8f5e-b6a5094e893c': ['path', 'httpMethods'],
};

function extractFormVariables(formBuilder) {
  const vars = [];
  function walk(items, parentListVar) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const isList = item?.component === 'formList';
      const listVar = isList ? item?.data?.variable : parentListVar;
      if (item?.data?.variable && item.component !== 'formDataOut') {
        vars.push({
          variable: item.data.variable,
          label: item.data.label || item.data.variable,
          component: item.component,
          required: !!item.data?.validateRequired,
          parentListVar: parentListVar || null,
        });
      }
      if (Array.isArray(item?.data?.inputs)) walk(item.data.inputs, listVar);
      if (Array.isArray(item?.data?.children)) walk(item.data.children, listVar);
    }
  }
  walk(formBuilder?.stepInputs || [], null);
  return vars;
}

const EMPTY_BACKTICK_RE = /^`\s*`$/;
function isEmptyValue(v) {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'string' && EMPTY_BACKTICK_RE.test(v)) return true;
  return false;
}

function extractWildcardSchemaBindings(formBuilder) {
  const bindings = [];
  const seen = new Set();
  function addBinding(field, validators) {
    if (seen.has(field)) return;
    seen.add(field);
    const hasValidator = typeof validators === 'string' && validators.includes(field);
    bindings.push({ field, hasValidator, component: 'formWildcard' });
  }
  function walk(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item?.component === 'formWildcard' && item?.data) {
        const tpl = item.data.formTemplate || '';
        const v = item.data.validators || '';
        const syncRe = /:([\w-]+)\.sync="schema\.(\w+)"/g;
        let m;
        while ((m = syncRe.exec(tpl)) !== null) addBinding(m[2], v);
        const vmodelRe = /v-model="schema\.(\w+)"/g;
        while ((m = vmodelRe.exec(tpl)) !== null) addBinding(m[1], v);
      }
      if (Array.isArray(item?.data?.inputs)) walk(item.data.inputs);
      if (Array.isArray(item?.data?.children)) walk(item.data.children);
    }
  }
  walk(formBuilder?.stepInputs || []);
  return bindings;
}

function diag(code, severity, path, message, fix, context) {
  const d = { code, severity, path, message, fix };
  if (context !== undefined) d.context = context;
  return d;
}

function isUUID(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

function isExitConditionMet(condition, stepData) {
  if (!condition || !stepData) return true;
  const s = condition.trim();

  const includesMatch = s.match(/^_\.includes\(schema\.(\w+),\s*'([^']+)'\)/);
  if (includesMatch) {
    const arr = stepData[includesMatch[1]];
    const val = includesMatch[2];
    const arrIncludes = Array.isArray(arr) && arr.includes(val);
    if (s.includes('&&')) {
      const rest = s.slice(s.indexOf('&&') + 2).trim();
      return arrIncludes && evaluateSimple(rest, stepData);
    }
    return arrIncludes;
  }

  return evaluateSimple(s, stepData);
}

function evaluateSimple(expr, stepData) {
  const e = expr.trim();
  const negated = e.startsWith('!');
  const key = negated ? e.slice(1).trim() : e;

  const schemaMatch = key.match(/^schema\.(\w+)$/);
  if (schemaMatch) {
    const val = !!stepData[schemaMatch[1]];
    return negated ? !val : val;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Pass 1 — Top-level structure
// ---------------------------------------------------------------------------
function passTopLevel(flow, out) {
  if (!flow || typeof flow !== 'object') {
    out.push(diag('INVALID_FLOW_OBJECT', 'error', '', 'Flow must be a non-null object', 'Pass a valid flow JSON object'));
    return false;
  }
  if (!flow.accountId) {
    out.push(diag('MISSING_ACCOUNT_ID', 'warning', 'accountId', 'accountId is missing', 'Set accountId to the owning account UUID'));
  }
  if (!flow.data || typeof flow.data !== 'object') {
    out.push(diag('MISSING_DATA', 'error', 'data', 'flow.data is missing or not an object', 'Add a data object containing trees, stepTemplates, meta, and deploy'));
    return false;
  }
  if (!flow.data.trees || typeof flow.data.trees !== 'object') {
    out.push(diag('MISSING_TREES', 'error', 'data.trees', 'data.trees is missing', 'Add data.trees with at least a main tree'));
    return false;
  }
  if (!flow.data.trees.main) {
    out.push(diag('MISSING_MAIN_TREE', 'error', 'data.trees.main', 'The main tree is missing', 'Add data.trees.main with at least one step'));
    return false;
  }
  if (!Array.isArray(flow.data.trees.main.steps) || flow.data.trees.main.steps.length === 0) {
    out.push(diag('EMPTY_MAIN_TREE', 'error', 'data.trees.main.steps', 'main tree has no steps', 'Add at least one step to data.trees.main.steps — steps[0] becomes the initialStepId'));
  }
  if (!Array.isArray(flow.data.stepTemplates)) {
    out.push(diag('MISSING_STEP_TEMPLATES', 'warning', 'data.stepTemplates', 'stepTemplates is missing or not an array', 'Add data.stepTemplates as an array of step template definitions'));
  }
  if (!flow.data.meta || typeof flow.data.meta !== 'object') {
    out.push(diag('MISSING_META', 'warning', 'data.meta', 'data.meta is missing', 'Add data.meta for global error handling and merge field declarations'));
  }
  if (!flow.data.deploy || typeof flow.data.deploy !== 'object') {
    out.push(diag('MISSING_DEPLOY', 'warning', 'data.deploy', 'data.deploy is missing', 'Add data.deploy with timeout, memory, and role'));
  }

  // Data Hub schema: schemaVersion must be integer >= 1
  if (flow.schemaVersion !== null && flow.schemaVersion !== undefined) {
    const sv = Number(flow.schemaVersion);
    if (!Number.isInteger(sv) || sv < 1) {
      out.push(diag('INVALID_SCHEMA_VERSION', 'warning', 'schemaVersion',
        `schemaVersion must be an integer >= 1, got ${flow.schemaVersion}`,
        'Set schemaVersion to a positive integer (e.g., 21)',
        { value: flow.schemaVersion }));
    }
  }

  // Data Hub schema: botId should be present
  if (!flow.botId) {
    out.push(diag('MISSING_BOT_ID', 'info', 'botId',
      'Flow has no botId — it may not be associated with a bot/space in Edison',
      'Set botId to the UUID of the parent bot'));
  }

  if (flow.data.color !== undefined && flow.data.color !== null && flow.data.color !== '') {
    if (typeof flow.data.color !== 'string' || !/^#[0-9A-Fa-f]{3,8}$/.test(flow.data.color)) {
      out.push(diag('FLOW_INVALID_COLOR', 'warning', 'data.color',
        `data.color "${flow.data.color}" is not a valid hex color`,
        'Set data.color to a hex color string (e.g., "#4A90D9")',
        { value: flow.data.color }));
    }
  }

  if (flow.data.annotations !== undefined && flow.data.annotations !== null) {
    if (!Array.isArray(flow.data.annotations)) {
      out.push(diag('FLOW_ANNOTATIONS_NOT_ARRAY', 'warning', 'data.annotations',
        'data.annotations must be an array of visual annotation objects',
        'Set data.annotations to an array (or remove it if unused)'));
    }
  }

  if (flow.data.isHidden !== undefined && flow.data.isHidden !== null && typeof flow.data.isHidden !== 'boolean') {
    out.push(diag('FLOW_ISHIDDEN_NOT_BOOLEAN', 'warning', 'data.isHidden',
      `data.isHidden must be a boolean, got ${typeof flow.data.isHidden}`,
      'Set data.isHidden to true or false'));
  }

  if (!flow.data.description || (typeof flow.data.description === 'string' && flow.data.description.trim() === '')) {
    out.push(diag('FLOW_MISSING_DESCRIPTION', 'warning', 'data.description',
      'Flow has no description — it will appear undocumented in the flow list and search results',
      'Add a 1-2 sentence description explaining what this flow does and when it should be used'));
  } else if (typeof flow.data.description === 'string') {
    const desc = flow.data.description.trim();
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    const label = (flow.data.label || '').trim().toLowerCase();

    if (wordCount < 5) {
      out.push(diag('FLOW_DESCRIPTION_TOO_SHORT', 'error', 'data.description',
        `Flow description is only ${wordCount} word(s) — descriptions under 5 words provide no useful context for discovery or understanding`,
        'Write a 1-2 sentence description explaining what the flow does, its trigger, and its purpose',
        { wordCount, description: desc }));
    } else if (wordCount < 10) {
      out.push(diag('FLOW_DESCRIPTION_TOO_SHORT', 'warning', 'data.description',
        `Flow description is only ${wordCount} words — consider expanding to at least 10 words for clarity`,
        'Add detail about what the flow does, how it is triggered, and what it produces',
        { wordCount, description: desc }));
    }

    if (label && desc.toLowerCase() === label) {
      out.push(diag('FLOW_DESCRIPTION_DUPLICATE_LABEL', 'error', 'data.description',
        'Flow description is identical to the flow label — the description should provide additional context beyond the name',
        'Rewrite the description to explain what the flow does, not just repeat its name',
        { description: desc, label }));
    }

    const PLACEHOLDER_RE = /^(test|todo|fixme|placeholder|untitled|new flow|description|my flow|sample|example|asdf|xxx)/i;
    if (PLACEHOLDER_RE.test(desc)) {
      out.push(diag('FLOW_DESCRIPTION_PLACEHOLDER', 'error', 'data.description',
        `Flow description "${desc.slice(0, 50)}" appears to be a placeholder — it will confuse users browsing the flow list`,
        'Replace with a real description explaining what this flow does and when to use it',
        { description: desc }));
    }

    const GENERIC_RE = /^(this flow does something|this is a flow|a flow that|flow for|does stuff)/i;
    if (GENERIC_RE.test(desc)) {
      out.push(diag('FLOW_DESCRIPTION_TOO_GENERIC', 'warning', 'data.description',
        `Flow description "${desc.slice(0, 60)}" is too generic — it doesn't explain what the flow actually does`,
        'Be specific: what does this flow receive, process, and produce?',
        { description: desc }));
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Pass 2 — Deploy configuration
// ---------------------------------------------------------------------------
function passDeploy(flow, out) {
  const deploy = flow.data.deploy;
  if (!deploy) return;

  if (deploy.timeout !== null && deploy.timeout !== undefined) {
    const t = Number(deploy.timeout);
    if (isNaN(t) || t < 10 || t > 900) {
      out.push(diag('DEPLOY_TIMEOUT_OUT_OF_RANGE', 'error', 'data.deploy.timeout',
        `timeout ${deploy.timeout} is outside allowed range 10–900`,
        'Set data.deploy.timeout to a number between 10 and 900',
        { value: deploy.timeout }));
    }
  }
  if (deploy.memory !== null && deploy.memory !== undefined) {
    const m = Number(deploy.memory);
    if (isNaN(m) || m < 128 || m > 10240) {
      out.push(diag('DEPLOY_MEMORY_OUT_OF_RANGE', 'error', 'data.deploy.memory',
        `memory ${deploy.memory} is outside allowed range 128–10240`,
        'Set data.deploy.memory to a number between 128 and 10240',
        { value: deploy.memory }));
    } else if (m % 64 !== 0) {
      out.push(diag('DEPLOY_MEMORY_NOT_ALIGNED', 'warning', 'data.deploy.memory',
        `memory ${deploy.memory} is not a multiple of 64 MB — Lambda requires 64 MB increments`,
        `Set data.deploy.memory to a multiple of 64 (e.g., ${Math.ceil(m / 64) * 64})`,
        { value: deploy.memory, suggested: Math.ceil(m / 64) * 64 }));
    }
  }
  if (deploy.role !== null && deploy.role !== undefined && !VALID_ROLES.has(deploy.role)) {
    out.push(diag('DEPLOY_INVALID_ROLE', 'error', 'data.deploy.role',
      `role "${deploy.role}" is not valid`,
      'Set data.deploy.role to one of: USER, ADMIN, SUPER_ADMIN',
      { value: deploy.role }));
  }
  if (Array.isArray(deploy.env)) {
    deploy.env.forEach((entry, i) => {
      if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        out.push(diag('DEPLOY_INVALID_ENV_ENTRY', 'warning', `data.deploy.env[${i}]`,
          'env entry must have string name and value',
          'Ensure each env entry is { "name": "...", "value": "..." }',
          { index: i, entry }));
      }
    });
  }

  // Data Hub: logsTTL must be >= 1
  if (deploy.logsTTL !== null && deploy.logsTTL !== undefined) {
    const ttl = Number(deploy.logsTTL);
    if (isNaN(ttl) || ttl < 1) {
      out.push(diag('DEPLOY_LOGTTL_INVALID', 'warning', 'data.deploy.logsTTL',
        `logsTTL ${deploy.logsTTL} must be >= 1 (days of CloudWatch log retention)`,
        'Set data.deploy.logsTTL to a positive integer (default: 60)',
        { value: deploy.logsTTL }));
    }
  }

  // Data Hub: logLevel validation
  if (deploy.logLevel !== null && deploy.logLevel !== undefined && deploy.logLevel !== '' && !VALID_LOG_LEVELS.has(deploy.logLevel)) {
    out.push(diag('DEPLOY_INVALID_LOGLEVEL', 'info', 'data.deploy.logLevel',
      `logLevel "${deploy.logLevel}" is not a recognized level`,
      'Set data.deploy.logLevel to one of: error, warn, info, verbose, debug, silly',
      { value: deploy.logLevel }));
  }
}

// ---------------------------------------------------------------------------
// Pass 3 — Step template integrity
// ---------------------------------------------------------------------------
function passTemplates(flow, out) {
  const templates = flow.data.stepTemplates;
  if (!Array.isArray(templates)) return new Map();

  const tplMap = new Map();
  const seenIds = new Set();

  templates.forEach((tpl, i) => {
    const base = `data.stepTemplates[${i}]`;

    if (!tpl || typeof tpl !== 'object') {
      out.push(diag('INVALID_TEMPLATE_OBJECT', 'error', base, 'Step template is not an object', 'Each entry in stepTemplates must be an object'));
      return;
    }
    if (!tpl.id) {
      out.push(diag('TEMPLATE_MISSING_ID', 'error', `${base}.id`, 'Step template is missing id', 'Add a unique UUID id'));
    } else {
      if (!isUUID(tpl.id)) {
        out.push(diag('TEMPLATE_INVALID_ID', 'error', `${base}.id`,
          `Template id "${tpl.id}" is not a valid UUID`,
          'Use a valid UUID v4 for the template id',
          { id: tpl.id }));
      }
      if (seenIds.has(tpl.id)) {
        out.push(diag('DUPLICATE_TEMPLATE_ID', 'error', `${base}.id`,
          `Duplicate template id "${tpl.id}"`,
          'Each step template must have a unique id',
          { id: tpl.id }));
      }
      seenIds.add(tpl.id);
      tplMap.set(tpl.id, tpl);
    }

    const isExternal = tpl.isExternal === true;

    ['label', 'version'].forEach(field => {
      if (typeof tpl[field] !== 'string' && !isExternal) {
        out.push(diag('TEMPLATE_MISSING_FIELD', 'error', `${base}.${field}`,
          `Step template missing required field "${field}"`,
          `Add a string "${field}" to the step template`,
          { templateId: tpl.id, field }));
      }
    });

    if (!isExternal && (typeof tpl.template !== 'string' || tpl.template.trim() === '')) {
      out.push(diag('TEMPLATE_MISSING_CODE', 'error', `${base}.template`,
        'Step template has no code (template field is empty or missing)',
        'Add JavaScript code in the template field',
        { templateId: tpl.id }));
    }

    if (!isExternal && (tpl.data === undefined || tpl.data === null || typeof tpl.data !== 'object')) {
      out.push(diag('TEMPLATE_MISSING_DATA', 'error', `${base}.data`,
        'Step template missing data object',
        'Add a data object with at least exits array',
        { templateId: tpl.id }));
    } else if (tpl.data && tpl.data.exits !== undefined && !Array.isArray(tpl.data.exits)) {
      out.push(diag('TEMPLATE_EXITS_NOT_ARRAY', 'error', `${base}.data.exits`,
        'Template data.exits must be an array',
        'Set data.exits to an array of exit definitions',
        { templateId: tpl.id }));
    }

    // Data Hub: iconType must be 'default' or 'custom'
    if (tpl.iconType !== null && tpl.iconType !== undefined && tpl.iconType !== '' && !VALID_ICON_TYPES.has(tpl.iconType)) {
      out.push(diag('TEMPLATE_INVALID_ICONTYPE', 'warning', `${base}.iconType`,
        `Template iconType "${tpl.iconType}" is not valid — must be "default" or "custom"`,
        'Set iconType to "default" or "custom"',
        { templateId: tpl.id, value: tpl.iconType }));
    }

    // Step Builder: custom iconType requires iconUrl
    if (tpl.iconType === 'custom' && !tpl.iconUrl) {
      out.push(diag('TEMPLATE_CUSTOM_ICON_NO_URL', 'warning', `${base}.iconUrl`,
        `Template "${tpl.label || tpl.id}" has iconType "custom" but no iconUrl`,
        'Set iconUrl to a URL or data URI pointing to the custom icon (PNG/SVG, max 128KB)',
        { templateId: tpl.id }));
    }

    if (tpl.iconUrl && typeof tpl.iconUrl === 'string' && tpl.iconUrl.trim() !== '') {
      const isHttpUrl = /^https?:\/\/.+/.test(tpl.iconUrl);
      const isDataUri = /^data:image\/(png|svg\+xml|jpeg|gif)[;,]/.test(tpl.iconUrl);
      if (!isHttpUrl && !isDataUri) {
        out.push(diag('TEMPLATE_INVALID_ICON_URL', 'warning', `${base}.iconUrl`,
          `Template iconUrl "${tpl.iconUrl.substring(0, 60)}${tpl.iconUrl.length > 60 ? '...' : ''}" is not a valid URL or data URI`,
          'Set iconUrl to an https:// URL or a data:image/svg+xml,... or data:image/svg+xml;base64,... URI',
          { templateId: tpl.id }));
      }
      if (tpl.iconType !== 'custom') {
        out.push(diag('TEMPLATE_ICONURL_IGNORED', 'warning', `${base}.iconUrl`,
          `Template "${tpl.label || tpl.id}" has iconUrl but iconType is "${tpl.iconType || 'default'}" — URL will be ignored`,
          'Set iconType to "custom" to use the custom icon URL',
          { templateId: tpl.id }));
      }
    }

    // Step Builder: gateway step forces shape arrow-down
    if (tpl.isGatewayStep === true && tpl.shape && tpl.shape !== 'arrow-down') {
      out.push(diag('TEMPLATE_GATEWAY_WRONG_SHAPE', 'warning', `${base}.shape`,
        `Gateway template "${tpl.label || tpl.id}" has shape "${tpl.shape}" — gateway steps should use "arrow-down"`,
        'Set shape to "arrow-down" (the Step Builder enforces this for gateway steps)',
        { templateId: tpl.id, shape: tpl.shape }));
    }

    // Step Builder: shape should be one of the known shapes
    if (tpl.shape && !VALID_SHAPES.has(tpl.shape)) {
      out.push(diag('TEMPLATE_INVALID_SHAPE', 'warning', `${base}.shape`,
        `Template shape "${tpl.shape}" is not a recognized shape`,
        'Valid shapes: ' + [...VALID_SHAPES].join(', '),
        { templateId: tpl.id, shape: tpl.shape }));
    }

    // Data Hub: formBuilder is required for UI rendering
    if (!isExternal && !tpl.formBuilder) {
      out.push(diag('TEMPLATE_MISSING_FORMBUILDER', 'info', `${base}.formBuilder`,
        `Step template "${tpl.label || tpl.id}" has no formBuilder — the Edison UI may not render step configuration properly`,
        'Add a formBuilder object with stepInputs array',
        { templateId: tpl.id }));
    } else if (!isExternal && tpl.formBuilder &&
               (!Array.isArray(tpl.formBuilder.stepInputs) || tpl.formBuilder.stepInputs.length === 0)) {
      out.push(diag('TEMPLATE_EMPTY_FORMBUILDER', 'warning', `${base}.formBuilder.stepInputs`,
        `Step template "${tpl.label || tpl.id}" has a formBuilder but no input components — the step UI will be blank`,
        'Add at least one input to formBuilder.stepInputs, or verify this step intentionally has no user-configurable fields',
        { templateId: tpl.id }));
    }

    // formBuilder.stepExits structural checks (missing ids cause blank canvas)
    if (!isExternal && tpl.formBuilder && Array.isArray(tpl.formBuilder.stepExits)) {
      for (let ei = 0; ei < tpl.formBuilder.stepExits.length; ei++) {
        const exit = tpl.formBuilder.stepExits[ei];
        if (!exit.component) {
          out.push(diag('FORM_EXIT_MISSING_COMPONENT', 'error', `${base}.formBuilder.stepExits[${ei}]`,
            `Step template "${tpl.label || tpl.id}" stepExit "${exit.data?.id || ei}" is missing the component field — Edison UI will crash (J.split is not a function)`,
            'Set component to "exitStatic" (fixed exit) or "exitDynamic" (user-configurable)',
            { templateId: tpl.id, index: ei, exitDataId: exit.data?.id }));
        }
        if (!exit.id) {
          out.push(diag('TEMPLATE_STEPEXIT_MISSING_ID', 'error', `${base}.formBuilder.stepExits[${ei}]`,
            `Step template "${tpl.label || tpl.id}" stepExit "${exit.data?.id || ei}" is missing a UUID id — this causes the canvas to render blank`,
            'Add a UUID id field to the stepExit entry (e.g., crypto.randomUUID())',
            { templateId: tpl.id, index: ei, exitDataId: exit.data?.id }));
        }
        if (!exit.data?.id) {
          out.push(diag('TEMPLATE_STEPEXIT_MISSING_DATA_ID', 'error', `${base}.formBuilder.stepExits[${ei}].data`,
            `Step template "${tpl.label || tpl.id}" stepExit[${ei}] is missing data.id — Edison cannot match exits to wiring`,
            'Set data.id to the exit identifier (e.g., "next", "__error__")',
            { templateId: tpl.id, index: ei }));
        }
        const isDynamic = /^dynamic/i.test(exit.data?.id || '') || exit.component === 'exitDynamic';
        if (exit.data && exit.data.condition === undefined && !isDynamic) {
          out.push(diag('TEMPLATE_STEPEXIT_MISSING_CONDITION', 'warning', `${base}.formBuilder.stepExits[${ei}].data`,
            `Step template "${tpl.label || tpl.id}" stepExit "${exit.data?.id || ei}" has no condition field — may cause rendering issues`,
            'Set data.condition to "" for normal exits or "processError" for error exits',
            { templateId: tpl.id, index: ei, exitDataId: exit.data?.id }));
        }
      }
    }

    // formBuilder.hasProcessError should have a matching __error__ stepExit
    // When a global error handler exists, individual __error__ exits are optional
    // (the global handler catches all unhandled errors), so downgrade to info.
    if (!isExternal && tpl.formBuilder?.hasProcessError === true && Array.isArray(tpl.formBuilder.stepExits)) {
      const hasErrorExit = tpl.formBuilder.stepExits.some(e => e.data?.id === '__error__' || e.data?.condition === 'processError');
      const hasGlobalHandler = !!(flow.data?.meta?.globalProcessError && flow.data?.meta?.globalProcessErrorStepId);
      if (!hasErrorExit) {
        const severity = hasGlobalHandler ? 'info' : 'warning';
        out.push(diag('TEMPLATE_MISSING_ERROR_STEPEXIT', severity, `${base}.formBuilder.stepExits`,
          hasGlobalHandler
            ? `Step template "${tpl.label || tpl.id}" has hasProcessError: true but no __error__ stepExit — local error handling is optional because a global error handler is configured`
            : `Step template "${tpl.label || tpl.id}" has hasProcessError: true but no __error__ stepExit in formBuilder — without a global error handler, consider adding one`,
          'Add a stepExit with data: { id: "__error__", label: "on error", condition: "processError" } for local error handling',
          { templateId: tpl.id }));
      }
    }

    const BUILTIN_TPL = /gateway|http\s*re(quest|sponse)|send.*response|wait.*request|handle.*error|flow\s*error|random\s*code|key\s*value|storage|date\/?time|change.*format.*date|get.*date/i;
    const isBuiltin = tpl.isGatewayStep || BUILTIN_TPL.test(tpl.label || '');
    if (!isExternal && !isBuiltin && tpl.formBuilder && !tpl.formBuilder.formTemplate) {
      out.push(diag('TEMPLATE_MISSING_FORMTEMPLATE', 'warning', `${base}.formBuilder.formTemplate`,
        `Step template "${tpl.label || tpl.id}" has no formTemplate — the step configuration panel may not render inputs correctly`,
        'Add the standard formTemplate: "<' + '%=' + ' inputs ? inputs.join(\'\\n\') : \'\' %' + '>"',
        { templateId: tpl.id }));
    }

    if (!isExternal && Array.isArray(tpl.formBuilder?.stepInputs)) {
      for (let si = 0; si < tpl.formBuilder.stepInputs.length; si++) {
        const inp = tpl.formBuilder.stepInputs[si];
        if (!inp?.component || !inp.data) continue;
        const varName = inp.data.variable || '';

        const MERGE_FIELD_COMPONENTS = new Set(['formTextInput', 'formCode', 'formTextBox']);
        if (MERGE_FIELD_COMPONENTS.has(inp.component) && !inp.data.allowMergeFields) {
          out.push(diag('TEMPLATE_INPUT_NO_MERGE_FIELDS', 'error',
            `${base}.formBuilder.stepInputs[${si}]`,
            `Template "${tpl.label || tpl.id}" input "${varName || inp.data.label || ''}" (${inp.component}) does not have allowMergeFields: true — users cannot pick merge fields from the UI, making the step unusable in other flows`,
            'Set allowMergeFields: true on the input so users can select data from preceding steps',
            { templateId: tpl.id, index: si, variable: varName }));
        }

        if (inp.component === 'formTextExpression') {
          out.push(diag('TEMPLATE_INPUT_EXPRESSION_TYPE', 'info',
            `${base}.formBuilder.stepInputs[${si}]`,
            `Template "${tpl.label || tpl.id}" input "${varName}" uses formTextExpression — consider formTextInput with allowMergeFields: true for a better UI experience`,
            'formTextInput with allowMergeFields provides a visual merge field picker; formTextExpression requires users to write JS expressions',
            { templateId: tpl.id, index: si, variable: varName }));
        }

        const nonLabelComponents = ['formWildcard', 'formDataOut', 'formCollapsible', 'formAlert', 'formSection', 'formGroup', 'formDivider', 'formHtml', 'auth-external-component'];
        const compName = Array.isArray(inp.component) ? inp.component[0] : inp.component;
        if (!inp.data.label && !inp.data.header && !inp.data.collapsibleTitle && !nonLabelComponents.includes(compName)) {
          out.push(diag('TEMPLATE_INPUT_MISSING_LABEL', 'warning',
            `${base}.formBuilder.stepInputs[${si}]`,
            `Template "${tpl.label || tpl.id}" input "${varName || '(unnamed)'}" has no label — field will be blank in the step UI`,
            'Set data.label to a descriptive name',
            { templateId: tpl.id, index: si, variable: varName }));
        }

        if (varName && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName)) {
          out.push(diag('TEMPLATE_INPUT_INVALID_VARIABLE', 'warning',
            `${base}.formBuilder.stepInputs[${si}]`,
            `Template "${tpl.label || tpl.id}" input variable "${varName}" is not a valid JS identifier — the compiler cannot destructure it as a templateLogic() parameter`,
            'Use a valid identifier (letters, digits, _, $; not starting with a digit)',
            { templateId: tpl.id, index: si, variable: varName }));
        }
      }
    }

    if (Array.isArray(tpl.modules)) {
      tpl.modules.forEach((mod, mi) => {
        if (!mod || typeof mod.name !== 'string') {
          out.push(diag('TEMPLATE_INVALID_MODULE', 'warning', `${base}.modules[${mi}]`,
            'Module entry missing name',
            'Each module must have { "name": "package-name", "version": "^x.y.z" }',
            { templateId: tpl.id, index: mi }));
        }
      });
    }

    if (tpl.isExternal === true && !tpl.baseUrl) {
      out.push(diag('EXTERNAL_TEMPLATE_MISSING_BASEURL', 'error', `${base}.baseUrl`,
        'External template is missing baseUrl',
        'Set baseUrl to the URL prefix for fetching logic.js, meta.json, etc.',
        { templateId: tpl.id }));
    }

    if (!isExternal && (!tpl.description || (typeof tpl.description === 'string' && tpl.description.trim() === ''))) {
      out.push(diag('TEMPLATE_NO_DESCRIPTION', 'warning', `${base}.description`,
        `Step template "${tpl.label || tpl.id}" has no description — the step picker tooltip and search results will be empty`,
        'Add a 1-2 sentence description of what the step does',
        { templateId: tpl.id }));
    }

    // DataHub requires form object on step templates
    if (!isExternal && !tpl.form) {
      out.push(diag('TEMPLATE_MISSING_FORM', 'warning', `${base}.form`,
        `Step template "${tpl.label || tpl.id}" has no form object — DataHub schema validation requires this field`,
        'Add a form object: { template: "", code: "", component: "", style: "" }',
        { templateId: tpl.id }));
    }

    // Template ID must be lowercase UUID (DataHub pattern enforces lowercase hex)
    if (tpl.id && tpl.id !== tpl.id.toLowerCase()) {
      out.push(diag('TEMPLATE_ID_NOT_LOWERCASE', 'error', `${base}.id`,
        `Step template "${tpl.label || tpl.id}" has uppercase characters in its UUID — DataHub requires lowercase hex`,
        'Use a lowercase UUID (e.g., crypto.randomUUID() produces lowercase by default)',
        { templateId: tpl.id }));
    }

    if (!isExternal && tpl.formBuilder?.hasDataOut === true) {
      if (!tpl.outputExample || (typeof tpl.outputExample === 'object' && Object.keys(tpl.outputExample).length === 0)) {
        out.push(diag('TEMPLATE_OUTPUT_EXAMPLE_MISSING', 'warning', `${base}.outputExample`,
          `Step template "${tpl.label || tpl.id}" produces output (hasDataOut: true) but has no outputExample — merge field autocomplete won't work for downstream steps`,
          'Add outputExample with all possible output fields and sample values (e.g., { "id": "abc", "status": "success" })',
          { templateId: tpl.id }));
      }
    }

    if (!isExternal && (!tpl.help || (typeof tpl.help === 'string' && tpl.help.trim() === ''))) {
      out.push(diag('TEMPLATE_NO_HELP', 'info', `${base}.help`,
        `Step template "${tpl.label || tpl.id}" has no help text — the info panel will be empty when builders click the help button`,
        'Add help text documenting inputs, outputs, and error handling',
        { templateId: tpl.id }));
    }

    if (tpl.hooks && typeof tpl.hooks === 'object') {
      const VALID_HOOKS = new Set([
        'before-save-flow', 'after-save-flow',
        'before-activate-flow', 'after-activate-flow',
        'flow-deactivated', 'flow-deleted',
        'step-added-to-canvas', 'step-removed-from-canvas',
        'step-split-from-tree',
      ]);
      for (const hookName of Object.keys(tpl.hooks)) {
        if (!VALID_HOOKS.has(hookName)) {
          out.push(diag('TEMPLATE_UNKNOWN_HOOK', 'warning', `${base}.hooks.${hookName}`,
            `Template "${tpl.label || tpl.id}" declares unknown hook "${hookName}"`,
            `Valid hooks: ${[...VALID_HOOKS].join(', ')}`,
            { templateId: tpl.id, hook: hookName }));
        }
      }
    }

    if (!isExternal && tpl.form && typeof tpl.form === 'object') {
      for (const field of ['code', 'template', 'style']) {
        const val = tpl.form[field];
        if (val !== undefined && typeof val !== 'string') {
          out.push(diag('TEMPLATE_FORM_INVALID_FIELD', 'warning', `${base}.form.${field}`,
            `Template "${tpl.label || tpl.id}" form.${field} must be a string`,
            `Set form.${field} to a valid ${field === 'code' ? 'JavaScript' : field === 'template' ? 'HTML template' : 'CSS'} string`,
            { templateId: tpl.id }));
        }
        if (val === '') {
          out.push(diag('TEMPLATE_FORM_EMPTY_FIELD', 'error', `${base}.form.${field}`,
            `Template "${tpl.label || tpl.id}" form.${field} is an empty string — the Edison SDK validator compiler will crash with "Cannot read properties of undefined (reading 'bind')" when trying to compile an empty string. The property must either contain valid content or be absent (undefined).`,
            `Delete the form.${field} property entirely (do NOT set to empty string): delete tpl.form.${field}`,
            { templateId: tpl.id, field }));
        }
      }
    }
  });

  // Duplicate template labels — multiple templates with the same name clutter
  // the step picker and confuse authors. Each clone from cloneTemplate() inherits
  // the original label; they should be renamed or consolidated.
  {
    const byLabel = {};
    const byBase = {};
    for (const tpl of (flow.data.stepTemplates || [])) {
      if (!tpl?.label) continue;
      if (!byLabel[tpl.label]) byLabel[tpl.label] = [];
      byLabel[tpl.label].push(tpl);
      const base = tpl.label.replace(/\s*\[.*\]\s*$/, '').trim();
      if (!byBase[base]) byBase[base] = [];
      byBase[base].push(tpl);
    }
    const allSteps = [];
    for (const tree of Object.values(flow.data.trees || {})) {
      if (tree?.steps) allSteps.push(...tree.steps);
    }
    for (const [label, tpls] of Object.entries(byLabel)) {
      if (tpls.length <= 1) continue;
      const details = tpls.map(t => {
        const inst = allSteps.find(s => s?.type === t.id);
        return inst ? `"${inst.label || '(unnamed)'}"` : `(orphan ${t.id.slice(0, 8)})`;
      });
      out.push(diag('DUPLICATE_TEMPLATE_LABEL', 'warning',
        'data.stepTemplates',
        `${tpls.length} templates share the label "${label}": used by ${details.join(', ')} — ` +
        `the step picker will show ${tpls.length} identical entries, and authors can't tell them apart`,
        'Rename cloned templates to include the step instance name (e.g., "Set Value to a Storage (Error: Generate Code)"), ' +
        'or consolidate back to a single shared template if canvas isolation is not needed',
        { label, count: tpls.length, templateIds: tpls.map(t => t.id) }));
    }
    for (const [base, tpls] of Object.entries(byBase)) {
      if (tpls.length <= 3) continue;
      out.push(diag('EXCESSIVE_TEMPLATE_CLONING', 'warning',
        'data.stepTemplates',
        `${tpls.length} templates derive from "${base}" — infrastructure steps should share a single template rather than cloning per instance. ` +
        `Multiple step instances can point to the same template id and be differentiated by their stepInputData.`,
        'Consolidate cloned infrastructure templates back to a single shared template',
        { baseLabel: base, count: tpls.length, templateIds: tpls.map(t => t.id) }));
    }

    // Detect templates with identical code but different IDs — wasteful duplication
    // that inflates Lambda compilation count and can cause activation timeouts
    const byCode = {};
    const INFRA_LABEL_RE = /gateway|http\s*re(quest|sponse)|send.*response|wait.*request|handle.*error|flow\s*error|random\s*code|key\s*value|storage|date\/?time|change.*format.*date|get.*date/i;
    for (const tpl of templates) {
      if (!tpl.template || tpl.template.length < 50) continue;
      if (tpl.isGatewayStep || INFRA_LABEL_RE.test(tpl.label || '')) continue;
      const codeKey = tpl.template;
      if (!byCode[codeKey]) byCode[codeKey] = [];
      byCode[codeKey].push(tpl);
    }
    for (const [_, dupes] of Object.entries(byCode)) {
      if (dupes.length <= 1) continue;
      const labels = dupes.map(t => `"${t.label || t.id.slice(0, 8)}"`).join(', ');
      const ids = dupes.map(t => t.id);
      const instances = [];
      for (const t of dupes) {
        const inst = allSteps.filter(s => s?.type === t.id);
        instances.push(...inst.map(s => `"${s.label || '(unnamed)'}"`));
      }
      out.push(diag('DUPLICATE_TEMPLATE_CODE', 'error',
        'data.stepTemplates',
        `${dupes.length} templates have identical code: ${labels} — each gets its own Lambda, wasting compilation time ` +
        `and causing activation timeouts. Step instances using them: ${instances.join(', ')}`,
        `Consolidate to a single template and have all step instances (${instances.join(', ')}) reference the same template ID. ` +
        `Multiple step instances can share one template — they are differentiated by their label, stepInputData, and dataOut.`,
        { templateIds: ids, instanceLabels: instances }));
    }

    // Flow size checks — activation timeout risk
    const customTemplates = templates.filter(t => {
      if (t.isGatewayStep) return false;
      if (INFRA_LABEL_RE.test(t.label || '')) return false;
      if (!t.template || t.template.length < 50) return false;
      return true;
    });
    const uniqueCodeCount = new Set(customTemplates.map(t => t.template)).size;

    if (uniqueCodeCount > 8) {
      out.push(diag('FLOW_TOO_MANY_CUSTOM_TEMPLATES', 'error',
        'data.stepTemplates',
        `Flow has ${uniqueCodeCount} unique custom templates (${customTemplates.length} total custom) — ` +
        `Edison compiles each into a separate Lambda during activation. More than ~8 custom templates ` +
        `routinely exceeds the 29-second activation timeout, making the flow undeployable.`,
        'Reduce custom template count: share templates between step instances that use the same code, ' +
        'move logic into sub-flows, or combine related steps into a single multi-purpose template',
        { customTemplateCount: customTemplates.length, uniqueCodeCount, totalTemplates: templates.length }));
    } else if (uniqueCodeCount > 5) {
      out.push(diag('FLOW_MANY_CUSTOM_TEMPLATES', 'warning',
        'data.stepTemplates',
        `Flow has ${uniqueCodeCount} unique custom templates — approaching the ~8 template limit ` +
        `where activation timeouts become likely. Current template count is manageable but leaves little headroom.`,
        'Consider sharing templates between step instances that use the same code directory',
        { customTemplateCount: customTemplates.length, uniqueCodeCount, totalTemplates: templates.length }));
    }

    const flowJson = JSON.stringify(flow.data);
    const flowSizeKB = Math.round(flowJson.length / 1024);
    if (flowSizeKB > 2048) {
      out.push(diag('FLOW_SIZE_TOO_LARGE', 'error',
        'data',
        `Flow JSON is ${flowSizeKB} KB — very large flows cause slow saves, UI lag, and potential deployment failures. ` +
        `Common causes: embedded SVG icons, verbose step code, or excessive template duplication.`,
        'Reduce flow size: use hosted icon URLs instead of data URIs, move complex logic to sub-flows, ' +
        'and consolidate duplicate templates',
        { sizeKB: flowSizeKB }));
    } else if (flowSizeKB > 1024) {
      out.push(diag('FLOW_SIZE_LARGE', 'warning',
        'data',
        `Flow JSON is ${flowSizeKB} KB — large flows may experience slow saves and UI performance issues.`,
        'Consider reducing flow size: check for large embedded icons, verbose code, or duplicate templates',
        { sizeKB: flowSizeKB }));
    }
  }

  return tplMap;
}

// ---------------------------------------------------------------------------
// Pass 4 — Step integrity (per tree)
// ---------------------------------------------------------------------------
function passSteps(flow, tplMap, out) {
  const allStepIds = new Set();
  const stepsByTree = {};

  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree || !Array.isArray(tree.steps)) continue;
    stepsByTree[treeName] = new Map();

    tree.steps.forEach((step, i) => {
      const base = `data.trees.${treeName}.steps[${i}]`;

      if (!step || typeof step !== 'object') {
        out.push(diag('INVALID_STEP_OBJECT', 'error', base, 'Step is not an object', 'Each entry in steps must be an object'));
        return;
      }

      if (!step.id) {
        out.push(diag('STEP_MISSING_ID', 'error', `${base}.id`, 'Step is missing id', 'Add a unique UUID id'));
      } else {
        if (!isUUID(step.id)) {
          out.push(diag('STEP_INVALID_ID', 'error', `${base}.id`,
            `Step id "${step.id}" is not a valid UUID`,
            'Use a valid UUID v4 for the step id',
            { stepId: step.id }));
        }
        if (allStepIds.has(step.id)) {
          out.push(diag('DUPLICATE_STEP_ID', 'error', `${base}.id`,
            `Duplicate step id "${step.id}" across trees`,
            'Each step must have a globally unique id',
            { stepId: step.id, tree: treeName }));
        }
        allStepIds.add(step.id);
        stepsByTree[treeName].set(step.id, step);
      }

      if (step.type === null || step.type === undefined) {
        out.push(diag('STEP_MISSING_TYPE', 'error', `${base}.type`,
          'Step is missing type',
          'Set type to a step template id or "empty"',
          { stepId: step.id }));
      }

      if (step.type !== 'empty' && (step.label === null || step.label === undefined)) {
        out.push(diag('STEP_MISSING_LABEL', 'warning', `${base}.label`,
          'Step is missing a label',
          'Add a descriptive label for canvas display',
          { stepId: step.id }));
      }

      if (step.type !== 'empty' && (step.data === undefined || step.data === null || typeof step.data !== 'object')) {
        out.push(diag('STEP_MISSING_DATA', 'error', `${base}.data`,
          'Step is missing data object',
          'Add a data object with exits array',
          { stepId: step.id }));
      }

      if (step.data && step.data.exits !== undefined && !Array.isArray(step.data.exits)) {
        out.push(diag('STEP_EXITS_NOT_ARRAY', 'error', `${base}.data.exits`,
          'Step data.exits must be an array',
          'Set data.exits to an array',
          { stepId: step.id }));
      }

      if (step.data && Array.isArray(step.data.exits)) {
        const exitIds = new Set();
        step.data.exits.forEach((exit, ei) => {
          if (exit.id && exitIds.has(exit.id)) {
            out.push(diag('DUPLICATE_EXIT_ID', 'warning', `${base}.data.exits[${ei}].id`,
              `Duplicate exit id "${exit.id}" within step`,
              'Exit ids should be unique within a step',
              { stepId: step.id, exitId: exit.id }));
          }
          if (exit.id) exitIds.add(exit.id);

          if (exit.isNewThread !== undefined && exit.isNewThread !== null && typeof exit.isNewThread !== 'boolean') {
            out.push(diag('EXIT_NEWTHREAD_NOT_BOOLEAN', 'warning', `${base}.data.exits[${ei}].isNewThread`,
              `Exit "${exit.label || exit.id}" has non-boolean isNewThread (${typeof exit.isNewThread})`,
              'Set isNewThread to true or false',
              { stepId: step.id, exitId: exit.id, value: exit.isNewThread }));
          }

          if (exit.tagColor !== undefined && exit.tagColor !== null && exit.tagColor !== '') {
            if (typeof exit.tagColor !== 'string' || !/^#[0-9A-Fa-f]{3,8}$/.test(exit.tagColor)) {
              out.push(diag('EXIT_INVALID_TAGCOLOR', 'info', `${base}.data.exits[${ei}].tagColor`,
                `Exit "${exit.label || exit.id}" has invalid tagColor "${exit.tagColor}"`,
                'Set tagColor to a hex color (e.g., "#FF5733") or remove it',
                { stepId: step.id, exitId: exit.id, value: exit.tagColor }));
            }
          }
        });
      }

      if (step.data && step.data.processTimeout === true && !step.data.timeoutDuration) {
        out.push(diag('STEP_TIMEOUT_NO_DURATION', 'warning', `${base}.data.timeoutDuration`,
          `Step "${step.label || step.id}" has processTimeout: true but no timeoutDuration — timeout will use the flow-level default`,
          'Set data.timeoutDuration to a quoted expression (e.g., "\\"60 sec\\"")',
          { stepId: step.id }));
      }

      if (step.data && Array.isArray(step.data.exits)) {
        for (const exit of step.data.exits) {
          if (exit.isNewThread === true) {
            if (!exit.stepId) {
              out.push(diag('NEWTHREAD_EXIT_NO_TARGET', 'error', `${base}.data.exits`,
                `Exit "${exit.label || exit.id}" on step "${step.label || step.id}" has isNewThread: true but no stepId — the new thread has no starting step`,
                'Set stepId to the step where the forked thread should begin execution',
                { stepId: step.id, exitId: exit.id }));
            }
            if (exit.condition === 'processError' || exit.condition === 'processTimeout' || exit.id === '__error__' || exit.id === '__timeout__') {
              out.push(diag('NEWTHREAD_EXIT_ERROR_CONDITION', 'warning', `${base}.data.exits`,
                `Exit "${exit.label || exit.id}" on step "${step.label || step.id}" combines isNewThread with error/timeout condition — forking a thread on error/timeout is likely unintended`,
                'Remove isNewThread from error/timeout exits, or separate the fork logic from error handling',
                { stepId: step.id, exitId: exit.id, condition: exit.condition }));
            }
          }
        }
      }

      if (step.data && step.data.dataOut && typeof step.data.dataOut === 'object') {
        const dt = step.data.dataOut;
        if (dt.type && !VALID_MERGE_TYPES.has(dt.type)) {
          out.push(diag('STEP_INVALID_DATAOUT_TYPE', 'error', `${base}.data.dataOut.type`,
            `dataOut type "${dt.type}" is not valid`,
            'Set dataOut.type to one of: session, thread, shared, global',
            { stepId: step.id, value: dt.type }));
        }
      }

      if (step.dataOutLabelConnected !== null && step.dataOutLabelConnected !== undefined && step.data?.dataOut?.name !== null && step.data?.dataOut?.name !== undefined) {
        if (typeof step.dataOutLabelConnected === 'string' &&
            step.dataOutLabelConnected !== '' &&
            step.dataOutLabelConnected !== step.data.dataOut.name &&
            step.dataOutLabelConnected !== true) {
          out.push(diag('DATAOUT_LABEL_MISMATCH', 'warning', `${base}.dataOutLabelConnected`,
            `dataOutLabelConnected "${step.dataOutLabelConnected}" doesn't match dataOut.name "${step.data.dataOut.name}"`,
            'Set dataOutLabelConnected to true (boolean) or match it to data.dataOut.name',
            { stepId: step.id }));
        }
      }

      if (step.stepInputData && typeof step.stepInputData === 'object') {
        for (const [key, value] of Object.entries(step.stepInputData)) {
          if (key === '') {
            out.push(diag('INVALID_STEP_INPUT_DATA_KEY', 'error', `${base}.stepInputData[""]`,
              'stepInputData contains an empty-string key — this causes compilation errors',
              'Delete the empty-string key from stepInputData',
              { stepId: step.id }));
          }
          if (key === 'undefined') {
            out.push(diag('INVALID_STEP_INPUT_DATA_KEY', 'error', `${base}.stepInputData["undefined"]`,
              'stepInputData contains a literal "undefined" key',
              'Delete the "undefined" key from stepInputData',
              { stepId: step.id }));
          }
          if (typeof value === 'string' && /\(async\s*\(\)/.test(value)) {
            out.push(diag('STEP_INPUT_COMPLEX_EXPRESSION', 'error', `${base}.stepInputData.${key}`,
              `Step "${step.label || step.id}" input "${key}" uses an async IIFE expression — this breaks the Edison UI's renderCondition evaluator and causes "ReferenceError: ${key} is not defined"`,
              'Use a simple expression like (await this.mergeFields["fieldName"].get())?.path or configure the value via the step UI merge field picker',
              { stepId: step.id, key }));
          }
          if (typeof value === 'object' && value !== null) {
            out.push(diag('STEP_INPUT_NON_STRING_VALUE', 'warning', `${base}.stepInputData.${key}`,
              `Step "${step.label || step.id}" input "${key}" has a non-string value (${typeof value}) — stepInputData values should be expression strings`,
              'Convert the value to a string expression',
              { stepId: step.id, key, type: typeof value }));
          }

          // Detect backtick wrapping on non-string (JSON/array/object) inputs.
          // Backtick expressions compile to await (`...`) which always returns a
          // string — arrays become "[object Object]", undefined becomes "undefined".
          if (typeof value === 'string' && value.startsWith('`') && value.includes('this.mergeFields')) {
            const tpl = tplMap.get(step.type);
            if (tpl) {
              const inp = (tpl.formBuilder?.stepInputs || []).find(i => i?.data?.variable === key);
              const isJsonInput = inp && (inp.component === 'formCode' || inp.component === 'formTextBox');
              if (isJsonInput) {
                out.push(diag('STEP_INPUT_BACKTICK_WRAPS_NONSTRING', 'warning', `${base}.stepInputData.${key}`,
                  `Step "${step.label || step.id}" input "${key}" uses backtick wrapping on a JSON/array field (${inp.component}). ` +
                  `Backtick expressions compile to await(\`...\`) which always returns a string — arrays become "[object Object]", ` +
                  `undefined becomes the string "undefined". This corrupts non-string data.`,
                  `Use a raw expression without backtick wrapping for non-string types: ` +
                  `await this.mergeFields['mergeFieldName'].get({path: '${key}'}) instead of ` +
                  `\`\${await this.mergeFields['mergeFieldName'].get({path: '${key}'})}\``,
                  { stepId: step.id, key, component: inp.component }));
              }
            }
          }
        }

        // Detect formSelectExpression values that don't match any predefined option
        {
          const tplCheck = tplMap.get(step.type);
          if (tplCheck && step.stepInputData && typeof step.stepInputData === 'object') {
            const walkInputs = (items) => {
              for (const item of (items || [])) {
                const comp = Array.isArray(item.component) ? item.component[0] : item.component;
                if (comp === 'formSelectExpression' && item.data?.variable && Array.isArray(item.data?.options)) {
                  const varName = item.data.variable;
                  const value = step.stepInputData[varName];
                  if (value !== undefined && typeof value === 'string') {
                    const optionValues = item.data.options.map(o => typeof o === 'object' ? o.value : o).filter(Boolean);
                    if (optionValues.length > 0 && !optionValues.includes(value)) {
                      const severity = item.data.allowCodeMode ? 'warning' : 'error';
                      out.push(diag('SELECT_VALUE_NOT_IN_OPTIONS', severity, `${base}.stepInputData.${varName}`,
                        `Step "${step.label || step.id}" input "${varName}" is a dropdown (formSelectExpression) ` +
                        `but its value does not match any predefined option. ` +
                        `The dropdown will appear unconfigured in the Edison UI.`,
                        `Set the value to one of: ${optionValues.join(', ')}` +
                        (item.data.allowCodeMode ? ` — or verify that code mode is intentional for this field` : ''),
                        { stepId: step.id, key: varName, value, options: optionValues }));
                    }
                  }
                }
                if (Array.isArray(item.data?.inputs)) walkInputs(item.data.inputs);
              }
            };
            walkInputs(tplCheck.formBuilder?.stepInputs);
          }
        }

        // Detect renderConditions that reference variables whose stepInputData values
        // are complex expressions. The Edison UI's generateRenderConditionFunction evals
        // renderConditions with input values as bare JS variables in scope. If a value is
        // a merge field expression or async call, the UI can't resolve it and throws
        // "ReferenceError: <var> is not defined" during serializeStepData/toJSON.
        {
          const tplRC = tplMap.get(step.type);
          if (tplRC?.formBuilder?.stepInputs && step.stepInputData) {
            const rcInputs = tplRC.formBuilder.stepInputs.filter(i =>
              i.data?.renderCondition && typeof i.data.renderCondition === 'string');
            for (const inp of rcInputs) {
              const cond = String(inp.data.renderCondition);
              const referencedVars = (cond.match(/\b[a-zA-Z_]\w*\b/g) || [])
                .filter(v => !['true', 'false', 'null', 'undefined', 'typeof', 'instanceof'].includes(v));
              for (const varName of referencedVars) {
                const val = step.stepInputData[varName] ?? step.data?.[varName];
                if (typeof val !== 'string') continue;
                if (/await\s|this\.|mergeFields/.test(val)) {
                  out.push(diag('RENDER_CONDITION_UNRESOLVABLE', 'error',
                    `${base}.formBuilder.stepInputs[${inp.data.variable}].renderCondition`,
                    `Step "${step.label || step.id}" input "${inp.data.variable}" has renderCondition "${cond}" ` +
                    `that references "${varName}", but "${varName}" is set to an async/merge-field expression. ` +
                    `The Edison UI cannot resolve this and throws "ReferenceError: ${varName} is not defined" during serialization.`,
                    `Either clear the renderCondition on inputs that depend on "${varName}", ` +
                    `or set "${varName}" to a plain value (not an expression) in stepInputData`,
                    { stepId: step.id, inputVar: inp.data.variable, referencedVar: varName, condition: cond }));
                }
              }
            }
          }
        }

        // Detect stale stepInputData keys not matching any formBuilder input variable
        const tpl = tplMap.get(step.type);
        if (tpl && step.stepInputData && typeof step.stepInputData === 'object') {
          const builtinSidKeys = new Set(['processError', 'processTimeout', 'timeoutDuration']);
          const formVars = new Set((tpl.formBuilder?.stepInputs || [])
            .map(i => i?.data?.variable).filter(Boolean));
          const dataExitVars = new Set((tpl.data?.exits || []).map(e => e.id).filter(Boolean));
          for (const key of Object.keys(step.stepInputData)) {
            if (builtinSidKeys.has(key) || formVars.has(key) || dataExitVars.has(key)) continue;
            if (step.data?.[key] !== undefined) continue;
            out.push(diag('STEP_INPUT_STALE_KEY', 'info', `${base}.stepInputData.${key}`,
              `Step "${step.label || step.id}" has stepInputData key "${key}" that doesn't match any formBuilder input variable — this value is silently ignored by the compiler`,
              `Remove the stale key, or add a formBuilder input with variable: "${key}"`,
              { stepId: step.id, key }));
          }
        }
      }
    });
  }

  return { allStepIds, stepsByTree };
}

// ---------------------------------------------------------------------------
// Pass 5 — Referential integrity
// ---------------------------------------------------------------------------
function passRefs(flow, tplMap, allStepIds, stepsByTree, out) {
  const templates = Array.isArray(flow.data.stepTemplates) ? flow.data.stepTemplates : [];
  const tplIds = new Set(templates.map(t => t.id).filter(Boolean));

  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree || !Array.isArray(tree.steps)) continue;
    const treeStepIds = stepsByTree[treeName] ? new Set(stepsByTree[treeName].keys()) : new Set();

    tree.steps.forEach((step, i) => {
      if (!step) return;
      const base = `data.trees.${treeName}.steps[${i}]`;

      if (step.type && step.type !== 'empty' && !tplIds.has(step.type)) {
        out.push(diag('STEP_TEMPLATE_NOT_FOUND', 'error', `${base}.type`,
          `Step type "${step.type}" does not match any stepTemplate id`,
          'Ensure the step type references a valid id from data.stepTemplates[]',
          { stepId: step.id, type: step.type, tree: treeName }));
      }

      if (step.data && Array.isArray(step.data.exits)) {
        step.data.exits.forEach((exit, ei) => {
          const effectiveTarget = exit.stepId ?? exit.targetStepId ?? undefined;
          if (effectiveTarget === '') {
            out.push(diag('EXIT_EMPTY_STEP_ID', 'error', `${base}.data.exits[${ei}].stepId`,
              `Exit "${exit.label || exit.id}" on step "${step.label || step.id}" has an empty-string stepId — Edison runtime will reject this at INIT`,
              'Set stepId to a valid step id, or remove the exit if this step is terminal',
              { stepId: step.id, exitIndex: ei, tree: treeName }));
          } else if (effectiveTarget && !treeStepIds.has(effectiveTarget) && !allStepIds.has(effectiveTarget)) {
            out.push(diag('EXIT_TARGET_NOT_FOUND', 'error', `${base}.data.exits[${ei}].stepId`,
              `Exit "${exit.label || exit.id}" targets step "${effectiveTarget}" which does not exist`,
              'Set stepId to the id of an existing step in the same tree',
              { stepId: step.id, exitIndex: ei, targetStepId: effectiveTarget, tree: treeName }));
          }
        });
      }
    });

    if (treeName !== 'main') {
      if (!tree.steps || !Array.isArray(tree.steps) || tree.steps.length === 0) {
        out.push(diag('SUBTREE_EMPTY', 'warning', `data.trees.${treeName}.steps`,
          `Subtree "${treeName}" has no steps — this subflow does nothing`,
          'Add steps to the subtree, or remove the empty tree',
          { treeKey: treeName }));
      }

      if (!tplIds.has(treeName)) {
        out.push(diag('SUBFLOW_TREE_KEY_MISMATCH', 'warning', `data.trees.${treeName}`,
          `Subflow tree key "${treeName}" does not match any step template id (template may have been stripped after deployment)`,
          'Ensure the subflow tree key matches a step template id, or re-add the subflow step template',
          { treeKey: treeName }));
      } else {
        const tpl = tplMap.get(treeName);
        if (tpl && !tpl.data?.isSubflow) {
          out.push(diag('SUBFLOW_TEMPLATE_MISSING_FLAG', 'warning', `data.stepTemplates[].data.isSubflow`,
            `Step template "${tpl.label || treeName}" is used as a subflow tree key but missing data.isSubflow: true`,
            'Add data.isSubflow: true to the step template',
            { templateId: treeName }));
        }
      }

      if (tree.meta && tree.meta.subflowId) {
        if (!isUUID(tree.meta.subflowId)) {
          out.push(diag('SUBTREE_INVALID_SUBFLOW_ID', 'warning', `data.trees.${treeName}.meta.subflowId`,
            `Subtree "${treeName}" has meta.subflowId "${tree.meta.subflowId}" which is not a valid UUID`,
            'Set meta.subflowId to a valid flow UUID, or remove it if this is not a subflow reference',
            { treeKey: treeName, subflowId: tree.meta.subflowId }));
        }
      }
    }
  }

  // Cross-tree exit validation: isNewThread exits that target steps in other trees
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree || !Array.isArray(tree.steps)) continue;
    const treeStepIds2 = stepsByTree[treeName] ? new Set(stepsByTree[treeName].keys()) : new Set();

    for (const step of tree.steps) {
      if (!step?.data?.exits) continue;
      for (const exit of step.data.exits) {
        if (!exit.stepId || !exit.isNewThread) continue;
        if (!treeStepIds2.has(exit.stepId) && allStepIds.has(exit.stepId)) {
          let targetTree = null;
          for (const [tn, t] of Object.entries(flow.data.trees)) {
            if (tn === treeName || !t?.steps) continue;
            if (t.steps.some(s => s?.id === exit.stepId)) { targetTree = tn; break; }
          }
          if (targetTree) {
            out.push(diag('NEWTHREAD_CROSS_TREE_EXIT', 'info', `step ${step.id}`,
              `Exit "${exit.label || exit.id}" on step "${step.label || step.id}" forks a thread to step in subtree "${targetTree}"`,
              'Verify this cross-tree thread fork is intentional',
              { stepId: step.id, exitId: exit.id, sourceTree: treeName, targetTree }));
          }
        }
      }
    }
  }

  const meta = flow.data.meta;
  if (meta) {
    if (meta.globalProcessErrorStepId && !allStepIds.has(meta.globalProcessErrorStepId)) {
      out.push(diag('ERROR_HANDLER_STEP_NOT_FOUND', 'error', 'data.meta.globalProcessErrorStepId',
        `globalProcessErrorStepId "${meta.globalProcessErrorStepId}" does not reference a valid step`,
        'Set globalProcessErrorStepId to the id of the Handle Flow Error step',
        { stepId: meta.globalProcessErrorStepId }));
    }

    if (Array.isArray(meta.dataOuts)) {
      meta.dataOuts.forEach((d, i) => {
        if (!d || typeof d !== 'object') return;
        if (d.stepId && !allStepIds.has(d.stepId)) {
          out.push(diag('DATAOUT_STEP_NOT_FOUND', 'error', `data.meta.dataOuts[${i}].stepId`,
            `dataOuts entry "${d.name}" references step "${d.stepId}" which does not exist`,
            'Update stepId to match an existing step in the flow',
            { name: d.name, stepId: d.stepId }));
        }
        if (d.stepTemplateId && !tplIds.has(d.stepTemplateId)) {
          out.push(diag('DATAOUT_TEMPLATE_NOT_FOUND', 'warning', `data.meta.dataOuts[${i}].stepTemplateId`,
            `dataOuts entry "${d.name}" references template "${d.stepTemplateId}" which does not exist`,
            'Update stepTemplateId to match an existing step template',
            { name: d.name, stepTemplateId: d.stepTemplateId }));
        }
        // stepTemplateId should match the referenced step's type
        if (d.stepId && d.stepTemplateId && allStepIds.has(d.stepId)) {
          let referencedStep;
          for (const t of Object.values(flow.data.trees || {})) {
            if (t?.steps) referencedStep = t.steps.find(s => s?.id === d.stepId);
            if (referencedStep) break;
          }
          if (referencedStep && referencedStep.type !== d.stepTemplateId) {
            out.push(diag('DATAOUT_TEMPLATE_STEP_MISMATCH', 'warning', `data.meta.dataOuts[${i}]`,
              `dataOuts entry "${d.name}" has stepTemplateId "${d.stepTemplateId?.slice(0, 8)}..." but the referenced step uses template "${referencedStep.type?.slice(0, 8)}..."`,
              'Set stepTemplateId to match the step\'s type field',
              { name: d.name, stepId: d.stepId, stepTemplateId: d.stepTemplateId, actualType: referencedStep.type }));
          }
        }
        // _currentSubflows is auto-injected — shouldn't be manually declared
        if (d.name === '_currentSubflows') {
          out.push(diag('DATAOUT_RESERVED_NAME', 'warning', `data.meta.dataOuts[${i}]`,
            'dataOuts entry "_currentSubflows" is auto-injected by the runtime — declaring it manually may cause conflicts',
            'Remove this entry; the runtime creates it automatically',
            { name: d.name }));
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 6 — Graph analysis
// ---------------------------------------------------------------------------
function passGraph(flow, allStepIds, stepsByTree, out) {
  const meta = flow.data.meta || {};
  const errorHandlerId = meta.globalProcessErrorStepId;

  const templates = flow.data.stepTemplates || [];

  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree || !Array.isArray(tree.steps) || tree.steps.length === 0) continue;
    const steps = tree.steps;

    // Duplicate step IDs — every step must have a unique id
    {
      const idCounts = {};
      for (const s of steps) {
        if (!s?.id) continue;
        idCounts[s.id] = (idCounts[s.id] || 0) + 1;
      }
      for (const [id, count] of Object.entries(idCounts)) {
        if (count > 1) {
          const labels = steps.filter(s => s.id === id).map(s => s.label || '(no label)');
          out.push(diag('DUPLICATE_STEP_ID', 'error', `data.trees.${treeName}`,
            `Step ID "${id}" appears ${count} times — step IDs must be unique within a tree. Labels: ${labels.join(', ')}`,
            `Assign unique UUIDs to each step instance`,
            { stepId: id, tree: treeName, count, labels }));
        }
      }
    }

    // Duplicate step labels (non-empty) — confusing on the canvas
    {
      const labelCounts = {};
      for (const s of steps) {
        const lbl = (s?.label || '').trim();
        if (!lbl) continue;
        if (!labelCounts[lbl]) labelCounts[lbl] = [];
        labelCounts[lbl].push(s.id);
      }
      for (const [label, ids] of Object.entries(labelCounts)) {
        if (ids.length > 1) {
          out.push(diag('DUPLICATE_STEP_LABEL', 'warning', `data.trees.${treeName}`,
            `${ids.length} steps share the label "${label}" — they will be indistinguishable on the canvas`,
            `Give each step a unique label to avoid confusion (e.g. append a qualifier)`,
            { tree: treeName, label, stepIds: ids, count: ids.length }));
        }
      }
    }

    // Duplicate dataOut.name — causes merge field collisions at runtime
    {
      const dataOutNames = {};
      for (const s of steps) {
        const name = s?.data?.dataOut?.name;
        if (!name) continue;
        if (!dataOutNames[name]) dataOutNames[name] = [];
        dataOutNames[name].push(s);
      }
      for (const [name, dupes] of Object.entries(dataOutNames)) {
        if (dupes.length <= 1) continue;
        const labels = dupes.map(s => `"${s.label || s.id}"`).join(', ');
        out.push(diag('DUPLICATE_DATAOUT_NAME', 'warning', `data.trees.${treeName}`,
          `${dupes.length} steps share dataOut.name "${name}" — merge field writes will collide at runtime. Steps: ${labels}`,
          `Give each step a unique dataOut.name (derived from its label)`,
          { tree: treeName, dataOutName: name, stepIds: dupes.map(s => s.id), count: dupes.length }));
      }
    }

    const gwStep = steps.find(s => {
      const tpl = templates.find(t => t.id === s.type);
      return tpl?.isGatewayStep;
    });

    if (treeName === 'main' && !gwStep) {
      out.push(diag('MISSING_GATEWAY_STEP', 'error', `data.trees.${treeName}`,
        `Tree "${treeName}" has no gateway/trigger step — the flow has no entry point and cannot receive requests`,
        'Add a gateway step (e.g. Wait for HTTP Request) with isGatewayStep: true on its template',
        { tree: treeName }));
    }

    if (gwStep) {
      const gwIdx = steps.indexOf(gwStep);
      const errorHandlerId = meta.globalProcessErrorStepId;
      const hfeIdx = steps.findIndex(s => s.id === errorHandlerId);
      const expectedIdx = hfeIdx >= 0 ? hfeIdx + 1 : 0;
      if (gwIdx > expectedIdx + 2) {
        out.push(diag('GATEWAY_NOT_FIRST_REAL_STEP', 'warning', `data.trees.${treeName}`,
          `Gateway step "${gwStep.label}" is at position ${gwIdx} in the steps array — it should be near the top (after the error handler) for the canvas to render correctly`,
          'Move the gateway step to position 0 or 1 in the steps array',
          { tree: treeName, gatewayStepId: gwStep.id, currentIndex: gwIdx }));
      }
    }

    const firstStepId = tree.startStepId || gwStep?.id || steps[0]?.id;

    for (const step of steps) {
      if (step?.type === 'empty' && step.shape && step.shape !== 'empty') {
        out.push(diag('GHOST_EMPTY_STEP', 'error', `data.trees.${treeName}`,
          `Step "${step.label || step.id}" has type "empty" but shape "${step.shape}" — the canvas will render an orphan node instead of hiding it`,
          'Set shape to "empty" or delete this step and rewire exits that target it to a proper empty placeholder',
          { stepId: step.id, tree: treeName, shape: step.shape }));
      }
    }

    const inboundCount = new Map();
    const targetToSources = new Map();
    steps.forEach(s => { if (s?.id) inboundCount.set(s.id, 0); });

    for (const step of steps) {
      if (!step?.data?.exits) continue;
      for (const exit of step.data.exits) {
        if (!exit.stepId) continue;
        inboundCount.set(exit.stepId, (inboundCount.get(exit.stepId) || 0) + 1);

        if (exit.condition === 'processError' || exit.condition === 'processTimeout') continue;
        if (!targetToSources.has(exit.stepId)) targetToSources.set(exit.stepId, []);
        targetToSources.get(exit.stepId).push({
          sourceStepId: step.id,
          sourceLabel: step.label,
          exitLabel: exit.label || exit.id,
          exitCondition: exit.condition || '',
        });
      }
    }

    for (const step of steps) {
      if (!step?.id) continue;

      if (inboundCount.get(step.id) === 0 &&
          step.id !== firstStepId &&
          step.id !== errorHandlerId &&
          step.type !== 'empty') {
        out.push(diag('UNREACHABLE_STEP', 'warning', `data.trees.${treeName}`,
          `Step "${step.label || step.id}" has no inbound connections`,
          'Wire an exit from another step to this step, or remove it if unused',
          { stepId: step.id, label: step.label, tree: treeName }));
      }

      if (step.type !== 'empty' &&
          (!step.data?.exits || step.data.exits.length === 0) &&
          step.id !== errorHandlerId) {
        out.push(diag('DEAD_END_STEP', 'error', `data.trees.${treeName}`,
          `Step "${step.label || step.id}" has no exits — flow will end here`,
          'Add at least one exit or wire to an empty termination step',
          { stepId: step.id, label: step.label, tree: treeName }));
      }
    }

    for (const [targetId, sources] of targetToSources) {
      if (sources.length > 1) {
        const targetStep = steps.find(s => s?.id === targetId);
        if (targetStep && targetId !== errorHandlerId) {
          const distinctSources = new Set(sources.map(s => s.sourceStepId));
          if (distinctSources.size > 1) {
            const isEmptyTerminus = targetStep.type === 'empty';
            out.push(diag('SHARED_STEP_TARGET',
              isEmptyTerminus ? 'warning' : 'error',
              `data.trees.${treeName}`,
              isEmptyTerminus
                ? `Empty terminus "${targetStep.label || targetId}" is shared by ${distinctSources.size} different steps — adding a step below any of them in Edison will affect all ${distinctSources.size} legs`
                : `Step "${targetStep.label || targetId}" is targeted by ${distinctSources.size} different steps — Edison will visually duplicate this step on the canvas`,
              'Create separate step instances (unique ids) for each inbound path so legs are independent',
              { stepId: targetId, label: targetStep.label, tree: treeName, isEmptyTerminus,
                sources: sources.map(s => `${s.sourceLabel}→${s.exitLabel}`) }));
          }
        }
      }
    }

    for (const step of steps) {
      if (!step?.data?.exits || step.data.exits.length < 2) continue;
      const seen = new Map();
      for (const exit of step.data.exits) {
        if (!exit.stepId) continue;
        if (seen.has(exit.stepId)) {
          const target = steps.find(s => s?.id === exit.stepId);
          if (target && target.type !== 'empty') {
            out.push(diag('SAME_STEP_SHARED_TARGET', 'error', `data.trees.${treeName}`,
              `Step "${step.label || step.id}" has exits "${seen.get(exit.stepId)}" and "${exit.id}" both pointing to "${target.label || exit.stepId}" — Edison will duplicate the target on the canvas`,
              'Create a separate step instance (same template, new UUID) for each exit, or point one exit to an empty placeholder',
              { stepId: step.id, targetStepId: exit.stepId, tree: treeName }));
          }
        } else {
          seen.set(exit.stepId, exit.id);
        }
      }
    }

    // Shared templates: multiple non-empty step instances referencing the same
    // template ID. Editing one on the canvas modifies the shared template,
    // propagating changes (inputs, exits, labels) to all instances.
    {
      const byType = {};
      for (const step of steps) {
        if (!step?.type || step.type === 'empty') continue;
        if (!byType[step.type]) byType[step.type] = [];
        byType[step.type].push(step);
      }
      const infraLabelRe = /gateway|error|response|random|key.value|storage|date|time|handle.*flow/i;
      for (const [typeId, instances] of Object.entries(byType)) {
        if (instances.length <= 1) continue;
        const tpl = templates.find(t => t.id === typeId);
        const tplLabel = tpl?.label || typeId;
        const isInfra = infraLabelRe.test(tplLabel) || tpl?.isGatewayStep ||
                         (!tpl?.code && !tpl?.formBuilder?.stepInputs?.length);
        const severity = isInfra ? 'info' : 'warning';
        const labels = instances.map(s => `"${s.label || s.id}"`).join(', ');
        out.push(diag('SHARED_TEMPLATE', severity, `data.trees.${treeName}`,
          `${instances.length} step instances share template "${tplLabel}" (${typeId.slice(0, 8)}): ${labels} — ` +
          (isInfra
            ? `infrastructure template shared by ${instances.length} instances (normal for built-in steps)`
            : `editing any one of these on the canvas will modify the shared template and change all instances`),
          isInfra
            ? 'Infrastructure sharing is expected — each instance is differentiated by stepInputData'
            : 'Clone the template for each instance so each step has its own independent copy (use flowEditor.cloneTemplate())',
          { templateId: typeId, templateLabel: tplLabel, tree: treeName,
            instances: instances.map(s => ({ id: s.id, label: s.label })),
            isInfrastructure: isInfra }));
      }
    }

    const visited = new Set();
    const visiting = new Set();
    const path = [];
    function detectCycle(stepId) {
      if (visiting.has(stepId)) {
        const cycleStart = path.indexOf(stepId);
        const cycle = path.slice(cycleStart).concat(stepId);
        out.push(diag('CIRCULAR_REFERENCE', 'error', `data.trees.${treeName}`,
          `Circular exit chain detected: ${cycle.join(' → ')} — the Edison UI traverses step wiring recursively and will crash with "Maximum call stack size exceeded" on any cycle`,
          'Break the cycle by pointing one exit to an empty step (type: "empty") instead of its current target. Do NOT delete stepId — the Lambda runtime requires it. Error handler loops are the most common cause: point __error__ exits on post-error steps to empty steps',
          { cycle, tree: treeName }));
        return;
      }
      if (visited.has(stepId)) return;
      visiting.add(stepId);
      path.push(stepId);

      const step = steps.find(s => s?.id === stepId);
      if (step?.data?.exits) {
        for (const exit of step.data.exits) {
          if (exit.stepId) detectCycle(exit.stepId);
        }
      }

      path.pop();
      visiting.delete(stepId);
      visited.add(stepId);
    }

    for (const step of steps) {
      if (step?.id && !visited.has(step.id)) detectCycle(step.id);
    }
  }

  if (Array.isArray(flow.data.stepTemplates)) {
    const usedTypes = new Set();
    for (const tree of Object.values(flow.data.trees)) {
      if (tree?.steps) {
        for (const s of tree.steps) {
          if (s?.type) usedTypes.add(s.type);
        }
      }
    }
    flow.data.stepTemplates.forEach((tpl, i) => {
      if (tpl?.id && !usedTypes.has(tpl.id)) {
        out.push(diag('ORPHAN_TEMPLATE', 'warning', `data.stepTemplates[${i}]`,
          `Step template "${tpl.label || tpl.id}" is not referenced by any step`,
          'Remove the unused template or add a step that uses it',
          { templateId: tpl.id, label: tpl.label }));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Pass 7 — Merge field consistency
// ---------------------------------------------------------------------------
function passMergeFields(flow, out) {
  const meta = flow.data.meta;
  if (!meta || !Array.isArray(meta.dataOuts)) return;

  const seenNames = new Map();
  meta.dataOuts.forEach((d, i) => {
    const base = `data.meta.dataOuts[${i}]`;
    if (!d || typeof d !== 'object') {
      out.push(diag('INVALID_DATAOUT_ENTRY', 'error', base, 'dataOuts entry is not an object', 'Each entry must be an object with name, type, etc.'));
      return;
    }
    if (!d.name && d.name !== '') {
      out.push(diag('DATAOUT_MISSING_NAME', 'warning', `${base}.name`,
        'dataOuts entry is missing a name',
        'Add a name for the merge field'));
    }
    if (d.type && !VALID_MERGE_TYPES.has(d.type)) {
      out.push(diag('DATAOUT_INVALID_TYPE', 'error', `${base}.type`,
        `dataOuts type "${d.type}" is not valid`,
        'Set type to one of: session, thread, shared, global',
        { name: d.name, value: d.type }));
    }
    if (d.name) {
      if (seenNames.has(d.name)) {
        out.push(diag('DUPLICATE_MERGE_FIELD_NAME', 'error', `${base}.name`,
          `Duplicate merge field name "${d.name}" (also at index ${seenNames.get(d.name)}) — multiple steps writing to the same field can cause data overwrites`,
          'Use unique merge field names per step, or confirm the shared name is intentional',
          { name: d.name, firstIndex: seenNames.get(d.name), duplicateIndex: i }));
      } else {
        seenNames.set(d.name, i);
      }
    }
  });

  meta.dataOuts.forEach((d, i) => {
    if (!d || typeof d !== 'object') return;
    const base = `data.meta.dataOuts[${i}]`;
    if (d.type === 'shared' || d.type === 'global') {
      if (d.ttl === undefined || d.ttl === null) {
        out.push(diag('MERGE_FIELD_MISSING_TTL', 'warning', `${base}.ttl`,
          `Merge field "${d.name}" has type "${d.type}" but no ttl — ${d.type}-scoped fields require a TTL (ms) for expiration`,
          `Set ttl to a positive number (e.g., 86400000 for 24 hours)`,
          { name: d.name, type: d.type }));
      } else if (typeof d.ttl !== 'number' || d.ttl <= 0) {
        out.push(diag('MERGE_FIELD_INVALID_TTL', 'warning', `${base}.ttl`,
          `Merge field "${d.name}" has invalid ttl ${JSON.stringify(d.ttl)} — must be a positive number (ms)`,
          'Set ttl to a positive number (e.g., 86400000 for 24 hours)',
          { name: d.name, ttl: d.ttl }));
      }
    }
    if (d.type === 'thread' && !d.thread) {
      out.push(diag('MERGE_FIELD_THREAD_NO_ID', 'info', `${base}.thread`,
        `Merge field "${d.name}" has type "thread" but no thread ID — it will default to the current thread`,
        'Set thread to a thread ID if this field should be scoped to a specific thread',
        { name: d.name }));
    }
    if (d.name && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(d.name)) {
      out.push(diag('MERGE_FIELD_INVALID_NAME', 'warning', `${base}.name`,
        `Merge field name "${d.name}" is not a valid JavaScript identifier — this.get('${d.name}') will work but template interpolation \`\${${d.name}}\` may fail`,
        'Use a valid JS identifier (letters, digits, _, $; not starting with a digit)',
        { name: d.name }));
    }
  });

  const declaredNames = new Set(meta.dataOuts.map(d => d?.name).filter(Boolean));
  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step) continue;
      const outName = step.data?.dataOut?.name || (typeof step.dataOutLabelConnected === 'string' && step.dataOutLabelConnected !== '' ? step.dataOutLabelConnected : null);
      if (outName && !declaredNames.has(outName)) {
        out.push(diag('UNDECLARED_MERGE_FIELD', 'warning', `step ${step.id}`,
          `Step "${step.label || step.id}" writes to merge field "${outName}" which is not declared in data.meta.dataOuts`,
          'Add a matching entry to data.meta.dataOuts[] with the correct name, type, and stepId',
          { stepId: step.id, fieldName: outName }));
      }
    }
  }

  // Check merge field references against declared names.
  // Scans stepInputData, step.data string fields, and exit conditions.
  const mfRefPattern = /mergeFields\[['"](\w+)['"]\]/g;
  function findClosest(refName) {
    return [...declaredNames].find(n =>
      n.toLowerCase().startsWith(refName.toLowerCase()) ||
      refName.toLowerCase().startsWith(n.toLowerCase())
    );
  }

  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step) continue;
      const seenRefs = new Set();

      // Scan stepInputData (all keys)
      if (step.stepInputData && typeof step.stepInputData === 'object') {
        for (const [key, value] of Object.entries(step.stepInputData)) {
          if (typeof value !== 'string') continue;
          let m;
          const re = new RegExp(mfRefPattern.source, 'g');
          while ((m = re.exec(value)) !== null) {
            const refName = m[1];
            if (declaredNames.has(refName) || seenRefs.has(refName)) continue;
            seenRefs.add(refName);
            const closest = findClosest(refName);
            const isBody = key === 'body' || key === 'responseBody';
            out.push(diag(
              isBody ? 'RESPONSE_BODY_UNDECLARED_MERGE_FIELD' : 'STEP_INPUT_UNDECLARED_MERGE_FIELD',
              'error', `step ${step.id}.stepInputData.${key}`,
              `Step "${step.label || step.id}" input "${key}" references merge field "${refName}" which is not declared in meta.dataOuts — the value will be undefined at runtime` +
              (closest ? `. Did you mean "${closest}"?` : ''),
              `Replace mergeFields['${refName}'] with a declared name: ${[...declaredNames].join(', ')}`,
              { stepId: step.id, key, referencedName: refName, declaredNames: [...declaredNames], closest }));
          }
        }
      }

      // Scan step.data string fields (value, key, body, responseBody, condition, expression, etc.)
      if (step.data && typeof step.data === 'object') {
        const skipKeys = new Set(['exits', 'dataOut', 'meta', 'threadSettings', 'processError',
          'processTimeout', 'timeoutDuration', 'flowGlobalErrorHandlerIds']);
        for (const [key, value] of Object.entries(step.data)) {
          if (typeof value !== 'string' || skipKeys.has(key)) continue;
          let m;
          const re = new RegExp(mfRefPattern.source, 'g');
          while ((m = re.exec(value)) !== null) {
            const refName = m[1];
            if (declaredNames.has(refName) || seenRefs.has(refName)) continue;
            seenRefs.add(refName);
            const closest = findClosest(refName);
            out.push(diag('STEP_DATA_UNDECLARED_MERGE_FIELD', 'error', `step ${step.id}.data.${key}`,
              `Step "${step.label || step.id}" data field "${key}" references merge field "${refName}" which is not declared in meta.dataOuts — the value will be undefined at runtime` +
              (closest ? `. Did you mean "${closest}"?` : ''),
              `Replace mergeFields['${refName}'] with a declared name: ${[...declaredNames].join(', ')}`,
              { stepId: step.id, key, referencedName: refName, declaredNames: [...declaredNames], closest }));
          }
        }
      }

      // Scan exit conditions
      for (const exit of (step.data?.exits || [])) {
        if (typeof exit.condition !== 'string') continue;
        let m;
        const re = new RegExp(mfRefPattern.source, 'g');
        while ((m = re.exec(exit.condition)) !== null) {
          const refName = m[1];
          if (declaredNames.has(refName) || seenRefs.has(refName)) continue;
          seenRefs.add(refName);
          const closest = findClosest(refName);
          out.push(diag('EXIT_CONDITION_UNDECLARED_MERGE_FIELD', 'error',
            `step ${step.id}.data.exits[${exit.id}].condition`,
            `Step "${step.label || step.id}" exit "${exit.id}" condition references merge field "${refName}" which is not declared in meta.dataOuts — the exit condition will fail at runtime` +
            (closest ? `. Did you mean "${closest}"?` : ''),
            `Replace mergeFields['${refName}'] with a declared name: ${[...declaredNames].join(', ')}`,
            { stepId: step.id, exitId: exit.id, referencedName: refName, declaredNames: [...declaredNames], closest }));
        }
      }
    }
  }

  // Reachability: verify that the step producing a merge field is upstream of
  // the step consuming it (i.e., reachable via exits in the execution graph).
  const producerByName = new Map();
  for (const d of meta.dataOuts) {
    if (d?.name && d?.stepId) producerByName.set(d.name, d.stepId);
  }

  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    const adj = new Map();
    const stepMap = new Map();
    for (const s of tree.steps) {
      if (!s) continue;
      stepMap.set(s.id, s);
      const targets = [];
      if (Array.isArray(s.data?.exits)) {
        for (const ex of s.data.exits) {
          if (ex.stepId) targets.push(ex.stepId);
        }
      }
      adj.set(s.id, targets);
    }

    function isReachable(from, to) {
      if (from === to) return true;
      const visited = new Set();
      const queue = [from];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (cur === to) return true;
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const next of (adj.get(cur) || [])) {
          if (!visited.has(next)) queue.push(next);
        }
      }
      return false;
    }

    function checkReachability(step, location, value) {
      if (typeof value !== 'string') return;
      const re = new RegExp(mfRefPattern.source, 'g');
      let m;
      while ((m = re.exec(value)) !== null) {
        const refName = m[1];
        const producerId = producerByName.get(refName);
        if (!producerId || !stepMap.has(producerId)) continue;
        if (!isReachable(producerId, step.id)) {
          out.push(diag('STEP_INPUT_MERGE_REF_NOT_REACHABLE', 'warning', `step ${step.id}.${location}`,
            `Step "${step.label || step.id}" ${location} references merge field "${refName}" produced by step "${stepMap.get(producerId)?.label || producerId}", ` +
            `but there is no execution path from the producer to this step — the merge field may not be populated when this step runs`,
            `Verify the canvas wiring: the producing step must have a chain of exits leading to this step, or use a shared/global merge field that persists across sessions`,
            { stepId: step.id, location, refName, producerId }));
        }
      }
    }

    for (const step of tree.steps) {
      if (!step) continue;
      // stepInputData
      if (step.stepInputData && typeof step.stepInputData === 'object') {
        for (const [key, value] of Object.entries(step.stepInputData)) {
          checkReachability(step, `stepInputData.${key}`, value);
        }
      }
      // step.data string fields
      if (step.data && typeof step.data === 'object') {
        for (const [key, value] of Object.entries(step.data)) {
          if (typeof value !== 'string') continue;
          checkReachability(step, `data.${key}`, value);
        }
      }
      // exit conditions
      for (const exit of (step.data?.exits || [])) {
        if (typeof exit.condition === 'string') {
          checkReachability(step, `data.exits[${exit.id}].condition`, exit.condition);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 8 — Error and timeout handling
// ---------------------------------------------------------------------------
function passErrorHandling(flow, stepsByTree, out) {
  const meta = flow.data.meta || {};

  if (meta.globalProcessError === true && !meta.globalProcessErrorStepId) {
    out.push(diag('MISSING_ERROR_HANDLER_STEP_ID', 'error', 'data.meta.globalProcessErrorStepId',
      'globalProcessError is true but globalProcessErrorStepId is not set',
      'Set globalProcessErrorStepId to the id of the Handle Flow Error step'));
  }

  if (meta.globalProcessErrorStepId && meta.globalProcessError !== true) {
    out.push(diag('ERROR_HANDLER_FLAG_MISMATCH', 'warning', 'data.meta.globalProcessError',
      'globalProcessErrorStepId is set but globalProcessError is not true',
      'Set data.meta.globalProcessError = true to enable the error handler'));
  }

  if (meta.globalTimeoutProcessing === true && !meta.globalProcessError) {
    out.push(diag('TIMEOUT_WITHOUT_ERROR_HANDLER', 'warning', 'data.meta',
      'globalTimeoutProcessing is true but globalProcessError is not — timeout events won\'t have an error handler to fall back to',
      'Set data.meta.globalProcessError = true and add a Handle Flow Error step'));
  }

  // Count Handle Flow Error step instances across all trees.
  const HFE_TPL_IDS = new Set([
    '3a40f4a9-1968-4c0b-8380-027c14109208', // Handle Flow Error v2
    '3a40f4a9-4a47-4016-8c10-86f2b4eb1ebb', // Handle Flow Error v1
  ]);
  const HFE_LABEL = /handle\s*flow\s*error/i;
  const hfeInstances = [];
  for (const [treeName, stepsMap] of Object.entries(stepsByTree)) {
    if (!stepsMap) continue;
    for (const [stepId, step] of stepsMap) {
      if (HFE_TPL_IDS.has(step.type) || HFE_LABEL.test(step.label || '')) {
        hfeInstances.push({ stepId, label: step.label || '', tree: treeName, data: step.data || {} });
      }
    }
  }

  if (hfeInstances.length === 0) {
    out.push(diag('NO_ERROR_HANDLER_STEP', 'error', 'data.trees',
      'Flow has no Handle Flow Error step — every production flow needs exactly one to catch unhandled errors and timeouts',
      'Add a Handle Flow Error step and set data.meta.globalProcessError = true and data.meta.globalProcessErrorStepId to its id'));
  } else if (hfeInstances.length > 1) {
    const labels = hfeInstances.map(h => `"${h.label}" (${h.stepId.slice(0, 8)})`).join(', ');
    out.push(diag('MULTIPLE_ERROR_HANDLER_STEPS', 'error', 'data.trees',
      `Flow has ${hfeInstances.length} Handle Flow Error steps: ${labels} — only one is needed on the canvas. The runtime uses globalProcessErrorStepId to route errors; extra instances cause conflicts or are unreachable`,
      'Remove the extra Handle Flow Error step(s) and keep only the one referenced by data.meta.globalProcessErrorStepId',
      { steps: hfeInstances.map(h => ({ stepId: h.stepId, label: h.label, tree: h.tree })) }));
  }

  if (meta.globalProcessErrorStepId && hfeInstances.length > 0) {
    const designated = hfeInstances.find(h => h.stepId === meta.globalProcessErrorStepId);
    if (!designated) {
      out.push(diag('ERROR_HANDLER_STEP_TYPE_MISMATCH', 'warning', 'data.meta.globalProcessErrorStepId',
        `globalProcessErrorStepId points to a step that is not a Handle Flow Error instance — error/timeout routing may not work correctly`,
        'Set globalProcessErrorStepId to the id of the Handle Flow Error step',
        { globalProcessErrorStepId: meta.globalProcessErrorStepId, hfeSteps: hfeInstances }));
    } else {
      const hfeData = designated.data || {};
      const threadSettings = (hfeData.threadSettings || '').replace(/`/g, '').trim();
      if (threadSettings && threadSettings !== 'all') {
        out.push(diag('ERROR_HANDLER_NOT_GLOBAL', 'warning',
          `step ${designated.stepId}`,
          `Handle Flow Error step "${designated.label}" is the designated globalProcessErrorStepId but threadSettings is "${threadSettings}" instead of "all" — errors in threads outside "${threadSettings === 'specific' ? (hfeData.threads || []).map(t => (t.thread || '').replace(/`/g, '')).join(', ') : threadSettings}" will not be caught`,
          'Set threadSettings to "`all`" in the Handle Flow Error step so it acts as a true global error handler',
          { stepId: designated.stepId, threadSettings: hfeData.threadSettings, threads: hfeData.threads }));
      }
    }
  }

  if (meta.globalProcessErrorStepId) {
    const mainSteps = stepsByTree.main;
    if (mainSteps) {
      const errorStep = mainSteps.get(meta.globalProcessErrorStepId);
      if (errorStep && errorStep.data?.exits) {
        const exitIds = new Set(errorStep.data.exits.map(e => e.id || e.label));
        if (!exitIds.has('next')) {
          out.push(diag('ERROR_HANDLER_MISSING_NEXT_EXIT', 'warning',
            `step ${meta.globalProcessErrorStepId}`,
            'Error handler step is missing a "next" exit',
            'Add an exit with id "next" to the error handler step'));
        }
        if (!exitIds.has('timeout')) {
          out.push(diag('ERROR_HANDLER_MISSING_TIMEOUT_EXIT', 'warning',
            `step ${meta.globalProcessErrorStepId}`,
            'Error handler step is missing a "timeout" exit',
            'Add an exit with id "timeout" to the error handler step'));
        }
        if (!exitIds.has('error')) {
          out.push(diag('ERROR_HANDLER_MISSING_ERROR_EXIT', 'warning',
            `step ${meta.globalProcessErrorStepId}`,
            'Error handler step is missing an "error" exit',
            'Add an exit with id "error" to the error handler step'));
        }

        for (const exit of errorStep.data.exits) {
          const targetId = exit.stepId;
          if (!targetId) continue;
          const target = mainSteps.get(targetId);
          if (target && (target.type === 'empty' || target.shape === 'empty')) {
            const isTimeout = /timeout/i.test(exit.id) || /timeout/i.test(exit.label);
            const severity = 'error';
            out.push(diag(
              isTimeout ? 'ERROR_HANDLER_TIMEOUT_TO_EMPTY' : 'ERROR_HANDLER_EXIT_TO_EMPTY',
              severity,
              `step ${meta.globalProcessErrorStepId}`,
              `Handle Flow Error "${exit.label || exit.id}" exit routes to an empty step — HTTP requests will never receive a response and will timeout`,
              'Replace the empty step with a Send HTTP Response step that returns an error/timeout status code',
              { stepId: meta.globalProcessErrorStepId, exitId: exit.id, targetStepId: targetId }));
          }
        }
      }
    }
  }

  // When global error handling is enabled, individual __error__ exits wired to the
  // HFE step are redundant — the runtime already routes unhandled errors there.
  if (meta.globalProcessError && meta.globalProcessErrorStepId) {
    const hfeTargetId = meta.globalProcessErrorStepId;
    for (const [treeName, stepsMap] of Object.entries(stepsByTree)) {
      if (!stepsMap) continue;
      const redundant = [];
      for (const [stepId, step] of stepsMap) {
        if (stepId === hfeTargetId) continue;
        if (!step.data?.exits) continue;
        const errExit = step.data.exits.find(e => e.id === '__error__' && e.stepId === hfeTargetId);
        if (errExit) redundant.push(step.label || stepId.slice(0, 8));
      }
      if (redundant.length > 0) {
        out.push(diag('REDUNDANT_ERROR_EXITS', 'warning', `data.trees.${treeName}`,
          `${redundant.length} step(s) have __error__ exits wired to the global error handler — this is redundant because meta.globalProcessError is enabled and already routes all unhandled errors to the Handle Flow Error step. Remove the __error__ exits and processError flags to simplify the canvas: ${redundant.join(', ')}`,
          'Remove __error__ exits and set processError: false on these steps — the global error handler already catches their errors',
          { steps: redundant, globalProcessErrorStepId: hfeTargetId }));
      }
    }
  }

  // Check for __error__ exits targeting multiple distinct non-empty handler steps.
  // Consistent routing means all __error__ exits should point to the same handler
  // (or to empty steps for intentional termination in post-error paths).
  for (const [treeName, stepsMap] of Object.entries(stepsByTree)) {
    if (!stepsMap) continue;
    const errorTargets = new Map();
    for (const [stepId, step] of stepsMap) {
      if (!step.data?.exits) continue;
      for (const exit of step.data.exits) {
        if (exit.id !== '__error__') continue;
        const targetId = exit.stepId;
        if (!targetId) continue;
        const target = stepsMap.get(targetId);
        if (target && target.type !== 'empty' && target.shape !== 'empty') {
          if (!errorTargets.has(targetId)) {
            errorTargets.set(targetId, { label: target.label || targetId.slice(0, 8), sources: [] });
          }
          errorTargets.get(targetId).sources.push(step.label || stepId.slice(0, 8));
        }
      }
    }
    if (errorTargets.size > 1) {
      const targetList = [...errorTargets.entries()].map(([id, t]) =>
        `"${t.label}" (${id.slice(0, 8)}, used by ${t.sources.length} step${t.sources.length > 1 ? 's' : ''})`
      ).join(', ');
      out.push(diag('INCONSISTENT_ERROR_EXIT_TARGETS', 'warning', `data.trees.${treeName}`,
        `__error__ exits in tree "${treeName}" point to ${errorTargets.size} different handler steps: ${targetList} — all __error__ exits should route to the same Handle Flow Error step for consistent error handling`,
        'Wire all __error__ exits to the single Handle Flow Error step referenced by globalProcessErrorStepId',
        { targets: Object.fromEntries(errorTargets) }));
    }
  }

  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step?.data) continue;

      if (step.data.processError === true) {
        const hasErrorExit = Array.isArray(step.data.exits) && step.data.exits.some(e => e.id === '__error__' || e.condition === 'processError');
        if (!hasErrorExit) {
          out.push(diag('STEP_PROCESS_ERROR_NO_EXIT', 'warning', `step ${step.id}`,
            `Step "${step.label || step.id}" has processError: true but no __error__ exit`,
            'Add an exit with id "__error__" and condition "processError"',
            { stepId: step.id }));
        }
      }

      if (step.data.processTimeout === true) {
        const hasTimeoutExit = Array.isArray(step.data.exits) && step.data.exits.some(e => e.id === '__timeout__' || e.condition === 'processTimeout');
        if (!hasTimeoutExit) {
          out.push(diag('STEP_PROCESS_TIMEOUT_NO_EXIT', 'warning', `step ${step.id}`,
            `Step "${step.label || step.id}" has processTimeout: true but no __timeout__ exit`,
            'Add an exit with id "__timeout__" and condition "processTimeout"',
            { stepId: step.id }));
        }
      }

      // Template defines __error__ exit but step doesn't enable processError.
      // When a global error handler exists, per-step error exits are optional
      // overrides — the global handler covers all unhandled errors.
      if (step.type && step.type !== 'empty') {
        const tpl = (flow.data.stepTemplates || []).find(t => t.id === step.type);
        if (tpl && Array.isArray(tpl.data?.exits)) {
          const tplHasErrorExit = tpl.data.exits.some(e => e.id === '__error__');
          const tplHasTimeoutExit = tpl.data.exits.some(e => e.id === '__timeout__');
          const stepExitIds = new Set((step.data.exits || []).map(e => e.id));
          const hasGlobalHandler = !!(flow.data?.meta?.globalProcessError && flow.data?.meta?.globalProcessErrorStepId);

          if (tplHasErrorExit && step.data.processError !== true) {
            const severity = hasGlobalHandler ? 'info' : 'error';
            out.push(diag('STEP_ERROR_EXIT_NOT_ENABLED', severity, `step ${step.id}`,
              hasGlobalHandler
                ? `Step "${step.label || step.id}" could enable local error handling (processError) for template "${tpl.label}", but the global error handler already covers it`
                : `Step "${step.label || step.id}" uses template "${tpl.label}" which defines an __error__ exit, but processError is not enabled — errors will be unhandled (no global error handler)`,
              hasGlobalHandler
                ? 'Optional: set data.processError = true to override global error handling for this step'
                : 'Set data.processError = true on the step to enable the __error__ exit',
              { stepId: step.id, templateId: tpl.id }));
          }
          if (tplHasErrorExit && !stepExitIds.has('__error__')) {
            const severity = hasGlobalHandler ? 'info' : 'error';
            out.push(diag('STEP_ERROR_EXIT_NOT_WIRED', severity, `step ${step.id}`,
              hasGlobalHandler
                ? `Step "${step.label || step.id}" has no local __error__ exit — errors are handled by the global error handler`
                : `Step "${step.label || step.id}" uses template "${tpl.label}" which defines an __error__ exit, but it is not wired — errors will be unhandled (no global error handler)`,
              hasGlobalHandler
                ? 'Optional: add an __error__ exit to handle errors locally instead of globally'
                : 'Add an __error__ exit on this step and connect it to an error-handling step',
              { stepId: step.id, templateId: tpl.id }));
          }
          if (tplHasTimeoutExit && step.data.processTimeout !== true) {
            out.push(diag('STEP_TIMEOUT_EXIT_NOT_ENABLED', 'info', `step ${step.id}`,
              `Step "${step.label || step.id}" uses template "${tpl.label}" which defines a __timeout__ exit, but processTimeout is not enabled`,
              'Set data.processTimeout = true on the step to enable the __timeout__ exit',
              { stepId: step.id, templateId: tpl.id }));
          }

          // Template→instance processTimeout desync
          if (tpl.data?.processTimeout === true && step.data.processTimeout !== true) {
            out.push(diag('STEP_TIMEOUT_DESYNC', 'warning', `step ${step.id}`,
              `Template "${tpl.label}" has processTimeout: true but step "${step.label || step.id}" has it disabled — the step will not honour the template's timeout and no __timeout__ exit will fire`,
              'Set data.processTimeout = true on the step instance to match its template',
              { stepId: step.id, templateId: tpl.id }));
          }

          // Template→instance timeoutDuration desync
          if (tpl.data?.processTimeout === true && tpl.data?.timeoutDuration && !step.data?.timeoutDuration) {
            out.push(diag('STEP_TIMEOUT_DURATION_DESYNC', 'warning', `step ${step.id}`,
              `Template "${tpl.label}" defines timeoutDuration "${tpl.data.timeoutDuration}" but step "${step.label || step.id}" has none — the step will fall back to the flow-level default timeout instead of the template's intended duration`,
              `Set data.timeoutDuration to "${tpl.data.timeoutDuration}" on the step instance`,
              { stepId: step.id, templateId: tpl.id, templateDuration: tpl.data.timeoutDuration }));
          }

          // Partial exit mismatch: template defines exits the step doesn't have
          const stepExitLabels = new Set((step.data.exits || []).map(e => (e.label || '').toLowerCase()));
          const tplCode = tpl.template || '';
          for (const tplExit of tpl.data.exits) {
            const eid = tplExit.id;
            if (eid === '__error__' || eid === '__timeout__') continue;
            if (tplExit.condition && !isExitConditionMet(tplExit.condition, step.data)) continue;
            const tplLabel = (tplExit.label || eid).toLowerCase();
            if (!stepExitIds.has(eid) && !stepExitLabels.has(tplLabel)) {
              const codeCallsExit = new RegExp(`exitStep\\s*\\(\\s*['"]${eid}['"]`).test(tplCode);
              const severity = codeCallsExit ? 'error' : 'warning';
              out.push(diag('STEP_MISSING_TEMPLATE_EXIT', severity, `step ${step.id}`,
                `Step "${step.label || step.id}" is missing exit "${tplExit.label || eid}" defined by template "${tpl.label}"` +
                (codeCallsExit
                  ? ` — the template code calls this.exitStep('${eid}') which will throw "Invalid exit" at runtime`
                  : ` — this leg is unhandled`),
                `Add an exit with id "${eid}" and connect it to the appropriate next step`,
                { stepId: step.id, templateId: tpl.id, exitId: eid, codeCallsExit }));
            }
          }

          // Reverse check: step has exits the template doesn't define.
          // Gateways generate exits from httpMethods config; templates
          // with exitDynamic allow arbitrary user-defined exits.
          const SYSTEM_EXITS = new Set(['__error__', '__timeout__']);
          const tplExitIds = new Set(tpl.data.exits.map(e => e.id));
          const hasDynamicExits = Array.isArray(tpl.formBuilder?.stepExits) &&
            tpl.formBuilder.stepExits.some(e => e.component === 'exitDynamic' || /^dynamic/i.test(e.data?.id || ''));

          if (!hasDynamicExits) {
            let validExitIds = tplExitIds;

            if (tpl.isGatewayStep || step.isGatewayStep) {
              const methods = step.data?.httpMethods || tpl.data?.httpMethods || [];
              validExitIds = new Set([...tplExitIds, ...methods.map(m => String(m).toLowerCase())]);
            }

            for (const exit of (step.data.exits || [])) {
              if (SYSTEM_EXITS.has(exit.id)) continue;
              if (validExitIds.has(exit.id)) continue;
              // Check by label too (some exits match by label not id)
              const exitLabel = (exit.label || '').toLowerCase();
              const tplHasLabel = tpl.data.exits.some(e =>
                (e.label || '').toLowerCase() === exitLabel || e.id === exitLabel
              );
              if (tplHasLabel) continue;

              out.push(diag('STEP_EXIT_NOT_IN_TEMPLATE', 'error', `step ${step.id}`,
                `Step "${step.label || step.id}" has exit "${exit.label || exit.id}" (id="${exit.id}") which is not defined by template "${tpl.label}" — this exit will never fire because the template code does not call exitStep('${exit.id}')`,
                `Remove exit "${exit.id}" or add it to the template's data.exits array`,
                { stepId: step.id, templateId: tpl.id, exitId: exit.id, validExits: [...validExitIds].filter(e => !SYSTEM_EXITS.has(e)) }));
            }
          }
        }
      }
    }
  }

  // Step timeoutDuration vs flow deploy.timeout comparison
  const deployTimeout = flow.data?.deploy?.timeout;
  function parseTimeoutSec(raw) {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'object' && raw !== null && raw.input) return parseTimeoutSec(raw.input);
    if (typeof raw !== 'string') return null;
    const unquoted = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
    const secMatch = unquoted.match(/^(\d+)\s*(?:sec|s|seconds?)$/i);
    const minMatch = unquoted.match(/^(\d+)\s*(?:min|m|minutes?)$/i);
    if (secMatch) return parseInt(secMatch[1], 10);
    if (minMatch) return parseInt(minMatch[1], 10) * 60;
    if (/^\d+$/.test(unquoted)) return parseInt(unquoted, 10);
    return null;
  }
  if (deployTimeout !== null && deployTimeout !== undefined) {
    const flowTimeoutSec = Number(deployTimeout);
    if (!isNaN(flowTimeoutSec) && flowTimeoutSec > 0) {
      for (const tree of Object.values(flow.data.trees)) {
        if (!tree?.steps) continue;
        for (const step of tree.steps) {
          if (!step?.data?.timeoutDuration) continue;
          const stepTimeoutSec = parseTimeoutSec(step.data.timeoutDuration);
          if (stepTimeoutSec === null) continue;
          const stepLabel = step.label || step.id;

          if (stepTimeoutSec > flowTimeoutSec) {
            out.push(diag('STEP_TIMEOUT_EXCEEDS_FLOW', 'error', `step ${step.id}`,
              `Step "${stepLabel}" has timeoutDuration ~${stepTimeoutSec}s which exceeds the flow deploy.timeout of ${flowTimeoutSec}s — the flow will kill the Lambda before the step timeout fires, so the step can never time out gracefully`,
              `Either reduce step timeoutDuration to less than ${flowTimeoutSec}s, or increase data.deploy.timeout to at least ${stepTimeoutSec + 10}s`,
              { stepId: step.id, stepTimeout: stepTimeoutSec, flowTimeout: flowTimeoutSec }));
          } else if (stepTimeoutSec > flowTimeoutSec * 0.9) {
            const margin = flowTimeoutSec - stepTimeoutSec;
            out.push(diag('STEP_TIMEOUT_TIGHT_MARGIN', 'warning', `step ${step.id}`,
              `Step "${stepLabel}" has timeoutDuration ~${stepTimeoutSec}s which is within ${margin}s of the flow deploy.timeout (${flowTimeoutSec}s) — there is almost no margin for the timeout exit to execute and for downstream error handling before the flow is killed`,
              `Reduce step timeoutDuration to leave at least 10-15s margin (e.g., "${flowTimeoutSec - 15} sec"), or increase data.deploy.timeout`,
              { stepId: step.id, stepTimeout: stepTimeoutSec, flowTimeout: flowTimeoutSec, margin }));
          }

          if (stepTimeoutSec > 900) {
            out.push(diag('STEP_TIMEOUT_EXCEEDS_LAMBDA', 'error', `step ${step.id}`,
              `Step "${stepLabel}" has timeoutDuration ~${stepTimeoutSec}s which exceeds the absolute Lambda maximum of 900s — the step can never reach this timeout`,
              'Reduce timeoutDuration to 900 seconds or less',
              { stepId: step.id, stepTimeout: stepTimeoutSec, lambdaMax: 900 }));
          }
        }
      }
    }
  }

  // Step has processTimeout but template missing defaultTimeout in formBuilder
  const tplList = Array.isArray(flow.data.stepTemplates) ? flow.data.stepTemplates : [];
  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step?.data?.processTimeout) continue;
      const tpl = tplList.find(t => t.id === step.type);
      if (!tpl?.formBuilder?.hasProcessTimeout) continue;
      if (!tpl.formBuilder.defaultTimeout) {
        out.push(diag('STEP_TIMEOUT_NO_DEFAULT_IN_TEMPLATE', 'warning', `step ${step.id}`,
          `Step "${step.label || step.id}" uses template "${tpl.label}" with hasProcessTimeout: true but no formBuilder.defaultTimeout — the "Default timeout" field in the Design tab is empty`,
          'Set formBuilder.defaultTimeout on the template (e.g., "`30 sec`") so the Design tab shows a pre-filled value',
          { stepId: step.id, templateId: tpl.id }));
      }
    }
  }

  function isSendResponseStep(step) {
    if (KNOWN_INFRA_TPL_IDS.has(step?.type) && /send.*http.*response/i.test(step?.label || '')) return true;
    if (step?.type === 'f08d2d37-8047-400e-aa94-e3f6e3435b1b') return true;
    const tpl = (flow.data.stepTemplates || []).find(t => t.id === step?.type);
    return tpl && /send.*http.*response/i.test(tpl.label || '');
  }

  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step || !isSendResponseStep(step)) continue;
      const exits = step.data?.exits || [];
      const hasNext = exits.some(e => e.id === 'next' && e.stepId);
      if (!hasNext) {
        out.push(diag('SEND_RESPONSE_MISSING_NEXT_EXIT', 'error', `step ${step.id}`,
          `Send HTTP Response step "${step.label || step.id}" has no 'next' exit — the template always calls exitStep('next') which will throw "Invalid exit" and loop through the error handler`,
          'Add a next exit pointing to an empty termination step',
          { stepId: step.id }));
      }
    }
  }

  // Exits targeting empty steps — check all exit types, not just error/timeout
  const allStepMap = new Map();
  const tplMap = new Map();
  for (const tpl of (flow.data.stepTemplates || [])) {
    if (tpl?.id) tplMap.set(tpl.id, tpl);
  }
  for (const [_treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (step?.id) allStepMap.set(step.id, step);
    }
  }

  const TERMINAL_LABELS = new Set(['send http response', 'send response', 'end flow', 'terminate',
    'set value to a storage', 'get value from a storage']);
  function isTerminalStep(step) {
    if (!step || step.type === 'empty') return true;
    const label = (step.label || '').toLowerCase();
    for (const term of TERMINAL_LABELS) {
      if (label.includes(term)) return true;
    }
    const tpl = tplMap.get(step.type);
    if (tpl) {
      const tplLabel = (tpl.label || '').toLowerCase();
      for (const term of TERMINAL_LABELS) {
        if (tplLabel.includes(term)) return true;
      }
    }
    return false;
  }

  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step?.data?.exits) continue;
      for (const exit of step.data.exits) {
        const targetId = exit.stepId || exit.targetStepId;
        if (!targetId) continue;
        const target = allStepMap.get(targetId);
        if (target && target.type === 'empty') {
          const exitLabel = (exit.label || exit.id || '').toLowerCase();
          const isError = exitLabel.includes('error') || exit.id === '__error__' || exit.condition === 'processError';
          const isTimeout = exitLabel.includes('timeout') || exit.id === '__timeout__' || exit.condition === 'processTimeout';

          if (isError && !isTerminalStep(step)) {
            out.push(diag('ERROR_EXIT_TO_EMPTY_STEP', 'warning', `step ${step.id}`,
              `Step "${step.label || step.id}" error exit "${exit.label || exit.id}" targets an empty step — errors will be silently swallowed`,
              'Connect the error exit to a step that logs or handles the error (e.g. Send HTTP Response with error details)',
              { stepId: step.id, exitId: exit.id, targetStepId: targetId }));
          } else if (isTimeout) {
            out.push(diag('TIMEOUT_EXIT_TO_EMPTY_STEP', 'warning', `step ${step.id}`,
              `Step "${step.label || step.id}" timeout exit "${exit.label || exit.id}" targets an empty step — timeouts will be silently swallowed`,
              'Connect the timeout exit to a step that handles the timeout (e.g. send a 408 response)',
              { stepId: step.id, exitId: exit.id, targetStepId: targetId }));
          } else if (!isTerminalStep(step)) {
            out.push(diag('EXIT_TO_DEAD_END', 'warning', `step ${step.id}`,
              `Step "${step.label || step.id}" exit "${exit.label || exit.id}" leads to an empty step — this leg goes nowhere and the result is discarded`,
              'Connect this exit to a step that processes the result, or remove the exit if this path is intentionally unused',
              { stepId: step.id, exitId: exit.id, targetStepId: targetId }));
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 9 — Structural best practices
// ---------------------------------------------------------------------------
function passStructuralBestPractices(flow, allStepIds, stepsByTree, out) {
  const meta = flow.data.meta || {};

  // 9a. Flow MUST have a global error handler step — it catches all unhandled
  // errors across the flow. Individual steps can optionally override with local
  // __error__ exits, but the global handler is the required safety net.
  if (!meta.globalProcessError && !meta.globalProcessErrorStepId) {
    out.push(diag('NO_ERROR_HANDLER', 'error', 'data.meta',
      'Flow has no global error handler — unhandled errors will crash the flow silently. Every flow must have a Handle Flow Error step.',
      'Add a "Handle Flow Error" step and set data.meta.globalProcessError = true and data.meta.globalProcessErrorStepId to its id'));
  }

  // 9b. Flow should have a label
  if (!flow.data.label) {
    out.push(diag('FLOW_MISSING_LABEL', 'warning', 'data.label',
      'Flow has no label — it will appear unnamed in Edison',
      'Set data.label to a descriptive name'));
  }

  // 9c. Gateway step checks
  const mainSteps = flow.data.trees.main?.steps || [];
  const gatewaySteps = mainSteps.filter(s => s?.isGatewayStep === true);
  const gatewayTemplates = (flow.data.stepTemplates || []).filter(t => t?.isGatewayStep === true);
  const gatewayByTemplate = mainSteps.filter(s => s?.type && gatewayTemplates.some(t => t.id === s.type));
  const allGateways = new Set([...gatewaySteps.map(s => s.id), ...gatewayByTemplate.map(s => s.id)].filter(Boolean));

  if (allGateways.size === 0) {
    out.push(diag('NO_GATEWAY_STEP', 'info', 'data.trees.main',
      'Flow has no gateway/trigger step — it may not be invocable via HTTP or other triggers',
      'Add a trigger step (e.g., Http Gateway) as the first step if this flow needs external invocation'));
  } else if (mainSteps.length > 0 && mainSteps[0]?.id && !allGateways.has(mainSteps[0].id)) {
    const firstIsErrorHandler = mainSteps[0].id === meta.globalProcessErrorStepId;
    if (!firstIsErrorHandler) {
      out.push(diag('GATEWAY_NOT_FIRST_STEP', 'info', 'data.trees.main.steps[0]',
        `First step in main tree is "${mainSteps[0].label || mainSteps[0].id}" — the gateway/trigger step is typically steps[0]`,
        'Consider moving the gateway step to position 0 in the main tree steps array',
        { firstStepId: mainSteps[0].id, gatewayStepIds: [...allGateways] }));
    }
  }

  // 9c-2. HTTP path configuration check on gateway steps
  for (const gwId of allGateways) {
    const gwStep = mainSteps.find(s => s.id === gwId);
    if (!gwStep) continue;

    const pathFromData = gwStep.data?.path;
    const pathFromInput = gwStep.stepInputData?.path;
    const effectivePath = pathFromInput || pathFromData;

    if (!effectivePath || effectivePath === '``' || effectivePath === '' || effectivePath === 'undefined') {
      out.push(diag('GATEWAY_HTTP_PATH_MISSING', 'warning', `step ${gwStep.id}`,
        `Gateway step "${gwStep.label || gwStep.id}" has no HTTP path configured — the flow will not be reachable via HTTP. ` +
        `This commonly happens when cloning a flow without updating the gateway path.`,
        'Set data.path (and stepInputData.path) to a backtick-wrapped path, e.g. `my-api-path`',
        { stepId: gwStep.id }));
    } else {
      const cleanPath = String(effectivePath).replace(/^`|`$/g, '').trim();
      const flowLabel = flow.data.label || '';

      if (cleanPath === 'new-api' || cleanPath === 'test-path') {
        out.push(diag('GATEWAY_HTTP_PATH_PLACEHOLDER', 'warning', `step ${gwStep.id}`,
          `Gateway step "${gwStep.label || gwStep.id}" has placeholder HTTP path "${cleanPath}" — ` +
          `this is a default from cloning and likely needs to be changed to a unique, descriptive path for "${flowLabel}"`,
          `Change data.path to a unique path that describes this flow's purpose, e.g. \`${flowLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-flow'}\``,
          { stepId: gwStep.id, currentPath: cleanPath, flowLabel }));
      }

      if (cleanPath && !/^[a-z0-9][a-z0-9._/-]*$/i.test(cleanPath)) {
        out.push(diag('GATEWAY_HTTP_PATH_INVALID_CHARS', 'warning', `step ${gwStep.id}`,
          `Gateway step "${gwStep.label || gwStep.id}" HTTP path "${cleanPath}" contains unusual characters — paths should use lowercase alphanumeric, hyphens, and slashes`,
          `Rename the path to use only lowercase letters, numbers, hyphens, and slashes`,
          { stepId: gwStep.id, currentPath: cleanPath }));
      }
    }
  }

  // 9d. Tree position checks (Data Hub: position is required)
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree) continue;
    if (!tree.position || typeof tree.position !== 'object') {
      out.push(diag('TREE_MISSING_POSITION', 'info', `data.trees.${treeName}.position`,
        `Tree "${treeName}" has no position — canvas viewport may default to origin`,
        'Add position: { x: 0, y: 0 }',
        { tree: treeName }));
    }
  }

  // 9e. Gateway step shape enforcement (step-builder: isGatewayStep forces arrow-down)
  const tplArr = flow.data.stepTemplates || [];
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step) continue;
      const isGw = step.isGatewayStep === true || tplArr.some(t => t.id === step.type && t.isGatewayStep === true);
      if (isGw && step.shape && step.shape !== 'arrow-down') {
        out.push(diag('GATEWAY_STEP_WRONG_SHAPE', 'warning', `step ${step.id}`,
          `Gateway step "${step.label || step.id}" has shape "${step.shape}" — gateway steps should use "arrow-down"`,
          'Set shape to "arrow-down" for gateway steps (the Step Builder enforces this)',
          { stepId: step.id, tree: treeName, shape: step.shape }));
      }
    }
  }

  // 9f. Steps missing fields (non-empty, non-error-handler)
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step || step.type === 'empty') continue;

      if (!step.icon) {
        out.push(diag('STEP_MISSING_ICON', 'info', `step ${step.id}`,
          `Step "${step.label || step.id}" has no icon — it may render as a blank node on the canvas`,
          'Set icon to a valid icon name (e.g., "http", "code", "error", "add")',
          { stepId: step.id, tree: treeName }));
      }
      if (!step.shape) {
        out.push(diag('STEP_MISSING_SHAPE', 'info', `step ${step.id}`,
          `Step "${step.label || step.id}" has no shape — canvas will use default rendering`,
          'Set shape to one of: circle, rectangle, hexagon, arrow-down, diamond, empty',
          { stepId: step.id, tree: treeName }));
      }

      // Data Hub: iconType must be 'default' or 'custom'
      if (step.iconType !== null && step.iconType !== undefined && step.iconType !== '' && !VALID_ICON_TYPES.has(step.iconType)) {
        out.push(diag('STEP_INVALID_ICONTYPE', 'warning', `step ${step.id}`,
          `Step "${step.label || step.id}" has iconType "${step.iconType}" — must be "default" or "custom"`,
          'Set iconType to "default" or "custom"',
          { stepId: step.id, tree: treeName }));
      }

      if (step.iconType === 'custom' && !step.iconUrl) {
        out.push(diag('STEP_CUSTOM_ICON_NO_URL', 'warning', `step ${step.id}`,
          `Step "${step.label || step.id}" has iconType "custom" but no iconUrl`,
          'Set iconUrl to a URL or data URI pointing to the custom icon (PNG/SVG)',
          { stepId: step.id, tree: treeName }));
      }

      if (step.iconUrl && typeof step.iconUrl === 'string' && step.iconUrl.trim() !== '') {
        const isHttpUrl = /^https?:\/\/.+/.test(step.iconUrl);
        const isDataUri = /^data:image\/(png|svg\+xml|jpeg|gif)[;,]/.test(step.iconUrl);
        if (!isHttpUrl && !isDataUri) {
          out.push(diag('STEP_INVALID_ICON_URL', 'warning', `step ${step.id}`,
            `Step "${step.label || step.id}" iconUrl is not a valid URL or data URI`,
            'Set iconUrl to an https:// URL or a data:image/... URI',
            { stepId: step.id, tree: treeName }));
        }
        if (step.iconType !== 'custom') {
          out.push(diag('STEP_ICONURL_IGNORED', 'warning', `step ${step.id}`,
            `Step "${step.label || step.id}" has iconUrl but iconType is not "custom" — URL will be ignored`,
            'Set iconType to "custom" to use the custom icon URL',
            { stepId: step.id, tree: treeName }));
        }
      }

      if (step.data && Array.isArray(step.data.exits)) {
        step.data.exits.forEach((exit, ei) => {
          if (exit.stepId && !isUUID(exit.stepId)) {
            out.push(diag('EXIT_STEPID_NOT_UUID', 'error',
              `data.trees.${treeName}.steps[].data.exits[${ei}].stepId`,
              `Exit "${exit.label || exit.id}" has stepId "${exit.stepId}" which is not a valid UUID`,
              'Set stepId to a valid UUID referencing a step in this tree',
              { stepId: step.id, exitStepId: exit.stepId }));
          }
          if (!exit.stepId && !exit.targetStepId) {
            out.push(diag('EXIT_MISSING_STEPID', 'error',
              `data.trees.${treeName}.steps[].data.exits[${ei}]`,
              `Exit "${exit.label || exit.id}" on step "${step.label || step.id}" has no stepId — the Edison Lambda runtime Joi schema requires stepId on every exit and will crash at init with "exits[n].stepId is required"`,
              'Set stepId to a valid step UUID. To create an unwired exit, point it to an empty step (type: "empty") instead of deleting stepId',
              { stepId: step.id, exitId: exit.id }));
          }

          if (exit.hasOwnProperty('target')) {
            out.push(diag('EXIT_HAS_TARGET_PROPERTY', 'error',
              `data.trees.${treeName}.steps[].data.exits[${ei}].target`,
              `Exit "${exit.label || exit.id}" on step "${step.label || step.id}" has a "target" property — the Edison runtime Joi schema only allows "stepId", not "target". This causes a fatal ValidationError at Lambda init: "exits[${ei}].target is not allowed"`,
              'Delete the "target" property from the exit object. Use "stepId" for the target step reference.',
              { stepId: step.id, exitId: exit.id, targetValue: exit.target }));
          }
        });
      }

      // dataOut name should not be empty if dataOutLabelConnected is set
      if (step.dataOutLabelConnected === true && (!step.data?.dataOut || !step.data.dataOut.name)) {
        out.push(diag('DATAOUT_CONNECTED_BUT_UNNAMED', 'info', `step ${step.id}`,
          `Step "${step.label || step.id}" has dataOutLabelConnected but no dataOut.name — output won't be accessible via merge fields`,
          'Set data.dataOut.name to a merge field name',
          { stepId: step.id }));
      }
    }
  }

  // 9e. Exit condition validation
  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step?.data?.exits) continue;
      for (const exit of step.data.exits) {
        if (exit.condition && typeof exit.condition === 'object') {
          if (!exit.condition.trueValue || !['any', 'all'].includes(exit.condition.trueValue)) {
            out.push(diag('EXIT_CONDITION_INVALID_TRUEVALUE', 'warning',
              `step ${step.id} exit ${exit.id}`,
              `Exit condition trueValue must be "any" or "all", got "${exit.condition.trueValue}"`,
              'Set condition.trueValue to "any" or "all"',
              { stepId: step.id, exitId: exit.id }));
          }
          if (exit.condition.defaultValue !== true && exit.condition.defaultValue !== false) {
            out.push(diag('EXIT_CONDITION_INVALID_DEFAULT', 'warning',
              `step ${step.id} exit ${exit.id}`,
              `Exit condition defaultValue must be a boolean, got ${typeof exit.condition.defaultValue}`,
              'Set condition.defaultValue to true or false',
              { stepId: step.id, exitId: exit.id }));
          }
        }
      }
    }
  }

  // 9f. Template step instances should have data fields matching template defaults
  const templates = flow.data.stepTemplates || [];
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step || step.type === 'empty' || !step.data) continue;
      const tpl = templates.find(t => t.id === step.type);
      if (!tpl || !tpl.data) continue;

      // If template defines exits but step has none
      if (Array.isArray(tpl.data.exits) && tpl.data.exits.length > 0) {
        if (!Array.isArray(step.data.exits) || step.data.exits.length === 0) {
          out.push(diag('STEP_MISSING_TEMPLATE_EXITS', 'warning',
            `data.trees.${treeName} step ${step.id}`,
            `Step "${step.label || step.id}" has no exits but its template "${tpl.label}" defines ${tpl.data.exits.length} exit(s)`,
            `Add exits matching the template: ${tpl.data.exits.map(e => e.id || e.label).join(', ')}`,
            { stepId: step.id, templateId: tpl.id, templateExits: tpl.data.exits.map(e => e.id) }));
        }
      }

      // Template says hasDataOut but step has no dataOut configured (skip error handler)
      const errorHandlerStepId = flow.data?.meta?.globalProcessErrorStepId;
      if (tpl.formBuilder?.hasDataOut === true && (!step.data?.dataOut || !step.data.dataOut.name) && step.id !== errorHandlerStepId) {
        out.push(diag('STEP_MISSING_DATAOUT', 'warning',
          `step ${step.id}`,
          `Template "${tpl.label}" expects dataOut (hasDataOut: true) but step "${step.label || step.id}" has no data.dataOut.name — the step's output won't be accessible via merge fields`,
          'Set data.dataOut to { name: "variableName", type: "session" }',
          { stepId: step.id, templateId: tpl.id }));
      }

      if (tpl.data.processError === true && step.data.processError !== true) {
        out.push(diag('STEP_TEMPLATE_ERROR_HANDLING_MISMATCH', 'info',
          `step ${step.id}`,
          `Template "${tpl.label}" has processError: true but step "${step.label || step.id}" does not — per-step error handling is disabled`,
          'Set data.processError = true and add an __error__ exit if you want step-level error handling',
          { stepId: step.id, templateId: tpl.id }));
      }

      // Template defines UI inputs but step instance has empty stepInputData.
      // Values can live in step.stepInputData (new form system) OR step.data
      // (legacy/direct config). Check both before flagging as missing.
      const formVars = extractFormVariables(tpl.formBuilder);
      const formInputs = formVars.map(v => v.variable);
      if (formInputs.length > 0) {
        const sid = step.stepInputData || {};
        const sd = step.data || {};
        const instanceKeys = Object.keys(sid).filter(k => k && k !== '' && k !== 'undefined');
        const dataKeys = Object.keys(sd).filter(k => k && k !== '' && k !== 'undefined');
        const _allKeys = new Set([...instanceKeys, ...dataKeys]);

        function hasValue(variable) {
          if (instanceKeys.includes(variable) && !isEmptyValue(sid[variable])) return true;
          if (dataKeys.includes(variable) && !isEmptyValue(sd[variable])) return true;
          return false;
        }

        if (instanceKeys.length === 0 && formInputs.every(v => !dataKeys.includes(v) || isEmptyValue(sd[v]))) {
          out.push(diag('STEP_EMPTY_INPUT_DATA', 'error', `step ${step.id}`,
            `Step "${step.label || step.id}" has no stepInputData but template "${tpl.label}" defines ${formInputs.length} input(s): ${formInputs.join(', ')} — the step UI will be blank and the step will receive no configured values`,
            `Populate stepInputData with values for: ${formInputs.join(', ')}`,
            { stepId: step.id, templateId: tpl.id, expectedInputs: formInputs }));
        } else {
          const missing = formInputs.filter(v => !hasValue(v));
          const requiredVars = formVars
            .filter(v => v.required)
            .filter(v => {
              if (!v.parentListVar) return true;
              const listVal = sd[v.parentListVar] ?? sid[v.parentListVar];
              if (Array.isArray(listVal) && listVal.length === 0) return false;
              return true;
            })
            .map(v => v.variable);
          const missingRequired = missing.filter(v => requiredVars.includes(v));
          if (missingRequired.length > 0) {
            out.push(diag('STEP_MISSING_REQUIRED_INPUTS', 'error', `step ${step.id}`,
              `Step "${step.label || step.id}" is missing or has empty required input(s): ${missingRequired.join(', ')} — these are marked validateRequired by template "${tpl.label}" and the step will appear invalid (red) in the UI`,
              `Add non-empty stepInputData entries for: ${missingRequired.join(', ')}`,
              { stepId: step.id, templateId: tpl.id, missingRequired }));
          }
          if (missing.length > missingRequired.length) {
            const GW_AUTH_FIELDS = new Set(['userpassTable', 'tokenTable', 'allowedUserIdList',
              'allowedAccountIdList', 'tokenTableAdditionalOptions', 'accountId', 'userId']);
            const BENIGN_OPTIONAL = new Set(['value', 'thread', 'httpMethod']);
            const missingOptional = missing.filter(v => !requiredVars.includes(v))
              .filter(v => !(step.isGatewayStep && GW_AUTH_FIELDS.has(v)))
              .filter(v => !BENIGN_OPTIONAL.has(v));
            if (missingOptional.length === 0) continue;
            out.push(diag('STEP_MISSING_OPTIONAL_INPUTS', 'warning', `step ${step.id}`,
              `Step "${step.label || step.id}" is missing optional input(s): ${missingOptional.join(', ')} from template "${tpl.label}" — these will use template defaults`,
              `Consider adding stepInputData entries for: ${missingOptional.join(', ')}`,
              { stepId: step.id, templateId: tpl.id, missingOptional }));
          }
        }
      }

      // Check auth-external-component inputs: if the template has an auth
      // component, the step must have the corresponding credential reference
      // in stepInputData. An unconfigured auth dropdown means the step can't
      // authenticate at runtime.
      if (tpl?.formBuilder?.stepInputs && !step.isGatewayStep) {
        for (const inp of tpl.formBuilder.stepInputs) {
          const comp = Array.isArray(inp.component) ? inp.component[0] : inp.component;
          if (comp !== 'auth-external-component') continue;
          const fieldName = inp.data?.fieldList?.[0]?.fieldName || inp.data?.variableName || 'auth';
          const collection = inp.data?.keyValueCollection || '';
          const sidVal = step.stepInputData?.[fieldName];
          const dataVal = step.data?.[fieldName];
          const hasValue = (sidVal && typeof sidVal === 'string' && sidVal.replace(/^`|`$/g, '').trim().length > 0)
            || (dataVal && typeof dataVal === 'string' && dataVal.trim().length > 0);
          if (!hasValue) {
            out.push(diag('AUTH_NOT_CONFIGURED', 'error', `step ${step.id}.stepInputData.${fieldName}`,
              `Step "${step.label || step.id}" has an auth-external-component (collection: "${collection}") but no credential is selected — ` +
              `the authorization dropdown is empty and the step will fail at runtime when it tries to authenticate`,
              `Select a credential in the auth dropdown on the canvas, or set stepInputData.${fieldName} to a credential reference (UUID::type::Label format)`,
              { stepId: step.id, templateId: tpl.id, fieldName, collection }));
          }
        }
      }

      // Check for empty/null/empty-backtick values in stepInputData
      if (step.stepInputData && typeof step.stepInputData === 'object') {
        for (const [key, value] of Object.entries(step.stepInputData)) {
          if (key === 'processError' || key === 'processTimeout') continue;
          if (isEmptyValue(value)) {
            const isRequired = formVars.some(v => v.variable === key && v.required);
            const severity = 'error';
            const desc = value === '' ? 'empty string' :
              (value === null || value === undefined) ? String(value) :
              `empty backtick expression: ${value}`;
            out.push(diag('STEP_INPUT_EMPTY_VALUE', severity, `step ${step.id}`,
              `Step "${step.label || step.id}" input "${key}" is ${desc}` +
              (isRequired ? ' — this field is marked required by the template and the step will appear invalid (red) in the UI' :
                ` — the compiler will produce undefined at runtime`),
              `Set a value for "${key}" using the merge field picker or a literal expression`,
              { stepId: step.id, key, templateId: tpl.id, isRequired }));
          }
        }
      }

      // Known infrastructure template critical input check
      const infraCheck = INFRA_CRITICAL_INPUTS[tpl.id];
      if (infraCheck) {
        const sid = step.stepInputData || {};
        const sidKeys = Object.keys(sid).filter(k => k && k !== 'processError' && k !== 'processTimeout');
        for (const req of infraCheck) {
          const inSid = sidKeys.includes(req) && !isEmptyValue(sid[req]);
          const inData = !isEmptyValue(step.data?.[req]);
          if (!inSid && !inData) {
            out.push(diag('STEP_INFRA_MISSING_CRITICAL_INPUT', 'error', `step ${step.id}`,
              `Step "${step.label || step.id}" (${tpl.label}) is missing critical input "${req}" — this infrastructure step will not function without it`,
              `Set stepInputData["${req}"] or data["${req}"] to the appropriate value`,
              { stepId: step.id, templateId: tpl.id, missingInput: req }));
          }
        }
      }

      // Wildcard-bound schema fields: check step.data for empty values.
      // Wildcard validators can be conditional (e.g. only when typeResponse='body'),
      // so we can't statically determine if the field will actually cause a red step.
      // Always emit as warning; INFRA_CRITICAL_INPUTS handles the known hard errors.
      const WILDCARD_SKIP = new Set(['useOneTable', 'autodetectedFromHttp',
        'stepVariable', 'outputDateSettings', 'codeLength', 'isCodeLength',
        'avoidAmbiguous', 'params', 'bits', 'valueOutputExample', 'outputData']);
      const wildcardBindings = extractWildcardSchemaBindings(tpl.formBuilder);
      for (const binding of wildcardBindings) {
        if (WILDCARD_SKIP.has(binding.field)) continue;
        const val = step.data?.[binding.field];
        if (isEmptyValue(val)) {
          const inSid = step.stepInputData && !isEmptyValue(step.stepInputData[binding.field]);
          if (!inSid) {
            out.push(diag('STEP_DATA_EMPTY_SCHEMA_FIELD', 'warning', `step ${step.id}`,
              `Step "${step.label || step.id}" has empty data.${binding.field} (value: ${JSON.stringify(val) || 'undefined'}) — ` +
              (binding.hasValidator
                ? 'the template has a validator for this field; the step may appear invalid (red) in the UI if the validator condition is met'
                : 'this field is bound via formWildcard; configure it if the step appears incomplete'),
              `Configure data.${binding.field} with a value or merge field expression`,
              { stepId: step.id, templateId: tpl.id, field: binding.field, hasValidator: binding.hasValidator }));
          }
        }
      }
    }
  }

  // 9g. dataOuts should have stepId, stepTemplateId, and outputExample
  const stepByIdAll = {};
  for (const stepsMap of Object.values(stepsByTree)) {
    if (stepsMap) for (const [id, step] of stepsMap) stepByIdAll[id] = step;
  }
  if (Array.isArray(meta.dataOuts)) {
    meta.dataOuts.forEach((d, i) => {
      if (d && d.name && !d.stepId) {
        out.push(diag('DATAOUT_MISSING_STEPID', 'info', `data.meta.dataOuts[${i}]`,
          `Merge field "${d.name}" has no stepId — autocomplete and tracing won't know which step produces it`,
          'Set stepId to the id of the step that writes to this merge field',
          { name: d.name }));
      }
      let resolvedTplId = d.stepTemplateId;
      if (!resolvedTplId && d.stepId) {
        const producer = stepByIdAll[d.stepId];
        if (producer && producer.type && producer.type !== 'empty') resolvedTplId = producer.type;
      }
      if (d && d.name && !resolvedTplId) {
        out.push(diag('DATAOUT_MISSING_TEMPLATE_ID', 'warning', `data.meta.dataOuts[${i}]`,
          `Merge field "${d.name}" has no stepTemplateId and could not be resolved from step list — the UI merge field picker cannot render output shape or connection indicators`,
          'Set stepTemplateId to the template id of the producing step',
          { name: d.name }));
      }
      if (d && d.name && (!d.outputExample || (typeof d.outputExample === 'object' && Object.keys(d.outputExample).length === 0))) {
        out.push(diag('DATAOUT_MISSING_OUTPUT_EXAMPLE', 'warning', `data.meta.dataOuts[${i}].outputExample`,
          `Merge field "${d.name}" has no outputExample — the UI cannot display data connections or autocomplete downstream fields`,
          'Add outputExample with example data shape (e.g., { "items": [], "total": 0 })',
          { name: d.name }));
      }

      // Stale outputExample: meta.dataOuts outputExample doesn't match template outputExample
      if (d && d.name && d.outputExample && typeof d.outputExample === 'object' && Object.keys(d.outputExample).length > 0) {
        const tplId = resolvedTplId;
        const tpl = tplId ? templates.find(t => t.id === tplId) : null;
        if (tpl && tpl.outputExample && typeof tpl.outputExample === 'object' && Object.keys(tpl.outputExample).length > 0) {
          const tplKeys = Object.keys(tpl.outputExample).sort();
          const metaKeys = Object.keys(d.outputExample).sort();
          if (JSON.stringify(tplKeys) !== JSON.stringify(metaKeys)) {
            out.push(diag('DATAOUT_OUTPUT_EXAMPLE_STALE', 'warning', `data.meta.dataOuts[${i}].outputExample`,
              `Merge field "${d.name}" outputExample keys [${metaKeys.join(', ')}] don't match template "${tpl.label || tpl.id}" outputExample keys [${tplKeys.join(', ')}] — the merge field picker will show stale or incorrect fields to downstream steps`,
              'Update the meta.dataOuts outputExample to match the template outputExample',
              { name: d.name, templateId: tplId, templateKeys: tplKeys, metaKeys }));
          }
        }
      }
    });
  }

  // 9h. Duplicate step labels within a tree
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    const labelCounts = new Map();
    for (const step of tree.steps) {
      if (!step || step.type === 'empty' || !step.label) continue;
      labelCounts.set(step.label, (labelCounts.get(step.label) || 0) + 1);
    }
    for (const [label, count] of labelCounts) {
      if (count > 1) {
        out.push(diag('DUPLICATE_STEP_LABEL', 'info', `data.trees.${treeName}`,
          `${count} steps share label "${label}" in tree "${treeName}" — this can make the canvas confusing`,
          'Give each step a unique label to distinguish them visually',
          { tree: treeName, label, count }));
      }
    }
  }

  // 9h-2. Async harness pattern: error response steps must write to KV storage.
  // In the async job pattern (POST → jobId, GET → poll), error/timeout response
  // steps must persist the error to KV so the polling client can see it.
  const KV_SET_TPL_ID = 'd042fa69-0da9-440b-90da-849d786ec514';
  const KV_GET_TPL_ID = '39c8bcee-82f4-453b-ac8d-c1677f9260e9';
  const allMainSteps = flow.data.trees.main?.steps || [];
  const allTemplates = flow.data.stepTemplates || [];
  const kvSetTplLabel = (allTemplates.find(t => t.id === KV_SET_TPL_ID) || {}).label || 'Set Value to a Storage';
  const kvSetTplIds = new Set(allTemplates.filter(t => t.label === kvSetTplLabel).map(t => t.id));
  kvSetTplIds.add(KV_SET_TPL_ID);
  const kvGetTplIds = new Set(allTemplates.filter(t =>
    t.id === KV_GET_TPL_ID || t.label === 'Get Value from a Storage'
  ).map(t => t.id));
  kvGetTplIds.add(KV_GET_TPL_ID);
  const hasKvPattern = allMainSteps.some(s => kvSetTplIds.has(s?.type)) &&
                       allMainSteps.some(s => kvGetTplIds.has(s?.type));
  if (hasKvPattern) {
    for (const errLabel of ['Timeout Error Response', 'Flow Error Response']) {
      const respStep = allMainSteps.find(s => s?.label === errLabel);
      if (!respStep) continue;
      const exits = respStep.data?.exits || [];
      const writesToKvDownstream = exits.some(e => {
        const target = allMainSteps.find(t => t.id === e.stepId);
        return target && kvSetTplIds.has(target?.type);
      });
      const hasKvUpstream = allMainSteps.some(s => {
        if (!s || !kvSetTplIds.has(s.type)) return false;
        return (s.data?.exits || []).some(e => e.stepId === respStep.id);
      });
      if (!writesToKvDownstream && !hasKvUpstream) {
        const _exitsToEmpty = exits.length === 0 || exits.every(e => {
          const target = allMainSteps.find(t => t.id === e.stepId);
          return !target || target.type === 'empty';
        });
        out.push(diag('ERROR_RESPONSE_NO_KV_WRITE', 'error', `step ${respStep.id}`,
          `"${errLabel}" does not write to KV storage — in the async job pattern, errors must be persisted so the polling GET endpoint can return them. Without this, failed jobs stay stuck at "job started" forever.`,
          `Wire "${errLabel}" → a KV Set step that stores { status: "error", error: mergeFields.handleFlowError.error.message }`,
          { stepId: respStep.id, label: errLabel, exitTargets: exits.map(e => e.stepId) }));
      }
    }
  }

  // 9h-3. dataOut.name should follow the step's label convention.
  // A stale dataOut.name (e.g. "stepTemplatePost" from a harness reference) can
  // make merge field references confusing and hard to debug.
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step || step.type === 'empty') continue;
      const doName = step.data?.dataOut?.name;
      if (!doName || !step.label) continue;
      const BUILTIN_RE = /gateway|http\s*re(quest|sponse)|send.*response|wait.*request|handle.*error|flow\s*error|random\s*code|key\s*value|storage|date\/?time|change.*format.*date|get.*date|timeout/i;
      if (BUILTIN_RE.test(step.label)) continue;
      const expectedName = step.label.replace(/[^a-zA-Z0-9 ]/g, '').trim()
        .replace(/\s+(\w)/g, (_, c) => c.toUpperCase())
        .replace(/^[A-Z]/, c => c.toLowerCase());
      if (expectedName && doName !== expectedName) {
        const similarity = doName.toLowerCase().includes(expectedName.slice(0, 5).toLowerCase()) ||
                           expectedName.toLowerCase().includes(doName.slice(0, 5).toLowerCase());
        if (!similarity) {
          out.push(diag('DATAOUT_NAME_MISMATCH', 'warning', `step ${step.id}`,
            `Step "${step.label}" writes to merge field "${doName}" but expected "${expectedName}" — stale merge field names from harness templates make downstream references confusing`,
            `Set data.dataOut.name to "${expectedName}" and update any merge field references`,
            { stepId: step.id, tree: treeName, actual: doName, expected: expectedName }));
        }
      }
    }
  }

  // 9h-4. KV collection consistency: SET and GET steps should use matching collections.
  // A common harness error is cloning from a reference flow where the GET step
  // still reads from the reference's collection while SETs write to a new one.
  const KV_SET_TPL_VAL = 'd042fa69-0da9-440b-90da-849d786ec514';
  const KV_GET_TPL_VAL = '39c8bcee-82f4-453b-ac8d-c1677f9260e9';
  const kvSetCollections = new Set();
  const kvGetCollections = new Set();
  for (const step of allMainSteps) {
    if (!step || step.type === 'empty') continue;
    const col = step.data?.collection || step.stepInputData?.collection;
    if (!col) continue;
    if (step.type === KV_SET_TPL_VAL) kvSetCollections.add(col);
    if (step.type === KV_GET_TPL_VAL) kvGetCollections.add(col);
  }
  if (kvSetCollections.size > 0 && kvGetCollections.size > 0) {
    for (const getCol of kvGetCollections) {
      if (!kvSetCollections.has(getCol)) {
        out.push(diag('KV_COLLECTION_MISMATCH', 'error', 'data.trees.main',
          `KV GET reads from collection ${getCol} but no KV SET writes to it — SET collections: ${[...kvSetCollections].join(', ')}. The GET will never find data written by SET steps.`,
          'Update the GET step collection to match the SET steps, or vice versa',
          { getCollections: [...kvGetCollections], setCollections: [...kvSetCollections] }));
      }
    }
  }

  // 9i. HTTP gateway output data structure validation
  // The flow builder UI uses three sources to populate the merge field picker:
  //   1. step.outputExample — step-instance-level example (highest priority)
  //   2. stepTemplate.outputExample — template-level example
  //   3. meta.dataOuts[].outputExample — flow-level merge field declarations
  //   4. step.data.outputData / step.data.bodyOutputData — JSON strings the UI
  //      displays in the "Output data structure" panel
  //   5. step.stepInputData.outputData / .bodyOutputData — the UI-bound copies
  // All five must be populated and consistent for the merge field picker to work.
  const mainStepsList = flow.data.trees.main?.steps || [];
  const gwStep = mainStepsList.find(s =>
    s?.type === HTTP_GATEWAY_TPL_ID ||
    s?.isGatewayStep === true ||
    /Http Gateway|Wait for HTTP/i.test(s?.label || ''));
  if (gwStep) {
    const gwTpl = templates.find(t => t.id === gwStep.type);
    const gwMfName = gwStep.data?.dataOut?.name;

    // Resolve the effective outputExample (step instance > template)
    const gwOutputExample = gwStep.outputExample || gwTpl?.outputExample;

    // Determine if the gateway accepts request bodies (POST/PUT/PATCH)
    const gwHttpMethods = gwStep.data?.httpMethods || [];
    const acceptsBody = Array.isArray(gwHttpMethods) &&
      gwHttpMethods.some(m => ['post', 'put', 'patch'].includes(String(m).toLowerCase()));

    // --- 9i-1. Check data.outputData (the JSON string shown in the UI) ---
    const rawOutputData = gwStep.data?.outputData;
    let parsedOutputData = null;
    if (rawOutputData && typeof rawOutputData === 'string') {
      try { parsedOutputData = JSON.parse(rawOutputData); } catch (_) { /* ignore */ }
    }

    if (!rawOutputData || rawOutputData === '""' || rawOutputData === '') {
      out.push(diag('GATEWAY_MISSING_OUTPUT_DATA', 'error', `step ${gwStep.id}`,
        `HTTP gateway step "${gwStep.label || gwStep.id}" has no data.outputData — the "Output data structure" field in the UI is empty and the merge field picker won't show any request fields`,
        'Set data.outputData to a JSON string describing the expected request shape: { "method": "POST", "path": "/...", "request": { "body": { ... }, "queryParams": { ... } } }',
        { stepId: gwStep.id }));
    } else if (parsedOutputData) {
      const parsedBody = parsedOutputData?.request?.body;
      const parsedQuery = parsedOutputData?.request?.queryParams;
      const parsedBodyEmpty = !parsedBody || Object.keys(parsedBody).length === 0;
      const parsedQueryEmpty = !parsedQuery || Object.keys(parsedQuery).length === 0;

      if (acceptsBody && parsedBodyEmpty) {
        out.push(diag('GATEWAY_OUTPUT_DATA_EMPTY_BODY', 'error', `step ${gwStep.id}`,
          `HTTP gateway step "${gwStep.label || gwStep.id}" data.outputData has empty request.body but accepts ${gwHttpMethods.join('/')} — the merge field picker will show the gateway variable but no body fields to select`,
          'Populate data.outputData with the expected body fields: { ..., "request": { "body": { "userId": "user-123", "action": "init" }, ... } }',
          { stepId: gwStep.id, gatewayMergeField: gwMfName }));
      } else if (parsedBodyEmpty && parsedQueryEmpty) {
        out.push(diag('GATEWAY_OUTPUT_DATA_EMPTY_FIELDS', 'warning', `step ${gwStep.id}`,
          `HTTP gateway step "${gwStep.label || gwStep.id}" data.outputData has empty request.body and request.queryParams — the merge field picker won't show any selectable request fields`,
          'Populate data.outputData request.queryParams (for GET) or request.body (for POST) with the expected fields',
          { stepId: gwStep.id, gatewayMergeField: gwMfName }));
      }
    }

    // --- 9i-2. Check data.bodyOutputData (body-only JSON string) ---
    const rawBodyData = gwStep.data?.bodyOutputData;
    let parsedBodyData = null;
    if (rawBodyData && typeof rawBodyData === 'string') {
      try { parsedBodyData = JSON.parse(rawBodyData); } catch (_) { /* ignore */ }
    }

    const outputDataBody = (() => {
      try { const od = JSON.parse(gwStep.data?.outputData || '{}'); return od?.request?.body; } catch { return null; }
    })();
    if (acceptsBody) {
      const hasOutputDataBody = outputDataBody && typeof outputDataBody === 'object' && Object.keys(outputDataBody).length > 0;
      if (!rawBodyData || rawBodyData === '"{}"' || rawBodyData === '{}' || rawBodyData === '') {
        if (!hasOutputDataBody) {
          out.push(diag('GATEWAY_MISSING_BODY_OUTPUT_DATA', 'warning', `step ${gwStep.id}`,
            `HTTP gateway step "${gwStep.label || gwStep.id}" accepts ${gwHttpMethods.join('/')} requests but data.bodyOutputData is empty and outputData.request.body has no fields — the request body fields won't appear in the merge field picker`,
            'Set data.bodyOutputData to a JSON string of the expected body, or define body fields in outputData.request.body',
            { stepId: gwStep.id, httpMethods: gwHttpMethods }));
        }
      } else if (parsedBodyData && typeof parsedBodyData === 'object' && Object.keys(parsedBodyData).length === 0) {
        out.push(diag('GATEWAY_BODY_OUTPUT_DATA_EMPTY', 'error', `step ${gwStep.id}`,
          `HTTP gateway step "${gwStep.label || gwStep.id}" accepts ${gwHttpMethods.join('/')} requests but data.bodyOutputData is "{}" — populate it with the expected body fields`,
          'Set data.bodyOutputData to the expected body shape, e.g. { "userId": "user-123", "action": "init" }',
          { stepId: gwStep.id, httpMethods: gwHttpMethods }));
      }

      // --- 9i-3. Check data.isRequestBody flag ---
      if (gwStep.data?.isRequestBody !== true) {
        // Upgrade to error if any step instance uses simple merge field paths
        // that assume body-level access (path: 'userId' instead of 'request.body.userId')
        const allSteps = flow.data.trees.main?.steps || [];
        const hasSimplePaths = allSteps.some(s => {
          if (s.isGatewayStep) return false;
          const vals = Object.values(s.stepInputData || {}).filter(v => typeof v === 'string');
          return vals.some(v => {
            if (!v.includes(gwMfName)) return false;
            const pathMatch = v.match(/\.get\(\s*\{\s*path:\s*['"]([^'"]+)['"]/);
            return pathMatch && !pathMatch[1].startsWith('request.');
          });
        });
        const severity = hasSimplePaths ? 'error' : 'info';
        out.push(diag('GATEWAY_REQUEST_BODY_NOT_ENABLED', severity, `step ${gwStep.id}`,
          `HTTP gateway step "${gwStep.label || gwStep.id}" accepts ${gwHttpMethods.join('/')} but data.isRequestBody is ${gwStep.data?.isRequestBody ?? 'unset'}` +
          (hasSimplePaths
            ? ` — step instances use simple merge field paths (e.g. {path: 'userId'}) that will resolve to undefined because the gateway outputs the full request structure`
            : ` — steps use request.body.* paths so isRequestBody=false is functionally correct; the body section may be hidden in the UI merge field picker`),
          hasSimplePaths
            ? 'Set data.isRequestBody = true so body fields are at the top level of the merge field output'
            : 'Either set data.isRequestBody = true for UI convenience, or keep false since steps use request.body.* paths directly',
          { stepId: gwStep.id, httpMethods: gwHttpMethods, isRequestBody: gwStep.data?.isRequestBody, hasSimplePaths }));
      }
    }

    // --- 9i-4. Check step-level outputExample ---
    if (!gwStep.outputExample || (typeof gwStep.outputExample === 'object' && Object.keys(gwStep.outputExample).length === 0)) {
      out.push(diag('GATEWAY_STEP_MISSING_OUTPUT_EXAMPLE', 'warning', `step ${gwStep.id}`,
        `HTTP gateway step "${gwStep.label || gwStep.id}" has no step-level outputExample — some UI components may not show the merge field tree`,
        'Set outputExample on the step instance with the expected request shape',
        { stepId: gwStep.id }));
    }

    // --- 9i-5. Check template-level outputExample ---
    if (gwTpl && (!gwTpl.outputExample || (typeof gwTpl.outputExample === 'object' && Object.keys(gwTpl.outputExample).length === 0))) {
      out.push(diag('GATEWAY_TEMPLATE_MISSING_OUTPUT_EXAMPLE', 'warning',
        `stepTemplate ${gwTpl.id}`,
        `HTTP gateway template "${gwTpl.label || gwTpl.id}" has no outputExample — newly placed instances will start with an empty merge field tree`,
        'Set outputExample on the gateway template with the expected request shape',
        { templateId: gwTpl.id }));
    }

    // --- 9i-6. Check meta.dataOuts entry for the gateway ---
    if (gwMfName && Array.isArray(meta.dataOuts)) {
      const gwDataOut = meta.dataOuts.find(d => d.name === gwMfName);
      if (gwDataOut) {
        const metaExample = gwDataOut.outputExample;
        if (!metaExample || (typeof metaExample === 'object' && Object.keys(metaExample).length === 0)) {
          out.push(diag('GATEWAY_DATAOUT_MISSING_OUTPUT_EXAMPLE', 'error',
            `data.meta.dataOuts (${gwMfName})`,
            `meta.dataOuts entry for gateway merge field "${gwMfName}" has no outputExample — the merge field picker uses this to build the field tree for downstream steps`,
            'Set outputExample on the meta.dataOuts entry matching the gateway step',
            { name: gwMfName, stepId: gwStep.id }));
        } else {
          const metaBody = metaExample?.request?.body;
          const metaQuery = metaExample?.request?.queryParams;
          const metaBodyEmpty = !metaBody || (typeof metaBody === 'object' && Object.keys(metaBody).length === 0);
          const metaQueryEmpty = !metaQuery || (typeof metaQuery === 'object' && Object.keys(metaQuery).length === 0);

          if (acceptsBody && metaBodyEmpty) {
            out.push(diag('GATEWAY_DATAOUT_EMPTY_BODY', 'error',
              `data.meta.dataOuts (${gwMfName}).outputExample`,
              `meta.dataOuts outputExample for "${gwMfName}" has empty request.body but the gateway accepts ${gwHttpMethods.join('/')} — the merge field picker will show the gateway variable but no body fields to select`,
              'Populate outputExample.request.body with the expected fields (e.g., { userId: "user-123", action: "init" })',
              { name: gwMfName, stepId: gwStep.id }));
          } else if (metaBodyEmpty && metaQueryEmpty) {
            out.push(diag('GATEWAY_DATAOUT_EMPTY_FIELDS', 'warning',
              `data.meta.dataOuts (${gwMfName}).outputExample`,
              `meta.dataOuts outputExample for "${gwMfName}" has empty request.body and request.queryParams — the merge field picker will show the gateway variable but no selectable request fields`,
              'Populate outputExample.request.queryParams (for GET) or request.body (for POST) with the expected fields',
              { name: gwMfName, stepId: gwStep.id }));
          }
        }

        // --- 9i-7. Consistency: outputExample should match across sources ---
        if (gwOutputExample && metaExample) {
          const exampleBodyKeys = Object.keys(gwOutputExample?.request?.body || {}).sort().join(',');
          const metaBodyKeys = Object.keys(metaExample?.request?.body || {}).sort().join(',');
          if (exampleBodyKeys && metaBodyKeys && exampleBodyKeys !== metaBodyKeys) {
            out.push(diag('GATEWAY_OUTPUT_EXAMPLE_MISMATCH', 'warning',
              `step ${gwStep.id}`,
              `HTTP gateway outputExample body fields [${exampleBodyKeys}] don't match meta.dataOuts outputExample body fields [${metaBodyKeys}] — the merge field picker may show different fields than expected`,
              'Synchronize outputExample across the step instance, template, and meta.dataOuts entry',
              { stepId: gwStep.id, gatewayMergeField: gwMfName,
                stepBodyKeys: exampleBodyKeys, metaBodyKeys }));
          }
        }
        const effectiveBodyData = (parsedBodyData && Object.keys(parsedBodyData).length > 0) ? parsedBodyData : outputDataBody;
        if (effectiveBodyData && metaExample) {
          const dataBodyKeys = Object.keys(effectiveBodyData).sort().join(',');
          const metaBodyKeys = Object.keys(metaExample?.request?.body || {}).sort().join(',');
          if (dataBodyKeys && metaBodyKeys && dataBodyKeys !== metaBodyKeys) {
            out.push(diag('GATEWAY_BODY_DATA_MISMATCH', 'warning',
              `step ${gwStep.id}`,
              `HTTP gateway data.bodyOutputData fields [${dataBodyKeys}] don't match meta.dataOuts outputExample.request.body fields [${metaBodyKeys}] — the UI panel and merge field picker may show different fields`,
              'Ensure data.bodyOutputData, outputExample, and meta.dataOuts outputExample all contain the same body fields',
              { stepId: gwStep.id, gatewayMergeField: gwMfName,
                bodyDataKeys: dataBodyKeys, metaBodyKeys }));
          }
        }
      }
    }

    // --- 9i-8. Downstream step input mapping checks ---
    if (gwOutputExample && gwMfName) {
      const bodyFields = Object.keys(gwOutputExample?.request?.body || {});
      const queryFields = Object.keys(gwOutputExample?.request?.queryParams || {});
      const allGwFields = [...bodyFields, ...queryFields];

      if (allGwFields.length > 0) {
        const infraTplIds = new Set();
        for (const s of mainStepsList) {
          if (!s?.type || s.type === 'empty') continue;
          const lbl = (s.label || '').toLowerCase();
          if (lbl.includes('gateway') || lbl.includes('response') || lbl.includes('error')) {
            infraTplIds.add(s.type);
          }
        }

        for (const step of mainStepsList) {
          if (!step?.type || step.type === 'empty' || infraTplIds.has(step.type)) continue;
          if (step.isGatewayStep) continue;
          const tpl = templates.find(t => t.id === step.type);
          if (!tpl) continue;

          const tplInputVars = (tpl.formBuilder?.stepInputs || [])
            .map(inp => inp?.data?.variable)
            .filter(Boolean);
          if (tplInputVars.length === 0) continue;

          const sid = step.stepInputData || {};
          const sidKeys = Object.keys(sid).filter(k => k && k !== 'processError' && k !== 'processTimeout');
          const sidValues = Object.values(sid).filter(v => typeof v === 'string');

          const matchingGwFields = allGwFields.filter(f => tplInputVars.includes(f));
          if (matchingGwFields.length === 0) continue;

          const unmappedFields = matchingGwFields.filter(field => {
            const hasKey = sidKeys.includes(field);
            if (!hasKey) return true;
            const val = sid[field];
            if (!val || val === '``' || val === 'undefined') return true;
            return false;
          });

          if (unmappedFields.length > 0) {
            const bodyUnmapped = unmappedFields.filter(f => bodyFields.includes(f));
            const queryUnmapped = unmappedFields.filter(f => queryFields.includes(f) && !bodyFields.includes(f));
            const parts = [];
            if (bodyUnmapped.length) parts.push(`body: ${bodyUnmapped.join(', ')}`);
            if (queryUnmapped.length) parts.push(`query: ${queryUnmapped.join(', ')}`);

            out.push(diag('STEP_INPUT_NOT_MAPPED_TO_GATEWAY', 'warning', `step ${step.id}`,
              `Step "${step.label || step.id}" has inputs matching HTTP gateway fields but they are not mapped in stepInputData (${parts.join('; ')}) — the compiler will inject empty/undefined values for these variables at runtime`,
              `Set stepInputData for each field using the merge field picker in the step UI, or use raw expressions for non-string types. ` +
              `String fields: ${unmappedFields.slice(0, 1).map(f => `${f}: \`\${await this.mergeFields['${gwMfName}'].get({path: '${f}'})}\``).join('')}. ` +
              `Array/object fields (use raw, no backticks): await this.mergeFields['${gwMfName}'].get({path: 'fieldName'})`,
              { stepId: step.id, templateId: tpl.id, unmappedFields, gatewayMergeField: gwMfName }));
          }

          const refsGateway = sidValues.some(v => v.includes(gwMfName));
          if (sidKeys.length > 0 && !refsGateway) {
            out.push(diag('STEP_INPUT_NO_GATEWAY_REF', 'info', `step ${step.id}`,
              `Step "${step.label || step.id}" has stepInputData but none of the values reference the HTTP gateway merge field "${gwMfName}" — inputs may not be receiving HTTP request data`,
              `Use merge field references in stepInputData values. For string fields: \`\${await this.mergeFields['${gwMfName}'].get({path: 'fieldName'})}\`. ` +
              `For arrays/objects, use raw expressions (no backtick wrapping, which stringifies): await this.mergeFields['${gwMfName}'].get({path: 'fieldName'})`,
              { stepId: step.id, gatewayMergeField: gwMfName }));
          }

          // Check merge field paths are consistent with isRequestBody setting
          if (gwStep.data?.isRequestBody !== true && bodyFields.length > 0) {
            const pathPattern = /\.get\(\s*\{\s*path:\s*['"]([^'"]+)['"]\s*\}/g;
            for (const val of sidValues) {
              if (!val.includes(gwMfName)) continue;
              let pathMatch;
              const pathRegex = new RegExp(pathPattern.source, 'g');
              while ((pathMatch = pathRegex.exec(val)) !== null) {
                const fieldPath = pathMatch[1];
                if (bodyFields.includes(fieldPath) && !fieldPath.startsWith('request.')) {
                  out.push(diag('MERGE_FIELD_PATH_NEEDS_REQUEST_BODY', 'error', `step ${step.id}`,
                    `Step "${step.label || step.id}" uses merge field path "${fieldPath}" but isRequestBody is false — at runtime the gateway outputs the full request structure, so body fields are at "request.body.${fieldPath}" not "${fieldPath}". This will resolve to undefined.`,
                    `Either set data.isRequestBody = true on the HTTP gateway (recommended), or change the path to "request.body.${fieldPath}"`,
                    { stepId: step.id, fieldPath, correctPath: `request.body.${fieldPath}`, isRequestBody: gwStep.data?.isRequestBody }));
                }
              }
            }
          }
        }
      }
    } else if (!gwOutputExample) {
      out.push(diag('GATEWAY_MISSING_OUTPUT_EXAMPLE', 'error', `step ${gwStep.id}`,
        `HTTP gateway step "${gwStep.label || gwStep.id}" has no outputExample on either the step instance or its template — the merge field picker won't show any request fields for downstream steps`,
        'Set outputExample on the gateway step and template with the expected request shape: { path: "/...", method: "POST", request: { body: { ... }, queryParams: { ... } } }',
        { stepId: gwStep.id }));
    }
  }

  // 9l. Hard-coded expressions in stepInputData — flag bare await expressions
  //     in string-type form inputs and wholesale auto-wiring to request.body.*
  const STRING_INPUT_COMPONENTS = new Set([
    'formTextInput', 'formTextBox', 'formSelectExpression',
    'formMergeTagInput', 'formTextMessage',
  ]);
  const BARE_AWAIT_RE = /^await\s/;
  const GW_PASSTHROUGH_RE = /this\.mergeFields\[.*?\]\.get\(\{path:\s*'request\.body\./;

  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step || !step.stepInputData || typeof step.stepInputData !== 'object') continue;
      if (step.isGatewayStep) continue;
      const tpl = templates.find(t => t.id === step.type);
      if (!tpl?.formBuilder?.stepInputs) continue;

      const compMap = new Map();
      for (const inp of (tpl.formBuilder.stepInputs || [])) {
        if (inp?.data?.variable) compMap.set(inp.data.variable, inp.component);
      }

      let gwPassthroughCount = 0;
      let totalFormInputs = 0;

      for (const [key, value] of Object.entries(step.stepInputData)) {
        if (typeof value !== 'string') continue;
        if (key === 'processError' || key === 'processTimeout' || key === 'exits') continue;
        const comp = compMap.get(key);
        if (!comp) continue;
        totalFormInputs++;

        if (STRING_INPUT_COMPONENTS.has(comp) && BARE_AWAIT_RE.test(value)) {
          out.push(diag('STEP_INPUT_HARDCODED_EXPRESSION', 'error', `step ${step.id}.stepInputData.${key}`,
            `Step "${step.label || step.id}" input "${key}" is a bare expression ("${value.substring(0, 60)}${value.length > 60 ? '...' : ''}") in a string component (${comp}) — ` +
            `bare await expressions bypass the UI and assume specific upstream steps exist, breaking portability`,
            `Wrap the expression in backticks: \`\${${value}}\` — or configure it via the step UI merge field picker`,
            { stepId: step.id, key, component: comp, tree: treeName }));
        }

        if (GW_PASSTHROUGH_RE.test(value)) gwPassthroughCount++;
      }

      if (totalFormInputs > 0 && gwPassthroughCount === totalFormInputs && totalFormInputs >= 2) {
        out.push(diag('STEP_INPUTS_ALL_GATEWAY_PASSTHROUGH', 'warning', `step ${step.id}`,
          `All ${totalFormInputs} configured inputs on step "${step.label || step.id}" are mechanical passthroughs from the HTTP gateway request.body — ` +
          `this pattern bypasses the step UI entirely, making the step non-configurable and tightly coupled to the gateway schema`,
          `Configure inputs via the step UI or use the step configurator to set contextually appropriate values`,
          { stepId: step.id, tree: treeName, passthroughCount: gwPassthroughCount }));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 10 — Secrets & sensitive data detection
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERNS = [
  /^(aws_?)?secret_?(access_?)?key$/i,
  /^api[_-]?key$/i,
  /^api[_-]?secret$/i,
  /^auth[_-]?token$/i,
  /^access[_-]?token$/i,
  /^private[_-]?key$/i,
  /^client[_-]?secret$/i,
  /^password$/i,
  /^passwd$/i,
  /^db[_-]?password$/i,
  /^database[_-]?password$/i,
  /^encryption[_-]?key$/i,
  /^signing[_-]?key$/i,
  /^jwt[_-]?secret$/i,
  /^webhook[_-]?secret$/i,
  /^slack[_-]?token$/i,
  /^stripe[_-]?(secret|key)$/i,
  /^sendgrid[_-]?(api[_-]?)?key$/i,
  /^twilio[_-]?(auth[_-]?)?token$/i,
  /^openai[_-]?(api[_-]?)?key$/i,
];

const SECRET_VALUE_PATTERNS = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
  { re: /\bsk-[a-zA-Z0-9]{20,}/, label: 'OpenAI / Stripe secret key' },
  { re: /\bghp_[a-zA-Z0-9]{36}\b/, label: 'GitHub personal access token' },
  { re: /\bgho_[a-zA-Z0-9]{36}\b/, label: 'GitHub OAuth token' },
  { re: /\bghs_[a-zA-Z0-9]{36}\b/, label: 'GitHub App installation token' },
  { re: /\bghr_[a-zA-Z0-9]{36}\b/, label: 'GitHub refresh token' },
  { re: /\bglpat-[a-zA-Z0-9\-_]{20,}\b/, label: 'GitLab personal access token' },
  { re: /\bxox[baprs]-[a-zA-Z0-9\-]{10,}/, label: 'Slack token' },
  { re: /\bSG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}\b/, label: 'SendGrid API key' },
  { re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: 'PEM private key' },
  { re: /-----BEGIN\s+CERTIFICATE-----/, label: 'PEM certificate' },
  { re: /\beyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/, label: 'JWT token' },
  { re: /\bhook\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/, label: 'Slack webhook URL' },
];

function isSensitiveKey(key) {
  return SECRET_KEY_PATTERNS.some(re => re.test(key));
}

function detectSecretValue(value) {
  if (typeof value !== 'string' || value.length < 8) return null;
  for (const { re, label } of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) return label;
  }
  return null;
}

function passSecrets(flow, out) {
  // 10a. deploy.env — check both key names and values
  const deploy = flow.data.deploy;
  if (deploy && Array.isArray(deploy.env)) {
    deploy.env.forEach((entry, i) => {
      if (!entry) return;
      const base = `data.deploy.env[${i}]`;
      if (entry.value && typeof entry.value === 'string') {
        const match = detectSecretValue(entry.value);
        if (match) {
          out.push(diag('SECRET_IN_ENV_VALUE', 'error', base,
            `Environment variable "${entry.name}" contains what looks like a ${match} — secrets should not be stored in flow JSON`,
            'Use an external secrets manager, SSM Parameter Store, or Secrets Manager; reference via runtime env lookup',
            { envName: entry.name, secretType: match }));
        }
      }
    });
  }

  // 10b. stepInputData — hardcoded secrets in step configuration
  for (const [treeName, tree] of Object.entries(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (!step?.stepInputData || typeof step.stepInputData !== 'object') continue;
      const base = `data.trees.${treeName}.step[${step.id}].stepInputData`;

      for (const [key, value] of Object.entries(step.stepInputData)) {
        if (isSensitiveKey(key) && typeof value === 'string' && value.length > 0) {
          const unquoted = value.replace(/^["`'`]+|["`'`]+$/g, '').trim();
          if (unquoted && unquoted !== '``' && !unquoted.startsWith('this.') && !unquoted.startsWith('await ')) {
            out.push(diag('SECRET_IN_STEP_INPUT', 'warning', `${base}.${key}`,
              `Step "${step.label || step.id}" has sensitive-looking key "${key}" with a literal value — consider using a merge field or env var instead of hardcoding`,
              'Replace with a merge field reference (e.g., `\\`mySecretVar\\``) or read from process.env',
              { stepId: step.id, key, tree: treeName }));
          }
        }
        if (typeof value === 'string') {
          const secretType = detectSecretValue(value);
          if (secretType) {
            out.push(diag('SECRET_IN_STEP_INPUT', 'error', `${base}.${key}`,
              `Step "${step.label || step.id}" input "${key}" contains what looks like a ${secretType}`,
              'Remove the hardcoded secret and use a merge field, env var, or secrets manager',
              { stepId: step.id, key, secretType, tree: treeName }));
          }
        }
      }
    }
  }

  // 10c. Step template code — secrets embedded in compiled template
  const templates = Array.isArray(flow.data.stepTemplates) ? flow.data.stepTemplates : [];
  templates.forEach((tpl, i) => {
    if (!tpl) return;
    const base = `data.stepTemplates[${i}]`;

    if (typeof tpl.template === 'string') {
      const secretType = detectSecretValue(tpl.template);
      if (secretType) {
        out.push(diag('SECRET_IN_TEMPLATE_CODE', 'error', `${base}.template`,
          `Step template "${tpl.label || tpl.id}" code contains what looks like a ${secretType}`,
          'Remove hardcoded secrets from template code; use env vars or merge fields at runtime',
          { templateId: tpl.id, secretType }));
      }
    }

    // 10d. formBuilder defaultValues
    if (tpl.formBuilder && Array.isArray(tpl.formBuilder.stepInputs)) {
      tpl.formBuilder.stepInputs.forEach((input, ii) => {
        if (!input?.data) return;
        const varName = input.data.variable || '';
        const defVal = input.data.defaultValue;
        if (isSensitiveKey(varName) && typeof defVal === 'string' && defVal.length > 0) {
          const unquoted = defVal.replace(/^["`'`]+|["`'`]+$/g, '').trim();
          if (unquoted && unquoted !== '``') {
            out.push(diag('SECRET_IN_DEFAULT_VALUE', 'warning', `${base}.formBuilder.stepInputs[${ii}].data.defaultValue`,
              `Template "${tpl.label || tpl.id}" input "${varName}" has a non-empty default value for a sensitive field — defaults are visible to all flow editors`,
              'Set defaultValue to empty or use a placeholder; inject the real secret at runtime via env var or merge field',
              { templateId: tpl.id, variable: varName }));
          }
        }
        if (typeof defVal === 'string') {
          const secretType = detectSecretValue(defVal);
          if (secretType) {
            out.push(diag('SECRET_IN_DEFAULT_VALUE', 'error', `${base}.formBuilder.stepInputs[${ii}].data.defaultValue`,
              `Template "${tpl.label || tpl.id}" input "${varName}" default value contains what looks like a ${secretType}`,
              'Remove the hardcoded secret from the default value',
              { templateId: tpl.id, variable: varName, secretType }));
          }
        }
      });
    }

    // 10e. form.code and form.template (wildcard/custom form code)
    if (tpl.form && typeof tpl.form === 'object') {
      for (const field of ['template', 'code']) {
        if (typeof tpl.form[field] === 'string') {
          const secretType = detectSecretValue(tpl.form[field]);
          if (secretType) {
            out.push(diag('SECRET_IN_FORM_CODE', 'error', `${base}.form.${field}`,
              `Template "${tpl.label || tpl.id}" form.${field} contains what looks like a ${secretType}`,
              'Remove hardcoded secrets from form code',
              { templateId: tpl.id, secretType }));
          }
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pass 11 — Step template code analysis
// ---------------------------------------------------------------------------
const KNOWN_INFRA_TPL_IDS = new Set([
  'f08d2d37-8047-400e-aa94-e3f6e3435b1b', // Send HTTP Response
  'd476f639-c460-4b35-a4f9-0ef94db22937', // Wait for HTTP Request (v2)
  'd476f639-38d0-42c2-8f5e-b6a5094e893c', // Wait for HTTP Request (v1)
  '3a40f4a9-1968-4c0b-8380-027c14109208', // Handle Flow Error (v2)
  '3a40f4a9-4a47-4016-8c10-86f2b4eb1ebb', // Handle Flow Error (v1)
]);
const INFRA_LABEL_PATTERNS = [/send\s*http\s*response/i, /wait\s*for\s*http\s*request/i, /handle\s*flow\s*error/i];

function isInfraTemplate(tpl) {
  if (KNOWN_INFRA_TPL_IDS.has(tpl.id)) return true;
  if (tpl.isGatewayStep) return true;
  return INFRA_LABEL_PATTERNS.some(re => re.test(tpl.label || ''));
}

function passStepTemplateCode(flow, out) {
  const templates = flow.data.stepTemplates || [];
  const steps = flow.data.trees.main?.steps || [];

  function isGatewayStep(s) {
    if (s?.type === HTTP_GATEWAY_TPL_ID || s?.type === 'd476f639-38d0-42c2-8f5e-b6a5094e893c') return true;
    if (/Http Gateway|Wait for HTTP/i.test(s?.label || '')) return true;
    return templates.some(t => t.id === s?.type && t.isGatewayStep === true);
  }

  const gatewayStep = steps.find(isGatewayStep);
  if (!gatewayStep) return;

  const gatewayMergeField = gatewayStep?.data?.dataOut?.name;

  for (const tpl of templates) {
    if (!tpl || isInfraTemplate(tpl)) continue;
    const code = tpl.template || '';
    if (!code) continue;

    const usesThisDataForInput = /\bthis\.data\b/.test(code) &&
      !/\bthis\.data\.exits\b/.test(code.replace(/this\.data\.exits/g, '')) &&
      (code.match(/\bthis\.data\b/g) || []).length >
       (code.match(/\bthis\.data\.(exits|dataOut|processError|processTimeout)\b/g) || []).length;

    const usesMergeFields = /this\.mergeFields/.test(code);
    const refsGatewayField = gatewayMergeField && code.includes(gatewayMergeField);

    if (usesThisDataForInput && !usesMergeFields) {
      const stepInstances = steps.filter(s => s?.type === tpl.id);
      const allHavePopulatedInputs = stepInstances.length > 0 && stepInstances.every(s => {
        const keys = Object.keys(s.stepInputData || {}).filter(k => k && k !== 'processError' && k !== 'processTimeout');
        return keys.length > 0;
      });

      const classBased = /(?:module\s*\.\s*exports)|(?:exports\s*\.\s*step)\s*=|(?:^export\s)/m.test(code);

      if (classBased && allHavePopulatedInputs) {
        out.push(diag('STEP_CODE_READS_THIS_DATA', 'info', `stepTemplate ${tpl.id}`,
          `Step template "${tpl.label}" reads from this.data — this is correct for class-based steps where initData() populates this.data from stepInputData. ` +
          `All step instances have populated stepInputData, so this.data will resolve correctly at runtime.`,
          'No action required — this.data is the correct access pattern for class-based steps with populated stepInputData.',
          { templateId: tpl.id, templateLabel: tpl.label, classBased: true }));
      } else if (classBased && !allHavePopulatedInputs) {
        out.push(diag('STEP_CODE_READS_THIS_DATA', 'error', `stepTemplate ${tpl.id}`,
          `Step template "${tpl.label}" is class-based and reads from this.data — but stepInputData is empty on one or more instances. ` +
          `initData() resolves stepInputData expressions into this.data, so missing wiring means this.data properties will be undefined. ` +
          `Wire each step instance's stepInputData to merge field values using the merge field picker (e.g., ` +
          `userId: await this.mergeFields['${gatewayMergeField || 'httpGatewayStep'}'].get({path: 'userId'}))`,
          `Populate stepInputData on each step instance — use the merge field picker in the step UI to wire merge fields into each input.`,
          { templateId: tpl.id, templateLabel: tpl.label, classBased: true }));
      } else if (!classBased && allHavePopulatedInputs) {
        out.push(diag('STEP_CODE_READS_THIS_DATA', 'warning', `stepTemplate ${tpl.id}`,
          `Step template "${tpl.label}" reads from this.data — but in the compiled step, templateLogic() runs with \`this\` bound to the Thread (not the Step), so this.data is undefined. ` +
          `The compiler destructures stepInputData values as function parameters to templateLogic(), so inputs are available as local variables (e.g., userId, action). ` +
          `Replace this.data access with the compiler-injected local variables, or use a getter-based stepData: const stepData = { get userId() { return userId; } };`,
          'Use compiler-injected local variables instead of this.data. The second parameter "thisStep" provides access to the Step object if needed.',
          { templateId: tpl.id, templateLabel: tpl.label, classBased: false }));
      } else {
        out.push(diag('STEP_CODE_READS_THIS_DATA', 'error', `stepTemplate ${tpl.id}`,
          `Step template "${tpl.label}" reads from this.data — but this.data is undefined in templateLogic() (this = Thread, not Step). ` +
          `Additionally, stepInputData is empty on one or more instances, so even the compiler-injected local variables will be missing. ` +
          `Wire each step instance's stepInputData to merge field values using the merge field picker (e.g., for an HTTP gateway flow: ` +
          `userId maps to await this.mergeFields['${gatewayMergeField || 'httpGatewayStep'}'].get({path: 'userId'}))`,
          `1. Replace this.data access with compiler-injected local variables. ` +
          `2. Populate stepInputData on each step instance — use the merge field picker in the step UI, or set values like: ` +
          `userId: await this.mergeFields['${gatewayMergeField || 'httpGatewayStep'}'].get({path: 'userId'})`,
          { templateId: tpl.id, templateLabel: tpl.label, classBased: false }));
      }
    } else if (usesMergeFields && !refsGatewayField && gatewayMergeField) {
      out.push(diag('STEP_CODE_MISSING_GATEWAY_FIELD', 'warning', `stepTemplate ${tpl.id}`,
        `Step template "${tpl.label}" uses mergeFields but does not reference the HTTP gateway merge field "${gatewayMergeField}" — it may not be reading the request body`,
        `Verify the step reads from this.mergeFields['${gatewayMergeField}'].get() for HTTP input`,
        { templateId: tpl.id, templateLabel: tpl.label, gatewayMergeField }));
    }

    if (/\bthis\.data\b/.test(code)) {
      const templateField = tpl.template || '';
      const dataCodeField = tpl.data?.code || '';
      if (templateField && dataCodeField && templateField !== dataCodeField) {
        const tplHasGateway = templateField.includes(gatewayMergeField || '___none___');
        const codeHasGateway = dataCodeField.includes(gatewayMergeField || '___none___');
        if (tplHasGateway !== codeHasGateway) {
          out.push(diag('STEP_TEMPLATE_CODE_MISMATCH', 'warning', `stepTemplate ${tpl.id}`,
            `Step template "${tpl.label}" has different code in "template" (runtime) vs "data.code" (editor) — the runtime uses the "template" field`,
            'Ensure both fields contain the same code, or update the "template" field which is what Edison compiles',
            { templateId: tpl.id, templateLabel: tpl.label }));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
function validateFlow(flow) {
  const diagnostics = [];

  const canContinue = passTopLevel(flow, diagnostics);
  if (!canContinue) {
    return formatResult(diagnostics);
  }

  passDeploy(flow, diagnostics);

  const tplMap = passTemplates(flow, diagnostics);

  const { allStepIds, stepsByTree } = passSteps(flow, tplMap, diagnostics);

  passRefs(flow, tplMap, allStepIds, stepsByTree, diagnostics);

  passGraph(flow, allStepIds, stepsByTree, diagnostics);

  passMergeFields(flow, diagnostics);

  passErrorHandling(flow, stepsByTree, diagnostics);

  passStructuralBestPractices(flow, allStepIds, stepsByTree, diagnostics);

  passSecrets(flow, diagnostics);

  passStepTemplateCode(flow, diagnostics);

  return formatResult(diagnostics, flow);
}

function formatResult(diagnostics, flow) {
  const severityOrder = { error: 0, warning: 1, info: 2 };
  diagnostics.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] = (counts[d.severity] || 0) + 1;

  const parts = [];
  if (counts.error) parts.push(`${counts.error} error${counts.error > 1 ? 's' : ''}`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning > 1 ? 's' : ''}`);
  if (counts.info) parts.push(`${counts.info} info note${counts.info > 1 ? 's' : ''}`);

  const result = {
    valid: counts.error === 0,
    counts,
    diagnostics,
    summary: parts.length ? parts.join(', ') : 'No issues found',
    ts: new Date().toISOString(),
  };

  if (flow) {
    try {
      const _req = typeof require === 'function' ? require : null;
      if (_req) {
        const { buildValidatorAnnotations } = _req('./flowEditor');
        result.annotations = buildValidatorAnnotations(flow, diagnostics, 'flowValidator');
      } else {
        result.annotations = [];
      }
    } catch (_) {
      result.annotations = [];
    }
  }

  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateFlow, extractFormVariables, extractWildcardSchemaBindings, isEmptyValue };
}
