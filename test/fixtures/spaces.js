/**
 * Spaces Test Fixtures
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 */

let idCounter = 0;

/**
 * Create a test space
 */
export function createSpace(overrides = {}) {
  const id = overrides.id || `space-${++idCounter}`;
  return {
    id,
    name: overrides.name || 'Test Space',
    description: overrides.description || 'A test space for unit tests',
    items: overrides.items || [],
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    metadata: overrides.metadata || {},
    ...overrides
  };
}

/**
 * Create a clipboard item
 */
export function createClipboardItem(overrides = {}) {
  const id = overrides.id || `item-${++idCounter}`;
  return {
    id,
    content: overrides.content || 'Test clipboard content',
    type: overrides.type || 'text',
    sourceApp: overrides.sourceApp || 'Test App',
    timestamp: overrides.timestamp || new Date().toISOString(),
    preview: overrides.preview || null,
    metadata: overrides.metadata || {},
    ...overrides
  };
}

/**
 * Create a space with items
 */
export function createSpaceWithItems(itemCount = 3, overrides = {}) {
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    items.push(createClipboardItem({ content: `Item ${i + 1} content` }));
  }
  return createSpace({ items, ...overrides });
}

/**
 * Reset the ID counter (call between tests)
 */
export function resetIdCounter() {
  idCounter = 0;
}

export default {
  createSpace,
  createClipboardItem,
  createSpaceWithItems,
  resetIdCounter
};


