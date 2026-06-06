/**
 * Agent Explorer -- custom IDW lifecycle UI wiring.
 *
 * The renderer is a legacy inline-script HTML file, so this pins the
 * critical call sites that expose manual custom IDW add/edit/remove in
 * the marketplace and route them to the canonical preload APIs.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'agent-explorer.html'), 'utf8');

describe('Agent Explorer custom IDW UI wiring', () => {
  it('exposes manual add from the Agent Marketplace view', () => {
    expect(source).toContain('Add IDW Manually');
    expect(source).toContain('idwMarketplaceActions');
    expect(source).toContain('showAddIDWForm()');
    expect(source).toContain('addIDWEnvironment(env)');
  });

  it('exposes edit for custom menu-backed IDWs and routes to updateIDWEnvironment', () => {
    expect(source).toContain('idw._menuEntry ? `<button class="btn-accent" onclick="showEditIDWForm');
    expect(source).toContain('function showEditIDWForm(idwId)');
    expect(source).toContain('async function submitEditIDW(idwId)');
    expect(source).toContain('updateIDWEnvironment(menuId, updates)');
  });

  it('exposes remove and routes to removeIDWEnvironment', () => {
    expect(source).toContain('async function removeIDW(idwId)');
    expect(source).toContain('removeIDWEnvironment(idwId)');
    expect(source).toContain('Remove from Menu');
  });
});
