/**
 * Agent Registry — renderer (ADR-086). Search + registry manager over
 * the NEON `:Agent` catalog: facets on the left, results in the middle,
 * the selected agent's management panel on the right (availability,
 * metadata, reachability, what it belongs to, and the submission
 * checklist). Pure builders are exported for tests.
 */

type Bridge = NonNullable<NonNullable<typeof window.lite>['registry']>;
type Summary = LiteRegistryAgentSummary;
type Detail = LiteRegistryAgentDetail;
type Viewer = LiteRegistryViewer;
type Ref = LiteRegistryRef;
type Checklist = LiteRegistryChecklist;
type Listing = Summary['listing'];

interface Filters {
  q: string;
  source: string;
  type: string;
  category: string;
  state: '' | 'enabled' | 'disabled';
  listing: '' | Listing;
  reach: '' | 'mcp' | 'api' | 'skill';
  idwId: string;
  knowledgeId: string;
  includeDeleted: boolean;
}

const PAGE = 50;
const state = {
  filters: { q: '', source: '', type: '', category: '', state: '', listing: '', reach: '', idwId: '', knowledgeId: '', includeDeleted: false } as Filters,
  items: [] as Summary[],
  total: 0,
  facets: { sources: [] as LiteRegistryFacet[], types: [] as LiteRegistryFacet[], categories: [] as LiteRegistryFacet[] },
  selectedId: null as string | null,
  checklist: null as Checklist | null,
  viewer: null as Viewer | null,
  idws: [] as Ref[],
  knowledge: [] as Ref[],
  capabilities: [] as Ref[],
  busy: false,
};

const $ = (id: string): HTMLElement | null => document.getElementById(id);
const bridge = (): Bridge | null => window.lite?.registry ?? null;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function formatAgo(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = Math.max(0, now - ms);
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function listingBadge(listing: Listing): HTMLElement {
  const b = el('span', `reg-badge is-${listing}`, listing);
  b.title = { unlisted: 'Not submitted for listing', submitted: 'Submitted — awaiting an admin', listed: 'Listed on the platform', rejected: 'Rejected by an admin' }[listing];
  return b;
}

export function buildAgentRow(item: Summary, selected: boolean): HTMLElement {
  const row = el('div', 'reg-row' + (selected ? ' is-selected' : ''));
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  row.setAttribute('data-id', item.id);
  const dot = el('span', 'reg-row-dot' + (item.enabled && !item.deleted ? '' : ' is-off'));
  dot.title = item.deleted ? 'deleted' : item.enabled ? 'enabled' : 'disabled';
  row.appendChild(dot);
  const main = el('div', 'reg-row-main');
  main.appendChild(el('div', 'reg-row-name', item.name));
  main.appendChild(el('div', 'reg-row-desc', item.description.length > 0 ? item.description : `${item.type || 'agent'} · ${item.source || 'unknown source'}`));
  row.appendChild(main);
  const meta = el('div', 'reg-row-meta');
  if (item.type.length > 0) meta.appendChild(el('span', 'reg-chip', item.type));
  for (const r of item.reach) meta.appendChild(el('span', `reg-chip kind ${r}`, r === 'api' ? 'RESTful' : r.toUpperCase()));
  if (item.listing !== 'unlisted') meta.appendChild(listingBadge(item.listing));
  if (item.deleted) meta.appendChild(el('span', 'reg-badge is-deleted', 'deleted'));
  meta.appendChild(el('span', 'reg-row-when', formatAgo(item.updatedMs)));
  row.appendChild(meta);
  return row;
}

export function buildChecklistPanel(
  checklist: Checklist,
  opts: { isAdmin: boolean; canWrite: boolean; onToggle: (checkId: string, value: boolean) => void; onListing: (listing: Listing) => void }
): HTMLElement {
  const wrap = el('section', 'reg-checklist');
  const title = el('h3', 'reg-section-title');
  title.appendChild(el('span', undefined, 'Submission checklist'));
  title.appendChild(el('span', 'reg-muted', `${checklist.progress.passed}/${checklist.progress.total} required`));
  wrap.appendChild(title);
  const bar = el('div', 'reg-check-progress' + (checklist.ready ? ' is-ready' : ''));
  const fill = el('span');
  fill.style.width = `${checklist.progress.total === 0 ? 100 : Math.round((checklist.progress.passed / checklist.progress.total) * 100)}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);
  for (const c of checklist.checks) {
    const row = el('div', `reg-check ${c.passed ? 'is-pass' : 'is-fail'}${c.required ? ' is-required' : ''}`);
    if (c.kind === 'manual') {
      const box = el('input');
      box.type = 'checkbox';
      box.checked = c.passed;
      box.disabled = !opts.canWrite;
      box.setAttribute('data-check', c.id);
      box.addEventListener('change', () => opts.onToggle(c.id, box.checked));
      row.appendChild(box);
    } else {
      row.appendChild(el('span', 'reg-check-mark', c.passed ? '✓' : c.required ? '✗' : '○'));
    }
    const body = el('div');
    const label = el('div', 'reg-check-label', c.label);
    if (!c.required) label.appendChild(el('span', 'reg-check-opt', 'recommended'));
    body.appendChild(label);
    body.appendChild(el('div', 'reg-check-detail', c.detail));
    row.appendChild(body);
    wrap.appendChild(row);
  }
  const actions = el('div', 'reg-d-actions');
  const listing = checklist.agent.listing;
  const mk = (label: string, target: Listing, cls = '', enabled = true): void => {
    const b = el('button', `reg-btn small ${cls}`.trim(), label);
    b.type = 'button';
    b.disabled = !enabled;
    b.addEventListener('click', () => opts.onListing(target));
    actions.appendChild(b);
  };
  if (opts.canWrite && listing !== 'submitted' && listing !== 'listed') mk('Submit for listing', 'submitted', 'primary', checklist.ready);
  if (opts.isAdmin && listing !== 'listed') mk('List on the platform', 'listed', 'primary', checklist.ready);
  if (opts.isAdmin && listing === 'submitted') mk('Reject', 'rejected', 'danger');
  if (opts.canWrite && listing !== 'unlisted') mk('Unlist', 'unlisted');
  if (actions.childElementCount > 0) wrap.appendChild(actions);
  if (!checklist.ready) wrap.appendChild(el('p', 'reg-muted', 'Complete every required check to submit or list.'));
  return wrap;
}

function toast(message: string): void {
  const t = $('reg-toast');
  if (t === null) return;
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout((t as HTMLElement & { _timer?: number })._timer);
  (t as HTMLElement & { _timer?: number })._timer = window.setTimeout(() => {
    t.hidden = true;
  }, 3200);
}

function fail(err: { code: string; message: string; remediation: string } | undefined): void {
  toast(err === undefined ? 'Something went wrong.' : err.remediation.length > 0 ? `${err.message} ${err.remediation}` : err.message);
}

function canWrite(agent: Detail | null): boolean {
  const v = state.viewer;
  if (v === null || v.viewerId === null) return false;
  if (v.isAdmin) return true;
  return agent !== null && agent.owner.toLowerCase() === v.viewerId.toLowerCase();
}

// ── Viewer ───────────────────────────────────────────────────────────
async function loadViewer(): Promise<void> {
  const b = bridge();
  const box = $('reg-viewer');
  if (b === null || box === null) return;
  const res = await b.whoAmI();
  if (res.ok !== true || res.value === undefined) {
    box.replaceChildren(el('span', 'reg-muted', 'Registry unavailable'));
    return;
  }
  state.viewer = res.value;
  renderViewer();
}

function renderViewer(): void {
  const box = $('reg-viewer');
  const v = state.viewer;
  if (box === null || v === null) return;
  box.replaceChildren();
  if (v.viewerId === null) {
    box.appendChild(el('span', 'reg-muted', 'Signed out — read only'));
    return;
  }
  box.appendChild(el('span', undefined, v.viewerId));
  if (v.isAdmin) {
    box.appendChild(el('span', 'reg-badge is-admin', 'admin'));
  } else if (v.noAdminYet) {
    const claim = el('button', 'reg-btn small primary', 'Become the first admin');
    claim.type = 'button';
    claim.title = 'No one holds the registry admin role yet. This makes you the first admin; admins can add others.';
    claim.addEventListener('click', () => {
      void (async () => {
        const b = bridge();
        if (b === null) return;
        const res = await b.claimFirstAdmin();
        if (res.ok !== true || res.value === undefined) return fail(res.error);
        state.viewer = res.value;
        renderViewer();
        toast('You are the registry admin.');
        if (state.selectedId !== null) void select(state.selectedId);
      })();
    });
    box.appendChild(claim);
  } else {
    box.appendChild(el('span', 'reg-badge', 'member'));
  }
}

// ── Search ───────────────────────────────────────────────────────────
let searchTimer = 0;
let searchSeq = 0;
function scheduleSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(0), 220);
}

async function runSearch(offset: number): Promise<void> {
  const b = bridge();
  const list = $('reg-list');
  const summary = $('reg-summary');
  if (b === null || list === null) return;
  const seq = ++searchSeq;
  if (offset === 0 && summary !== null) summary.textContent = 'Searching…';
  const res = await b.search({ ...state.filters, offset, limit: PAGE });
  if (seq !== searchSeq) return;
  if (res.ok !== true || res.value === undefined) {
    list.replaceChildren(el('div', 'reg-error', res.error?.message ?? 'Search failed.'));
    if (summary !== null) summary.textContent = 'Could not load agents';
    return;
  }
  const r = res.value;
  state.items = offset === 0 ? r.items : [...state.items, ...r.items];
  state.total = r.total;
  if (offset === 0) state.facets = r.facets;
  renderList();
  renderFacets();
  const count = $('reg-count');
  if (count !== null) count.textContent = `${r.total.toLocaleString()} agents`;
  if (summary !== null) summary.textContent = `${state.items.length.toLocaleString()} of ${r.total.toLocaleString()} shown · newest first`;
  const more = $('reg-more');
  if (more !== null) more.hidden = state.items.length >= r.total;
}

function renderList(): void {
  const list = $('reg-list');
  if (list === null) return;
  list.replaceChildren();
  if (state.items.length === 0) {
    list.appendChild(el('div', 'reg-empty', state.filters.q.length > 0 ? `No agents match "${state.filters.q}".` : 'No agents.'));
    return;
  }
  for (const item of state.items) {
    const row = buildAgentRow(item, item.id === state.selectedId);
    row.addEventListener('click', () => void select(item.id));
    list.appendChild(row);
  }
}

function facetGroup(title: string, key: 'source' | 'type' | 'category', values: LiteRegistryFacet[]): HTMLElement {
  const wrap = el('div', 'reg-facet');
  wrap.appendChild(el('div', 'reg-facet-title', title));
  const current = state.filters[key];
  const all = el('button', 'reg-facet-row' + (current === '' ? ' is-on' : ''));
  all.type = 'button';
  all.appendChild(el('span', undefined, 'All'));
  all.addEventListener('click', () => {
    state.filters[key] = '';
    void runSearch(0);
  });
  wrap.appendChild(all);
  for (const f of values.slice(0, 12)) {
    if (f.value.length === 0) continue;
    const row = el('button', 'reg-facet-row' + (current === f.value ? ' is-on' : ''));
    row.type = 'button';
    row.appendChild(el('span', undefined, f.value));
    row.appendChild(el('span', 'n', f.count.toLocaleString()));
    row.addEventListener('click', () => {
      state.filters[key] = current === f.value ? '' : f.value;
      void runSearch(0);
    });
    wrap.appendChild(row);
  }
  return wrap;
}

function choiceGroup<K extends 'state' | 'listing' | 'reach'>(title: string, key: K, choices: Array<[Filters[K], string]>): HTMLElement {
  const wrap = el('div', 'reg-facet');
  wrap.appendChild(el('div', 'reg-facet-title', title));
  for (const [value, label] of choices) {
    const row = el('button', 'reg-facet-row' + (state.filters[key] === value ? ' is-on' : ''));
    row.type = 'button';
    row.appendChild(el('span', undefined, label));
    row.addEventListener('click', () => {
      state.filters[key] = value;
      void runSearch(0);
    });
    wrap.appendChild(row);
  }
  return wrap;
}

function refSelect(title: string, key: 'idwId' | 'knowledgeId', refs: Ref[], empty: string): HTMLElement {
  const wrap = el('div', 'reg-facet');
  wrap.appendChild(el('div', 'reg-facet-title', title));
  const sel = el('select');
  const any = el('option', undefined, refs.length === 0 ? empty : 'Any');
  any.value = '';
  sel.appendChild(any);
  for (const r of refs) {
    const o = el('option', undefined, r.name);
    o.value = r.id;
    sel.appendChild(o);
  }
  sel.value = state.filters[key];
  sel.disabled = refs.length === 0;
  sel.addEventListener('change', () => {
    state.filters[key] = sel.value;
    void runSearch(0);
  });
  wrap.appendChild(sel);
  return wrap;
}

function renderFacets(): void {
  const box = $('reg-facets');
  if (box === null) return;
  box.replaceChildren(
    facetGroup('Source', 'source', state.facets.sources),
    facetGroup('Type', 'type', state.facets.types),
    facetGroup('Category', 'category', state.facets.categories),
    choiceGroup('Availability', 'state', [['', 'Any'], ['enabled', 'Enabled'], ['disabled', 'Disabled']]),
    choiceGroup('Listing', 'listing', [['', 'Any'], ['listed', 'Listed'], ['submitted', 'Submitted'], ['unlisted', 'Unlisted'], ['rejected', 'Rejected']]),
    choiceGroup('Reachable via', 'reach', [['', 'Any'], ['mcp', 'MCP'], ['api', 'RESTful API'], ['skill', 'Skill']]),
    refSelect('IDW', 'idwId', state.idws, 'No IDWs registered'),
    refSelect('Knowledge model', 'knowledgeId', state.knowledge, 'No knowledge models yet')
  );
}

// ── Detail ───────────────────────────────────────────────────────────
async function select(id: string): Promise<void> {
  const b = bridge();
  if (b === null) return;
  state.selectedId = id;
  renderList();
  const detail = $('reg-detail');
  if (detail !== null) detail.replaceChildren(el('div', 'reg-empty', 'Loading…'));
  const res = await b.checklist(id);
  if (res.ok !== true || res.value === undefined) {
    if (detail !== null) detail.replaceChildren(el('div', 'reg-error', res.error?.message ?? 'Could not load the agent.'));
    return;
  }
  state.checklist = res.value;
  renderDetail();
}

async function refreshSelected(): Promise<void> {
  if (state.selectedId !== null) await select(state.selectedId);
  const idx = state.items.findIndex((i) => i.id === state.selectedId);
  if (idx >= 0 && state.checklist !== null) {
    const a = state.checklist.agent;
    state.items[idx] = { ...state.items[idx], name: a.name, description: a.description.slice(0, 240), type: a.type, category: a.category, enabled: a.enabled, listing: a.listing, reach: [...new Set(a.endpoints.map((e) => e.kind))], idwCount: a.idws.length, knowledgeCount: a.knowledgeModels.length } as Summary;
    renderList();
  }
}

async function act<T>(fn: (b: Bridge) => Promise<LiteRegistryResult<T>>, done: string): Promise<void> {
  const b = bridge();
  if (b === null || state.busy) return;
  state.busy = true;
  try {
    const res = await fn(b);
    if (res.ok !== true) return fail(res.error);
    toast(done);
    await refreshSelected();
  } finally {
    state.busy = false;
  }
}

function chipList(refs: Ref[], onRemove: ((id: string) => void) | null, emptyText: string): HTMLElement {
  const wrap = el('div', 'reg-chips');
  if (refs.length === 0) {
    wrap.appendChild(el('span', 'reg-muted', emptyText));
    return wrap;
  }
  for (const r of refs) {
    const chip = el('span', 'reg-chip', r.name);
    chip.title = r.description;
    if (onRemove !== null) {
      const x = el('button', 'reg-chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${r.name}`);
      x.addEventListener('click', () => onRemove(r.id));
      chip.appendChild(x);
    }
    wrap.appendChild(chip);
  }
  return wrap;
}

function addRefRow(
  options: Ref[],
  linked: Ref[],
  onLink: (id: string) => void,
  onCreate: ((name: string, description: string) => void) | null,
  noun: string
): HTMLElement {
  const row = el('div', 'reg-add');
  const sel = el('select');
  const ph = el('option', undefined, `Add ${noun}…`);
  ph.value = '';
  sel.appendChild(ph);
  const linkedIds = new Set(linked.map((l) => l.id));
  for (const o of options) {
    if (linkedIds.has(o.id)) continue;
    const opt = el('option', undefined, o.name);
    opt.value = o.id;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (sel.value.length > 0) onLink(sel.value);
  });
  row.appendChild(sel);
  if (onCreate !== null) {
    const name = el('input');
    name.type = 'text';
    name.placeholder = `New ${noun} name`;
    name.className = 'grow';
    const btn = el('button', 'reg-btn small', 'Create');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (name.value.trim().length > 1) onCreate(name.value.trim(), '');
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });
    row.appendChild(name);
    row.appendChild(btn);
  }
  return row;
}

function section(title: string, extra?: HTMLElement): HTMLElement {
  const h = el('h3', 'reg-section-title');
  h.appendChild(el('span', undefined, title));
  if (extra !== undefined) h.appendChild(extra);
  return h;
}

function renderDetail(): void {
  const box = $('reg-detail');
  const cl = state.checklist;
  if (box === null || cl === null) return;
  const a = cl.agent;
  const writable = canWrite(a);
  const isAdmin = state.viewer?.isAdmin === true;
  const root = el('div', 'reg-d');

  // Head
  const head = el('div', 'reg-d-head');
  if (writable) {
    const input = el('input', 'reg-d-name-input');
    input.value = a.name;
    input.setAttribute('aria-label', 'Agent name');
    input.addEventListener('change', () => {
      if (input.value.trim().length > 0 && input.value.trim() !== a.name) void act((b) => b.update(a.id, { name: input.value.trim() }), 'Renamed');
    });
    head.appendChild(input);
  } else {
    head.appendChild(el('h2', 'reg-d-name', a.name));
  }
  const badges = el('div', 'reg-d-badges');
  badges.appendChild(listingBadge(a.listing));
  badges.appendChild(el('span', 'reg-badge', a.enabled ? 'enabled' : 'disabled'));
  if (a.deleted) badges.appendChild(el('span', 'reg-badge is-deleted', 'deleted'));
  if (a.builtin) badges.appendChild(el('span', 'reg-badge', 'built-in'));
  if (a.isSystem) badges.appendChild(el('span', 'reg-badge', 'system'));
  if (a.type.length > 0) badges.appendChild(el('span', 'reg-chip', a.type));
  if (a.category.length > 0) badges.appendChild(el('span', 'reg-chip', a.category));
  head.appendChild(badges);
  if (writable) {
    const actions = el('div', 'reg-d-actions');
    const toggle = el('button', 'reg-btn small', a.enabled ? 'Disable on the platform' : 'Enable on the platform');
    toggle.type = 'button';
    toggle.addEventListener('click', () => void act((b) => b.setEnabled(a.id, !a.enabled), a.enabled ? 'Disabled' : 'Enabled'));
    actions.appendChild(toggle);
    head.appendChild(actions);
  }
  root.appendChild(head);

  // Description
  const descWrap = el('div');
  descWrap.appendChild(section('Description'));
  if (writable) {
    const ta = el('textarea', 'reg-d-textarea');
    ta.value = a.description;
    ta.setAttribute('aria-label', 'Description');
    const save = el('button', 'reg-btn small', 'Save description');
    save.type = 'button';
    save.disabled = true;
    ta.addEventListener('input', () => {
      save.disabled = ta.value.trim() === a.description.trim();
    });
    save.addEventListener('click', () => void act((b) => b.update(a.id, { description: ta.value }), 'Description saved'));
    descWrap.appendChild(ta);
    const row = el('div', 'reg-d-actions');
    row.appendChild(save);
    descWrap.appendChild(row);
  } else {
    descWrap.appendChild(el('p', 'reg-d-desc', a.description.length > 0 ? a.description : 'No description.'));
  }
  root.appendChild(descWrap);

  // Metadata
  const metaWrap = el('div');
  metaWrap.appendChild(section('Registry record'));
  const dl = el('dl', 'reg-meta');
  const add = (k: string, v: string | HTMLElement): void => {
    dl.appendChild(el('dt', undefined, k));
    const dd = el('dd');
    if (typeof v === 'string') dd.textContent = v.length > 0 ? v : '—';
    else dd.appendChild(v);
    dl.appendChild(dd);
  };
  add('Id', a.id);
  if (writable) {
    const status = el('select');
    for (const s of ['', 'active', 'inactive', 'deprecated']) {
      const o = el('option', undefined, s.length === 0 ? 'not set' : s);
      o.value = s;
      status.appendChild(o);
    }
    status.value = ['active', 'inactive', 'deprecated'].includes(a.status) ? a.status : '';
    status.addEventListener('change', () => {
      if (status.value.length > 0) void act((b) => b.update(a.id, { status: status.value }), 'Status saved');
    });
    add('Status', status);
    const version = el('input');
    version.type = 'text';
    version.value = a.version;
    version.placeholder = 'e.g. 1.2.0';
    version.addEventListener('change', () => void act((b) => b.update(a.id, { version: version.value }), 'Version saved'));
    add('Version', version);
    const type = el('input');
    type.type = 'text';
    type.value = a.type;
    type.addEventListener('change', () => {
      if (type.value.trim().length > 0) void act((b) => b.update(a.id, { type: type.value }), 'Type saved');
    });
    add('Type', type);
    const category = el('input');
    category.type = 'text';
    category.value = a.category;
    category.addEventListener('change', () => void act((b) => b.update(a.id, { category: category.value }), 'Category saved'));
    add('Category', category);
    const kw = el('input');
    kw.type = 'text';
    kw.value = a.keywords.join(', ');
    kw.placeholder = 'comma-separated';
    kw.addEventListener('change', () => void act((b) => b.update(a.id, { keywords: kw.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0) }), 'Keywords saved'));
    add('Keywords', kw);
  } else {
    add('Status', a.status);
    add('Version', a.version);
    add('Keywords', a.keywords.join(', '));
  }
  add('Source', a.source);
  add('Owner', a.owner);
  add('Library', a.library);
  add('Execution', a.executionType);
  add('GSX endpoint', a.gsxEndpoint);
  add('Created', a.createdMs > 0 ? new Date(a.createdMs).toLocaleString() : '');
  add('Updated', a.updatedMs > 0 ? new Date(a.updatedMs).toLocaleString() : '');
  add('Enabled by', `${a.enabledBy} ${a.enabledBy === 1 ? 'person' : 'people'}`);
  add('Playbooks', `${a.contributedPlaybooks} contributed to`);
  metaWrap.appendChild(dl);
  root.appendChild(metaWrap);

  // Reachability
  const reachWrap = el('div');
  reachWrap.appendChild(section('Reachable via'));
  if (a.endpoints.length === 0) reachWrap.appendChild(el('p', 'reg-muted', a.gsxEndpoint.length > 0 ? `GSX endpoint ${a.gsxEndpoint}` : 'No endpoint registered.'));
  for (const e of a.endpoints) {
    const row = el('div', 'reg-endpoint');
    row.appendChild(el('span', `reg-chip kind ${e.kind}`, e.kind === 'api' ? 'RESTful' : e.kind.toUpperCase()));
    row.appendChild(el('span', 'url', e.url));
    if (e.channels.length > 0) row.appendChild(el('span', 'reg-muted', e.channels.join(', ')));
    if (writable) {
      const x = el('button', 'reg-chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove ${e.kind} endpoint`);
      x.addEventListener('click', () => void act((b) => b.removeEndpoint(a.id, e.id), 'Endpoint removed'));
      row.appendChild(x);
    }
    reachWrap.appendChild(row);
  }
  if (writable) {
    const row = el('div', 'reg-add');
    const kind = el('select');
    for (const [v, l] of [['mcp', 'MCP'], ['api', 'RESTful API'], ['skill', 'Skill']] as const) {
      const o = el('option', undefined, l);
      o.value = v;
      kind.appendChild(o);
    }
    const url = el('input');
    url.type = 'url';
    url.className = 'grow';
    url.placeholder = 'https://… (endpoint URL or skill location)';
    const btn = el('button', 'reg-btn small', 'Add endpoint');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (url.value.trim().length > 0) void act((b) => b.addEndpoint(a.id, kind.value as 'mcp' | 'api' | 'skill', url.value.trim(), []), 'Endpoint added');
    });
    row.appendChild(kind);
    row.appendChild(url);
    row.appendChild(btn);
    reachWrap.appendChild(row);
  }
  root.appendChild(reachWrap);

  // Belongs to
  const belongs = el('div');
  belongs.appendChild(section('Belongs to'));
  belongs.appendChild(el('div', 'reg-facet-title', 'IDWs'));
  belongs.appendChild(chipList(a.idws, writable ? (id) => void act((b) => b.link(a.id, 'idw', id, false), 'Removed from IDW') : null, 'Not deployed on an IDW.'));
  if (writable) belongs.appendChild(addRefRow(state.idws, a.idws, (id) => void act((b) => b.link(a.id, 'idw', id, true), 'Added to IDW'), null, 'IDW'));
  belongs.appendChild(el('div', 'reg-facet-title', 'Knowledge models'));
  belongs.appendChild(chipList(a.knowledgeModels, writable ? (id) => void act((b) => b.link(a.id, 'knowledge', id, false), 'Knowledge model unlinked') : null, 'Uses no knowledge model.'));
  if (writable) {
    belongs.appendChild(
      addRefRow(
        state.knowledge,
        a.knowledgeModels,
        (id) => void act((b) => b.link(a.id, 'knowledge', id, true), 'Knowledge model linked'),
        isAdmin
          ? (name, description) =>
              void act(async (b) => {
                const created = await b.createKnowledgeModel(name, description);
                if (created.ok !== true || created.value === undefined) return created as LiteRegistryResult<LiteRegistryAgentDetail>;
                state.knowledge = [...state.knowledge, created.value];
                return b.link(a.id, 'knowledge', created.value.id, true);
              }, 'Knowledge model created and linked')
          : null,
        'knowledge model'
      )
    );
  }
  belongs.appendChild(el('div', 'reg-facet-title', 'Skills (capabilities)'));
  const skills: Ref[] = [...a.capabilityNodes, ...a.capabilities.map((c) => ({ id: `text:${c}`, name: c, description: 'declared in the agent record', status: '' }))];
  belongs.appendChild(chipList(skills, writable ? (id) => (id.startsWith('text:') ? toast('Declared capabilities are edited in the agent record.') : void act((b) => b.link(a.id, 'capability', id, false), 'Skill unlinked')) : null, 'No skills recorded.'));
  if (writable) {
    belongs.appendChild(
      addRefRow(
        state.capabilities,
        a.capabilityNodes,
        (id) => void act((b) => b.link(a.id, 'capability', id, true), 'Skill linked'),
        isAdmin
          ? (name, description) =>
              void act(async (b) => {
                const created = await b.createCapability(name, description);
                if (created.ok !== true || created.value === undefined) return created as LiteRegistryResult<LiteRegistryAgentDetail>;
                state.capabilities = [...state.capabilities, created.value];
                return b.link(a.id, 'capability', created.value.id, true);
              }, 'Skill created and linked')
          : null,
        'skill'
      )
    );
  }
  if (a.usedInSpaces.length > 0) {
    belongs.appendChild(el('div', 'reg-facet-title', 'Used in Spaces'));
    belongs.appendChild(chipList(a.usedInSpaces.map((s) => ({ id: s.id, name: s.name, description: '', status: '' })), null, ''));
  }
  if (a.representedBy.length > 0) {
    belongs.appendChild(el('div', 'reg-facet-title', 'Represented by assets'));
    belongs.appendChild(el('p', 'reg-muted', a.representedBy.map((r) => (r.spaceName.length > 0 ? `in ${r.spaceName}` : 'uncategorized')).join(' · ')));
  }
  root.appendChild(belongs);

  // Checklist
  root.appendChild(
    buildChecklistPanel(cl, {
      isAdmin,
      canWrite: writable,
      onToggle: (checkId, value) => void act((b) => b.setManualCheck(a.id, checkId, value), value ? 'Check recorded' : 'Check cleared'),
      onListing: (listing) => void act((b) => b.setListing(a.id, listing), listing === 'listed' ? 'Listed on the platform' : `Marked ${listing}`),
    })
  );
  box.replaceChildren(root);
}

// ── Boot ─────────────────────────────────────────────────────────────
async function loadRefs(): Promise<void> {
  const b = bridge();
  if (b === null) return;
  const [idws, knowledge, caps] = await Promise.all([b.listIdws(), b.listKnowledgeModels(), b.listCapabilities()]);
  if (idws.ok === true && idws.value !== undefined) state.idws = idws.value;
  if (knowledge.ok === true && knowledge.value !== undefined) state.knowledge = knowledge.value;
  if (caps.ok === true && caps.value !== undefined) state.capabilities = caps.value;
  renderFacets();
}

function wire(): void {
  const q = $('reg-q') as HTMLInputElement | null;
  if (q !== null) {
    q.addEventListener('input', () => {
      state.filters.q = q.value;
      scheduleSearch();
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && q.value.length > 0) {
        q.value = '';
        state.filters.q = '';
        void runSearch(0);
        e.stopPropagation();
      }
    });
  }
  const del = $('reg-deleted') as HTMLInputElement | null;
  if (del !== null) del.addEventListener('change', () => {
    state.filters.includeDeleted = del.checked;
    void runSearch(0);
  });
  const more = $('reg-more');
  if (more !== null) more.addEventListener('click', () => void runSearch(state.items.length));
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      q?.focus();
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && state.items.length > 0) {
      e.preventDefault();
      const idx = state.items.findIndex((i) => i.id === state.selectedId);
      const next = e.key === 'ArrowDown' ? Math.min(state.items.length - 1, idx + 1) : Math.max(0, idx - 1);
      const item = state.items[next];
      if (item !== undefined) {
        void select(item.id);
        document.querySelector(`.reg-row[data-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    }
  });
}

if (typeof document !== 'undefined' && document.getElementById('reg-list') !== null) {
  wire();
  void loadViewer();
  void loadRefs();
  void runSearch(0);
}
