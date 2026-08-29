/**
 * Settings → Agentic memory: the user's connected memory MCP servers.
 * Per ADR-079.
 *
 * Multiple servers, each {name, URL, optional API key, optional tool
 * name}. Space items are pushed to every connected server by the
 * "Send to agentic memory" action in Spaces; each item carries a
 * per-server, content-hash-keyed ingested flag.
 *
 * Credential handling mirrors the OAGI section: the API key field is
 * write-only -- the list shows only "key saved", and the bridge never
 * returns the stored value to any renderer.
 *
 * Same conventions as the other sections: self-mounting, returns a
 * disposer, talks only through the preload bridge (`window.lite.memory`).
 */

/// <reference path="../../lite-window.d.ts" />

function bridgeOrThrow(): NonNullable<NonNullable<typeof window.lite>['memory']> {
  const m = window.lite?.memory;
  if (m === undefined) {
    throw new Error('preload bridge `window.lite.memory` is not available');
  }
  return m;
}

export function mountAgenticMemory(
  container: HTMLElement
): (() => void) | undefined {
  const wrap = document.createElement('div');
  wrap.className = 'memory-pane';

  const intro = document.createElement('p');
  intro.className = 'pane-intro';
  intro.textContent =
    'Connect one or more agentic-memory MCP servers. "Send to agentic memory" ' +
    'on a Space pushes every item to each connected server, skipping items a ' +
    'server has already ingested (tracked per item by content hash, so edited ' +
    'items are re-sent automatically).';
  wrap.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'memory-server-list';
  wrap.appendChild(list);

  const note = document.createElement('p');
  note.className = 'pane-note';
  wrap.appendChild(note);

  // ── Add form ────────────────────────────────────────────────────────
  const form = document.createElement('div');
  form.className = 'memory-add-form';

  const heading = document.createElement('h3');
  heading.className = 'memory-add-heading';
  heading.textContent = 'Add a memory server';
  form.appendChild(heading);

  const field = (
    labelText: string,
    id: string,
    type: string,
    placeholder: string
  ): HTMLInputElement => {
    const label = document.createElement('label');
    label.textContent = labelText;
    label.setAttribute('for', id);
    form.appendChild(label);
    const input = document.createElement('input');
    input.type = type;
    input.id = id;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    form.appendChild(input);
    return input;
  };

  const nameInput = field('Name', 'memory-name', 'text', 'Team memory');
  const urlInput = field(
    'MCP server URL',
    'memory-url',
    'url',
    'https://memory.example.com/mcp'
  );
  const keyInput = field(
    'API key (optional)',
    'memory-key',
    'password',
    'Sent as Authorization: Bearer …'
  );
  const toolInput = field(
    'Ingestion tool name (optional)',
    'memory-tool',
    'text',
    'Auto-detected from the server when blank'
  );

  const keyNote = document.createElement('p');
  keyNote.className = 'pane-note';
  keyNote.textContent =
    'Stored in your account config. Never displayed back to the screen once saved.';
  form.appendChild(keyNote);

  const actions = document.createElement('div');
  actions.className = 'dev-actions';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-primary';
  addBtn.textContent = 'Add server';
  actions.appendChild(addBtn);
  form.appendChild(actions);

  wrap.appendChild(form);
  container.appendChild(wrap);

  // ── Rendering ───────────────────────────────────────────────────────
  const renderList = (servers: LiteMemoryServerView[]): void => {
    list.textContent = '';
    if (servers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pane-note';
      empty.textContent = 'No memory servers connected yet.';
      list.appendChild(empty);
      return;
    }
    for (const server of servers) {
      const row = document.createElement('div');
      row.className = 'memory-server-row';

      const info = document.createElement('div');
      info.className = 'memory-server-info';
      const title = document.createElement('div');
      title.className = 'memory-server-name';
      title.textContent = server.name;
      info.appendChild(title);
      const detail = document.createElement('div');
      detail.className = 'memory-server-detail';
      const bits = [server.url];
      if (server.hasApiKey) bits.push('key saved');
      if (server.toolName !== undefined) bits.push(`tool: ${server.toolName}`);
      detail.textContent = bits.join('  ·  ');
      info.appendChild(detail);
      const status = document.createElement('div');
      status.className = 'memory-server-status pane-note';
      info.appendChild(status);
      row.appendChild(info);

      const rowActions = document.createElement('div');
      rowActions.className = 'memory-server-actions';

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn-secondary';
      testBtn.textContent = 'Test';
      testBtn.addEventListener('click', () => {
        testBtn.disabled = true;
        status.textContent = 'Connecting…';
        void bridgeOrThrow()
          .testServer(server.id)
          .then((res) => {
            if (res.ok) {
              status.textContent =
                res.value.ingestTool !== null
                  ? `Connected — ${res.value.toolCount} tools, will ingest via "${res.value.ingestTool}".`
                  : `Connected — ${res.value.toolCount} tools, but no ingestion tool recognized. Set a tool name.`;
            } else {
              status.textContent = res.error.message;
            }
          })
          .catch((err: unknown) => {
            status.textContent =
              err instanceof Error ? err.message : 'Test failed.';
          })
          .finally(() => {
            testBtn.disabled = false;
          });
      });
      rowActions.appendChild(testBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-secondary';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        removeBtn.disabled = true;
        void bridgeOrThrow()
          .removeServer(server.id)
          .then(() => load())
          .catch((err: unknown) => {
            status.textContent =
              err instanceof Error ? err.message : 'Remove failed.';
            removeBtn.disabled = false;
          });
      });
      rowActions.appendChild(removeBtn);

      row.appendChild(rowActions);
      list.appendChild(row);
    }
  };

  const load = async (): Promise<void> => {
    let bridge: ReturnType<typeof bridgeOrThrow>;
    try {
      bridge = bridgeOrThrow();
    } catch {
      note.textContent = 'Bridge unavailable — reload the window.';
      return;
    }
    try {
      const res = await bridge.listServers();
      if (res.ok) {
        renderList(res.value);
        note.textContent = '';
      } else {
        note.textContent = res.error.message;
      }
    } catch {
      note.textContent = 'Could not read the server list.';
    }
  };

  addBtn.addEventListener('click', () => {
    addBtn.disabled = true;
    note.textContent = '';
    const input: { name: string; url: string; apiKey?: string; toolName?: string } = {
      name: nameInput.value,
      url: urlInput.value,
    };
    if (keyInput.value.length > 0) input.apiKey = keyInput.value;
    if (toolInput.value.length > 0) input.toolName = toolInput.value;
    void bridgeOrThrow()
      .addServer(input)
      .then((res) => {
        if (res.ok) {
          nameInput.value = '';
          urlInput.value = '';
          keyInput.value = '';
          toolInput.value = '';
          return load();
        }
        note.textContent = res.error.message;
        return undefined;
      })
      .catch((err: unknown) => {
        note.textContent = err instanceof Error ? err.message : 'Add failed.';
      })
      .finally(() => {
        addBtn.disabled = false;
      });
  });

  void load();
  return undefined;
}
