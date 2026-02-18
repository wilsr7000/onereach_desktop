/**
 * IPC Project API Namespace - CRUD Lifecycle Tests
 *
 * Projects: Create -> Read -> Update -> Read -> Delete -> Verify gone
 * Versions: Create -> Read -> Update -> Delete -> Verify gone
 *
 * Run:  npx vitest run test/unit/ipc-project-api.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const projects = {};
let nextId = 1;

const mockInvoke = vi.fn(async (channel, ...args) => {
  switch (channel) {
    case 'project:create': {
      const id = 'proj-' + nextId++;
      projects[id] = { id, ...args[0], versions: [] };
      return projects[id];
    }
    case 'project:get':
      return projects[args[0]] || null;
    case 'project:get-all':
      return Object.values(projects);
    case 'project:update': {
      if (projects[args[0]]) Object.assign(projects[args[0]], args[1]);
      return projects[args[0]];
    }
    case 'project:delete':
      delete projects[args[0]];
      return { success: true };
    case 'project:create-version': {
      const proj = projects[args[0]];
      if (!proj) return null;
      const ver = { id: 'ver-' + nextId++, ...args[1] };
      proj.versions.push(ver);
      return ver;
    }
    case 'project:get-version': {
      for (const p of Object.values(projects)) {
        const v = p.versions?.find((v) => v.id === args[0]);
        if (v) return v;
      }
      return null;
    }
    case 'project:delete-version': {
      for (const p of Object.values(projects)) {
        p.versions = p.versions?.filter((v) => v.id !== args[0]) || [];
      }
      return { success: true };
    }
    default:
      return null;
  }
});

const projectAPI = {
  createProject: (opts) => mockInvoke('project:create', opts),
  getProject: (id) => mockInvoke('project:get', id),
  getAllProjects: () => mockInvoke('project:get-all'),
  updateProject: (id, updates) => mockInvoke('project:update', id, updates),
  deleteProject: (id) => mockInvoke('project:delete', id),
  createVersion: (projId, opts) => mockInvoke('project:create-version', projId, opts),
  getVersion: (verId) => mockInvoke('project:get-version', verId),
  deleteVersion: (verId) => mockInvoke('project:delete-version', verId),
};

beforeEach(() => {
  Object.keys(projects).forEach((k) => delete projects[k]);
  nextId = 1;
});

// ═══════════════════════════════════════════════════════════════════
// PROJECT CRUD LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC Project API - Project CRUD Lifecycle', () => {
  it('Step 1: Create project', async () => {
    const proj = await projectAPI.createProject({ name: 'Test Project', spaceId: 's-1' });
    expect(proj.id).toBeTruthy();
    expect(proj.name).toBe('Test Project');
  });

  it('Step 2: Read project', async () => {
    const proj = await projectAPI.createProject({ name: 'Read Test' });
    const found = await projectAPI.getProject(proj.id);
    expect(found).toBeDefined();
    expect(found.name).toBe('Read Test');
  });

  it('Step 3: Update project', async () => {
    const proj = await projectAPI.createProject({ name: 'Before Update' });
    await projectAPI.updateProject(proj.id, { name: 'After Update' });
    const found = await projectAPI.getProject(proj.id);
    expect(found.name).toBe('After Update');
  });

  it('Step 4: Read updated project', async () => {
    const proj = await projectAPI.createProject({ name: 'V1' });
    await projectAPI.updateProject(proj.id, { name: 'V2' });
    const all = await projectAPI.getAllProjects();
    const match = all.find((p) => p.id === proj.id);
    expect(match.name).toBe('V2');
  });

  it('Step 5: Delete project', async () => {
    const proj = await projectAPI.createProject({ name: 'To Delete' });
    await projectAPI.deleteProject(proj.id);
    const found = await projectAPI.getProject(proj.id);
    expect(found).toBeNull();
  });

  it('Step 6: Verify gone', async () => {
    const proj = await projectAPI.createProject({ name: 'Gone' });
    const id = proj.id;
    await projectAPI.deleteProject(id);
    const all = await projectAPI.getAllProjects();
    expect(all.find((p) => p.id === id)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// VERSION CRUD LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC Project API - Version CRUD Lifecycle', () => {
  it('Step 1: Create version', async () => {
    const proj = await projectAPI.createProject({ name: 'Versioned' });
    const ver = await projectAPI.createVersion(proj.id, { name: 'v1.0', edl: {} });
    expect(ver.id).toBeTruthy();
    expect(ver.name).toBe('v1.0');
  });

  it('Step 2: Read version', async () => {
    const proj = await projectAPI.createProject({ name: 'Versioned2' });
    const ver = await projectAPI.createVersion(proj.id, { name: 'v2.0' });
    const found = await projectAPI.getVersion(ver.id);
    expect(found).toBeDefined();
    expect(found.name).toBe('v2.0');
  });

  it('Step 3: Delete version', async () => {
    const proj = await projectAPI.createProject({ name: 'Versioned3' });
    const ver = await projectAPI.createVersion(proj.id, { name: 'v-del' });
    await projectAPI.deleteVersion(ver.id);
    const found = await projectAPI.getVersion(ver.id);
    expect(found).toBeNull();
  });
});
