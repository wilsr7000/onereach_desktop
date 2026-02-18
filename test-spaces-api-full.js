/**
 * Comprehensive Spaces API Test Suite
 *
 * Tests all Spaces API functionality including:
 * - Space CRUD operations
 * - Item CRUD operations
 * - Tag operations (add, remove, set, list, filter)
 * - Metadata operations
 * - Smart folders
 * - Search functionality
 * - File operations
 */

const { getSpacesAPI } = require('./spaces-api');

// Test utilities
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(message, type = 'info') {
  const prefix = {
    info: `${colors.cyan}[INFO]${colors.reset}`,
    success: `${colors.green}[✓ PASS]${colors.reset}`,
    fail: `${colors.red}[✗ FAIL]${colors.reset}`,
    warn: `${colors.yellow}[WARN]${colors.reset}`,
    section: `${colors.bold}${colors.cyan}`,
  };

  if (type === 'section') {
    console.log(`\n${prefix.section}${'═'.repeat(60)}`);
    console.log(`  ${message}`);
    console.log(`${'═'.repeat(60)}${colors.reset}\n`);
  } else {
    console.log(`${prefix[type]} ${message}`);
  }
}

let passed = 0;
let failed = 0;
const testResults = [];

function assert(condition, testName, details = '') {
  if (condition) {
    passed++;
    log(`${testName}`, 'success');
    testResults.push({ name: testName, status: 'passed' });
    return true;
  } else {
    failed++;
    log(`${testName}${details ? ': ' + details : ''}`, 'fail');
    testResults.push({ name: testName, status: 'failed', details });
    return false;
  }
}

// Generate unique test ID to avoid conflicts
const testId = Date.now().toString(36);

async function runTests() {
  const api = getSpacesAPI();

  log('SPACES API COMPREHENSIVE TEST SUITE', 'section');
  log(`Test ID: ${testId}`);
  log(`Started at: ${new Date().toISOString()}\n`);

  let testSpaceId = null;
  let testItemId = null;
  let testItemId2 = null;
  let testSmartFolderId = null;

  try {
    // ═══════════════════════════════════════════════════════════
    // SPACE MANAGEMENT TESTS
    // ═══════════════════════════════════════════════════════════
    log('SPACE MANAGEMENT', 'section');

    // Test 1: List existing spaces
    const spaces = await api.list();
    assert(Array.isArray(spaces), 'List spaces returns array');
    log(`Found ${spaces.length} existing spaces`);

    // Test 2: Create a new space
    const testSpaceName = `Test Space ${testId}`;
    const newSpace = await api.create(testSpaceName, {
      icon: '🧪',
      color: '#ff6b6b',
    });
    assert(newSpace && newSpace.id, 'Create space returns space with ID');
    assert(newSpace.name === testSpaceName, 'Create space has correct name');
    assert(newSpace.icon === '🧪', 'Create space has correct icon');
    assert(newSpace.color === '#ff6b6b', 'Create space has correct color');
    testSpaceId = newSpace.id;
    log(`Created test space: ${testSpaceId}`);

    // Test 3: Get space by ID
    const retrievedSpace = await api.get(testSpaceId);
    assert(retrievedSpace !== null, 'Get space returns space object');
    assert(retrievedSpace.id === testSpaceId, 'Get space returns correct ID');
    assert(retrievedSpace.name === testSpaceName, 'Get space returns correct name');
    assert(retrievedSpace.itemCount === 0, 'New space has 0 items');

    // Test 4: Update space
    const updateResult = await api.update(testSpaceId, {
      name: `Updated ${testSpaceName}`,
      icon: '🔬',
      color: '#4ecdc4',
    });
    assert(updateResult === true, 'Update space returns true');

    const updatedSpace = await api.get(testSpaceId);
    assert(updatedSpace.icon === '🔬', 'Space icon was updated');
    assert(updatedSpace.color === '#4ecdc4', 'Space color was updated');

    // ═══════════════════════════════════════════════════════════
    // ITEM MANAGEMENT TESTS
    // ═══════════════════════════════════════════════════════════
    log('ITEM MANAGEMENT', 'section');

    // Test 5: Add text item
    const textItem = await api.items.add(testSpaceId, {
      type: 'text',
      content: 'This is a test text item for Spaces API testing.',
      metadata: {
        title: 'Test Text Item',
        description: 'A simple text item for testing',
      },
    });
    assert(textItem && textItem.id, 'Add text item returns item with ID');
    assert(textItem.type === 'text', 'Added item has correct type');
    assert(textItem.spaceId === testSpaceId, 'Added item has correct spaceId');
    testItemId = textItem.id;
    log(`Created test item: ${testItemId}`);

    // Test 6: Add another item with initial tags
    const taggedItem = await api.items.add(testSpaceId, {
      type: 'text',
      content: 'This item has initial tags set at creation.',
      metadata: {
        title: 'Tagged Item',
        tags: ['initial-tag', 'test-tag'],
      },
    });
    assert(taggedItem && taggedItem.id, 'Add tagged item returns item with ID');
    testItemId2 = taggedItem.id;
    log(`Created tagged item: ${testItemId2}`);

    // Test 7: Add HTML item
    const htmlItem = await api.items.add(testSpaceId, {
      type: 'html',
      content: '<h1>Test HTML</h1><p>This is <strong>formatted</strong> content.</p>',
      metadata: {
        title: 'Test HTML Item',
        sourceUrl: 'https://example.com/test',
      },
    });
    assert(htmlItem && htmlItem.id, 'Add HTML item returns item with ID');
    assert(htmlItem.type === 'html', 'HTML item has correct type');

    // Test 8: Add code item
    const codeItem = await api.items.add(testSpaceId, {
      type: 'code',
      content: 'function hello() {\n  console.log("Hello, World!");\n}',
      metadata: {
        title: 'Test Code Snippet',
        language: 'javascript',
      },
    });
    assert(codeItem && codeItem.id, 'Add code item returns item with ID');
    assert(codeItem.type === 'code', 'Code item has correct type');

    // Test 9: List items in space
    const items = await api.items.list(testSpaceId);
    assert(Array.isArray(items), 'List items returns array');
    assert(items.length >= 4, 'Space has at least 4 items');
    log(`Space has ${items.length} items`);

    // Test 10: List items with filters
    const textItems = await api.items.list(testSpaceId, { type: 'text' });
    assert(textItems.length >= 2, 'Filter by type returns correct items');
    log(`Found ${textItems.length} text items`);

    // Test 11: List items with includeContent
    const itemsWithContent = await api.items.list(testSpaceId, {
      limit: 2,
      includeContent: true,
    });
    assert(itemsWithContent.length <= 2, 'Limit parameter works');
    assert(itemsWithContent[0].content !== undefined, 'includeContent returns content');

    // Test 12: Get single item
    const retrievedItem = await api.items.get(testSpaceId, testItemId);
    assert(retrievedItem !== null, 'Get item returns item object');
    assert(retrievedItem.id === testItemId, 'Get item returns correct ID');
    assert(retrievedItem.content !== undefined, 'Get item includes content');

    // Test 13: Update item
    const itemUpdateResult = await api.items.update(testSpaceId, testItemId, {
      preview: 'Updated preview text',
    });
    assert(itemUpdateResult === true, 'Update item returns true');

    // Test 14: Toggle pin
    const pinResult = await api.items.togglePin(testSpaceId, testItemId);
    assert(typeof pinResult === 'boolean', 'Toggle pin returns boolean');
    log(`Item pinned: ${pinResult}`);

    // Toggle back
    await api.items.togglePin(testSpaceId, testItemId);

    // ═══════════════════════════════════════════════════════════
    // TAG OPERATIONS TESTS
    // ═══════════════════════════════════════════════════════════
    log('TAG OPERATIONS', 'section');

    // Test 15: Add tag to item
    const newTags = await api.items.addTag(testSpaceId, testItemId, 'important');
    assert(Array.isArray(newTags), 'addTag returns array');
    assert(newTags.includes('important'), 'addTag adds tag correctly');
    log(`Tags after addTag: [${newTags.join(', ')}]`);

    // Test 16: Add multiple tags
    await api.items.addTag(testSpaceId, testItemId, 'test');
    await api.items.addTag(testSpaceId, testItemId, 'api-test');
    await api.items.addTag(testSpaceId, testItemId, 'spaces');

    const tagsAfterMultiple = await api.items.getTags(testSpaceId, testItemId);
    assert(tagsAfterMultiple.length >= 4, 'Multiple tags added');
    log(`Tags after multiple adds: [${tagsAfterMultiple.join(', ')}]`);

    // Test 17: Don't add duplicate tag (case-insensitive)
    const tagsBeforeDup = await api.items.getTags(testSpaceId, testItemId);
    await api.items.addTag(testSpaceId, testItemId, 'IMPORTANT'); // Duplicate
    const tagsAfterDup = await api.items.getTags(testSpaceId, testItemId);
    assert(tagsAfterDup.length === tagsBeforeDup.length, 'Duplicate tag not added');

    // Test 18: Get tags for item
    const itemTags = await api.items.getTags(testSpaceId, testItemId);
    assert(Array.isArray(itemTags), 'getTags returns array');
    assert(itemTags.includes('important'), 'getTags contains expected tag');
    log(`Current tags: [${itemTags.join(', ')}]`);

    // Test 19: Remove tag from item
    const tagsAfterRemove = await api.items.removeTag(testSpaceId, testItemId, 'test');
    assert(Array.isArray(tagsAfterRemove), 'removeTag returns array');
    assert(!tagsAfterRemove.includes('test'), 'removeTag removes tag correctly');
    log(`Tags after remove: [${tagsAfterRemove.join(', ')}]`);

    // Test 20: Set tags (replace all)
    const setTagsResult = await api.items.setTags(testSpaceId, testItemId, [
      'replaced-tag-1',
      'replaced-tag-2',
      'replaced-tag-3',
    ]);
    assert(setTagsResult === true, 'setTags returns true');

    const tagsAfterSet = await api.items.getTags(testSpaceId, testItemId);
    assert(tagsAfterSet.length === 3, 'setTags replaces all tags');
    assert(tagsAfterSet.includes('replaced-tag-1'), 'setTags includes new tags');
    log(`Tags after setTags: [${tagsAfterSet.join(', ')}]`);

    // Test 21: List all tags in space
    const spaceTags = await api.tags.list(testSpaceId);
    assert(Array.isArray(spaceTags), 'tags.list returns array');
    assert(spaceTags.length > 0, 'Space has tags');
    log(`Space tags: ${JSON.stringify(spaceTags.slice(0, 5))}`);

    // Verify tag count structure
    if (spaceTags.length > 0) {
      const firstTag = spaceTags[0];
      assert(firstTag.tag !== undefined, 'Tag entry has tag property');
      assert(typeof firstTag.count === 'number', 'Tag entry has count property');
    }

    // Test 22: List all tags across all spaces
    const allTags = await api.tags.listAll();
    assert(Array.isArray(allTags), 'tags.listAll returns array');
    log(`Total unique tags across all spaces: ${allTags.length}`);

    if (allTags.length > 0) {
      const firstTag = allTags[0];
      assert(Array.isArray(firstTag.spaces), 'Global tag has spaces array');
    }

    // Test 23: Filter items by tags (ALL must match)
    await api.items.setTags(testSpaceId, testItemId, ['filter-test', 'category-a']);
    await api.items.setTags(testSpaceId, testItemId2, ['filter-test', 'category-b']);

    const filteredAll = await api.items.list(testSpaceId, {
      tags: ['filter-test'],
    });
    assert(filteredAll.length >= 2, 'Filter by single tag returns multiple items');
    log(`Items with 'filter-test' tag: ${filteredAll.length}`);

    // Test 24: Filter items by tags (ANY must match)
    const filteredAny = await api.items.list(testSpaceId, {
      anyTags: ['category-a', 'category-b'],
    });
    assert(filteredAny.length >= 2, 'Filter by anyTags returns items');
    log(`Items with category-a OR category-b: ${filteredAny.length}`);

    // Test 25: Find items by tags using tags API
    const foundByTags = await api.tags.findItems(['filter-test'], {
      spaceId: testSpaceId,
      matchAll: false,
    });
    assert(foundByTags.length >= 2, 'tags.findItems finds items');
    log(`Found ${foundByTags.length} items by tag search`);

    // Test 26: Find items requiring ALL tags
    const foundByAllTags = await api.tags.findItems(['filter-test', 'category-a'], {
      spaceId: testSpaceId,
      matchAll: true,
    });
    assert(foundByAllTags.length >= 1, 'tags.findItems with matchAll works');
    log(`Found ${foundByAllTags.length} items matching ALL tags`);

    // Test 27: Rename tag in space
    await api.items.addTag(testSpaceId, testItemId, 'to-be-renamed');
    const renamedCount = await api.tags.rename(testSpaceId, 'to-be-renamed', 'was-renamed');
    assert(typeof renamedCount === 'number', 'tags.rename returns count');
    assert(renamedCount >= 1, 'tags.rename renamed at least one item');

    const tagsAfterRename = await api.items.getTags(testSpaceId, testItemId);
    assert(tagsAfterRename.includes('was-renamed'), 'Tag was actually renamed');
    assert(!tagsAfterRename.includes('to-be-renamed'), 'Old tag name removed');
    log(`Renamed tag on ${renamedCount} item(s)`);

    // Test 28: Delete tag from all items in space
    await api.items.addTag(testSpaceId, testItemId, 'to-delete');
    await api.items.addTag(testSpaceId, testItemId2, 'to-delete');

    const deleteCount = await api.tags.deleteFromSpace(testSpaceId, 'to-delete');
    assert(typeof deleteCount === 'number', 'tags.deleteFromSpace returns count');
    assert(deleteCount >= 2, 'Deleted tag from multiple items');
    log(`Deleted tag from ${deleteCount} item(s)`);

    // ═══════════════════════════════════════════════════════════
    // METADATA OPERATIONS TESTS
    // ═══════════════════════════════════════════════════════════
    log('METADATA OPERATIONS', 'section');

    // Test 29: Get space metadata
    const spaceMetadata = await api.metadata.getSpace(testSpaceId);
    assert(spaceMetadata !== null, 'getSpace metadata returns object');
    log(`Space metadata keys: ${Object.keys(spaceMetadata || {}).join(', ')}`);

    // Test 30: Update space metadata
    const metadataUpdate = await api.metadata.updateSpace(testSpaceId, {
      description: 'Test space for API testing',
      customField: 'Custom value',
      testTimestamp: Date.now(),
    });
    assert(metadataUpdate !== null, 'updateSpace metadata returns result');

    const updatedMetadata = await api.metadata.getSpace(testSpaceId);
    assert(updatedMetadata.description === 'Test space for API testing', 'Metadata description updated');
    assert(updatedMetadata.customField === 'Custom value', 'Custom metadata field saved');

    // Test 31: Set asset metadata
    const assetResult = await api.metadata.setAsset(testSpaceId, 'testAsset', {
      path: 'assets/test.png',
      type: 'image',
      width: 200,
      height: 200,
    });
    assert(assetResult !== null, 'setAsset returns result');

    // Test 32: Set approval
    const approvalResult = await api.metadata.setApproval(testSpaceId, 'item', testItemId, true);
    assert(approvalResult !== null, 'setApproval returns result');

    // Test 33: Add version
    const versionResult = await api.metadata.addVersion(testSpaceId, {
      version: '1.0.0',
      notes: 'Initial test version',
      author: 'test-script',
    });
    assert(versionResult !== null, 'addVersion returns result');

    // Test 34: Update project config
    const configResult = await api.metadata.updateProjectConfig(testSpaceId, {
      type: 'test-project',
      settings: {
        testSetting: true,
      },
    });
    assert(configResult !== null, 'updateProjectConfig returns result');

    // ═══════════════════════════════════════════════════════════
    // SMART FOLDERS TESTS
    // ═══════════════════════════════════════════════════════════
    log('SMART FOLDERS', 'section');

    // Test 35: List smart folders
    const smartFolders = await api.smartFolders.list();
    assert(Array.isArray(smartFolders), 'smartFolders.list returns array');
    log(`Existing smart folders: ${smartFolders.length}`);

    // Test 36: Create smart folder
    await api.items.setTags(testSpaceId, testItemId, ['smart-test', 'priority-high']);
    await api.items.setTags(testSpaceId, testItemId2, ['smart-test', 'priority-low']);

    const newFolder = await api.smartFolders.create(
      `Test Smart Folder ${testId}`,
      {
        tags: ['smart-test'],
        types: ['text'],
        spaces: [testSpaceId],
      },
      {
        icon: '📁',
        color: '#9b59b6',
      }
    );
    assert(newFolder && newFolder.id, 'Create smart folder returns folder with ID');
    assert(newFolder.name.includes('Test Smart Folder'), 'Smart folder has correct name');
    testSmartFolderId = newFolder.id;
    log(`Created smart folder: ${testSmartFolderId}`);

    // Test 37: Get smart folder
    const retrievedFolder = await api.smartFolders.get(testSmartFolderId);
    assert(retrievedFolder !== null, 'Get smart folder returns folder');
    assert(retrievedFolder.criteria.tags.includes('smart-test'), 'Smart folder has correct criteria');

    // Test 38: Get smart folder items
    const folderItems = await api.smartFolders.getItems(testSmartFolderId);
    assert(Array.isArray(folderItems), 'getItems returns array');
    assert(folderItems.length >= 2, 'Smart folder finds matching items');
    log(`Smart folder contains ${folderItems.length} items`);

    // Test 39: Preview smart folder criteria (without saving)
    const previewItems = await api.smartFolders.preview({
      tags: ['priority-high'],
      spaces: [testSpaceId],
    });
    assert(Array.isArray(previewItems), 'preview returns array');
    log(`Preview found ${previewItems.length} items matching criteria`);

    // Test 40: Update smart folder
    const folderUpdateResult = await api.smartFolders.update(testSmartFolderId, {
      name: `Updated Smart Folder ${testId}`,
      color: '#e74c3c',
    });
    assert(folderUpdateResult !== null, 'Update smart folder returns folder');
    assert(folderUpdateResult.color === '#e74c3c', 'Smart folder color updated');

    // ═══════════════════════════════════════════════════════════
    // SEARCH TESTS
    // ═══════════════════════════════════════════════════════════
    log('SEARCH', 'section');

    // Test 41: Search items by content
    const searchResults = await api.search('test', { limit: 10 });
    assert(Array.isArray(searchResults), 'search returns array');
    assert(searchResults.length > 0, 'Search finds items');
    log(`Search 'test' found ${searchResults.length} items`);

    // Test 42: Search with space filter
    const spaceSearchResults = await api.search('test', {
      spaceId: testSpaceId,
      limit: 10,
    });
    assert(spaceSearchResults.length > 0, 'Search within space works');
    assert(
      spaceSearchResults.every((item) => item.spaceId === testSpaceId),
      'All results from specified space'
    );

    // Test 43: Search with type filter
    const typeSearchResults = await api.search('test', {
      type: 'text',
      limit: 10,
    });
    assert(
      typeSearchResults.every((item) => item.type === 'text'),
      'Type filter works in search'
    );

    // Test 44: Search includes tags
    const tagSearchResults = await api.search('smart-test', {
      spaceId: testSpaceId,
      searchTags: true,
    });
    assert(tagSearchResults.length > 0, 'Search finds items by tag');
    log(`Search by tag found ${tagSearchResults.length} items`);

    // ═══════════════════════════════════════════════════════════
    // FILE SYSTEM TESTS
    // ═══════════════════════════════════════════════════════════
    log('FILE SYSTEM', 'section');

    // Test 45: Get space path
    const spacePath = await api.files.getSpacePath(testSpaceId);
    assert(typeof spacePath === 'string', 'getSpacePath returns string');
    assert(spacePath.includes(testSpaceId), 'Space path includes space ID');
    log(`Space path: ${spacePath}`);

    // Test 46: Write file to space
    const writeResult = await api.files.write(testSpaceId, 'test-files/test.txt', 'Test file content');
    assert(writeResult === true, 'Write file returns true');

    // Test 47: List files in space
    const fileList = await api.files.list(testSpaceId, 'test-files');
    assert(Array.isArray(fileList), 'List files returns array');
    assert(fileList.length >= 1, 'Can list written file');
    log(`Files in test-files: ${fileList.map((f) => f.name).join(', ')}`);

    // Test 48: Read file from space
    const fileContent = await api.files.read(testSpaceId, 'test-files/test.txt');
    assert(fileContent === 'Test file content', 'Read file returns correct content');

    // Test 49: Delete file from space
    const deleteFileResult = await api.files.delete(testSpaceId, 'test-files/test.txt');
    assert(deleteFileResult === true, 'Delete file returns true');

    const deletedContent = await api.files.read(testSpaceId, 'test-files/test.txt');
    assert(deletedContent === null, 'Deleted file no longer readable');

    // ═══════════════════════════════════════════════════════════
    // MOVE ITEM TESTS
    // ═══════════════════════════════════════════════════════════
    log('ITEM MOVE', 'section');

    // Test 50: Move item to different space
    const moveItem = await api.items.add(testSpaceId, {
      type: 'text',
      content: 'Item to be moved',
    });

    const moveResult = await api.items.move(moveItem.id, testSpaceId, 'unclassified');
    assert(moveResult === true, 'Move item returns true');

    const movedItem = await api.items.get('unclassified', moveItem.id);
    assert(movedItem && movedItem.spaceId === 'unclassified', 'Item moved to new space');

    // ═══════════════════════════════════════════════════════════
    // CLEANUP TESTS
    // ═══════════════════════════════════════════════════════════
    log('CLEANUP', 'section');

    // Test 51: Delete smart folder
    if (testSmartFolderId) {
      const deleteFolderResult = await api.smartFolders.delete(testSmartFolderId);
      assert(deleteFolderResult === true, 'Delete smart folder returns true');

      const deletedFolder = await api.smartFolders.get(testSmartFolderId);
      assert(deletedFolder === null, 'Smart folder actually deleted');
    }

    // Test 52: Delete items
    const deleteItemResult = await api.items.delete(testSpaceId, testItemId);
    assert(deleteItemResult === true, 'Delete item returns true');

    await api.items.delete(testSpaceId, testItemId2);

    // Clean up moved item
    await api.items.delete('unclassified', moveItem.id);

    // Test 53: Delete space
    if (testSpaceId) {
      const deleteSpaceResult = await api.delete(testSpaceId);
      assert(deleteSpaceResult === true, 'Delete space returns true');

      const deletedSpace = await api.get(testSpaceId);
      assert(deletedSpace === null, 'Space actually deleted');
    }

    // ═══════════════════════════════════════════════════════════
    // EVENT SYSTEM TESTS
    // ═══════════════════════════════════════════════════════════
    log('EVENT SYSTEM', 'section');

    // Test 54: Event listener
    let eventReceived = false;
    const unsubscribe = api.on('space:created', (_data) => {
      eventReceived = true;
    });

    // Create a space to trigger event
    const eventTestSpace = await api.create(`Event Test ${testId}`, { icon: '🔔' });

    // Give event system a moment
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    assert(eventReceived === true, 'Event listener receives events');

    // Test 55: Unsubscribe works
    unsubscribe();
    eventReceived = false;

    const eventTestSpace2 = await api.create(`Event Test 2 ${testId}`, { icon: '🔕' });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    assert(eventReceived === false, 'Unsubscribe stops events');

    // Cleanup event test spaces
    await api.delete(eventTestSpace.id);
    await api.delete(eventTestSpace2.id);
  } catch (error) {
    log(`Unexpected error: ${error.message}\n${error.stack}`, 'fail');
    failed++;
  }

  // ═══════════════════════════════════════════════════════════
  // TEST SUMMARY
  // ═══════════════════════════════════════════════════════════
  log('TEST SUMMARY', 'section');

  const total = passed + failed;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;

  console.log(`${colors.bold}Total Tests:${colors.reset} ${total}`);
  console.log(`${colors.green}Passed:${colors.reset} ${passed}`);
  console.log(`${colors.red}Failed:${colors.reset} ${failed}`);
  console.log(`${colors.cyan}Pass Rate:${colors.reset} ${passRate}%`);
  console.log(`\nCompleted at: ${new Date().toISOString()}`);

  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}Failed Tests:${colors.reset}`);
    testResults
      .filter((r) => r.status === 'failed')
      .forEach((r) => console.log(`  - ${r.name}${r.details ? `: ${r.details}` : ''}`));
  }

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run the tests
runTests().catch((error) => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
