#!/usr/bin/env node
/**
 * Full end-to-end test for Spaces Git integration.
 * 
 * Tests:
 * 1. SpacesGit wrapper (lib/spaces-git.js)
 * 2. Migration (lib/spaces-migration.js)
 * 3. Metadata schema v3 (lib/metadata-schema.js)
 * 4. API endpoint handlers via direct calls
 * 
 * Uses a COPY of real OR-Spaces data. Never touches production.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), `or-spaces-git-fulltest-${Date.now()}`);
const OR_SPACES = path.join(os.homedir(), 'Documents', 'OR-Spaces');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.log(`  FAIL: ${testName}`);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name.startsWith('backup-')) continue;
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

async function runTests() {
  console.log('=== Spaces Git Full Test Suite ===\n');

  // ── Setup ────────────────────────────────────────────────────────────────
  console.log('[SETUP] Copying OR-Spaces to temp dir...');
  copyDir(OR_SPACES, TEST_DIR);
  console.log(`  Source: ${OR_SPACES}`);
  console.log(`  Dest:   ${TEST_DIR}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST SUITE 1: SpacesGit Wrapper
  // ══════════════════════════════════════════════════════════════════════════
  console.log('--- Suite 1: SpacesGit Wrapper ---\n');

  const { SpacesGit } = require('./lib/spaces-git');
  const spacesGit = new SpacesGit(TEST_DIR);

  // 1.1 Pre-init state
  assert(!spacesGit.isInitialized(), 'isInitialized() returns false before init');
  assert(!spacesGit.isV3(), 'isV3() returns false before migration');

  // 1.2 Init
  const initResult = await spacesGit.init();
  assert(!initResult.alreadyInitialized, 'init() returns alreadyInitialized: false on first run');
  assert(spacesGit.isInitialized(), 'isInitialized() returns true after init');
  assert(fs.existsSync(path.join(TEST_DIR, '.git')), '.git directory exists');
  assert(fs.existsSync(path.join(TEST_DIR, '.gitignore')), '.gitignore file exists');

  // 1.3 Re-init is idempotent
  const reInitResult = await spacesGit.init();
  assert(reInitResult.alreadyInitialized, 'init() returns alreadyInitialized: true on second run');

  // 1.4 Commit all
  const commitResult = await spacesGit.commitAll({
    message: 'Test: initial commit',
    authorName: 'test-runner',
    authorEmail: 'test@onereach.ai',
  });
  assert(commitResult.sha && commitResult.sha.length === 40, 'commitAll() returns 40-char SHA');
  assert(commitResult.filesChanged > 0, `commitAll() staged ${commitResult.filesChanged} files`);

  // 1.5 Status after clean commit
  const statusClean = await spacesGit.status();
  assert(statusClean.clean > 0, `status() shows ${statusClean.clean} clean files`);
  assert(statusClean.modified.length === 0, 'status() shows 0 modified files after commit');
  assert(statusClean.added.length === 0, 'status() shows 0 added files after commit');

  // 1.6 Log
  const log1 = await spacesGit.log({ depth: 5 });
  assert(log1.length === 1, 'log() shows 1 commit');
  assert(log1[0].message === 'Test: initial commit', 'log() commit message matches');
  assert(log1[0].author === 'test-runner', 'log() author matches');
  assert(log1[0].sha === commitResult.sha, 'log() SHA matches commit SHA');
  assert(log1[0].timestamp, 'log() has timestamp');
  assert(Array.isArray(log1[0].parentShas), 'log() has parentShas array');

  // 1.7 Modify a file and commit specific paths
  const spacesDir = path.join(TEST_DIR, 'spaces');
  const firstSpace = fs.readdirSync(spacesDir, { withFileTypes: true })
    .find(d => d.isDirectory() && !d.name.startsWith('.'));
  const testMetaPath = path.join(spacesDir, firstSpace.name, 'space-metadata.json');
  const testRelPath = `spaces/${firstSpace.name}/space-metadata.json`;

  const meta = JSON.parse(fs.readFileSync(testMetaPath, 'utf8'));
  meta._testField = 'test-value-1';
  fs.writeFileSync(testMetaPath, JSON.stringify(meta, null, 2));

  const commitSpecific = await spacesGit.commit({
    filepaths: [testRelPath],
    message: 'Test: modify specific file',
    authorName: 'specific-committer',
  });
  assert(commitSpecific.sha && commitSpecific.sha.length === 40, 'commit() with specific filepaths returns SHA');

  // 1.8 Diff between two commits
  const diffResult = await spacesGit.diff(commitResult.sha, commitSpecific.sha);
  assert(diffResult.length === 1, 'diff() shows 1 changed file');
  assert(diffResult[0].filepath === testRelPath, 'diff() changed file path matches');
  assert(diffResult[0].status === 'modified', 'diff() status is modified');

  // 1.9 Read file at historical commit
  const oldContent = await spacesGit.readJSONAtCommit(commitResult.sha, testRelPath);
  assert(oldContent !== null, 'readJSONAtCommit() returns content for valid commit');
  assert(!oldContent._testField, 'readJSONAtCommit() shows file without test field at old commit');

  const newContent = await spacesGit.readJSONAtCommit(commitSpecific.sha, testRelPath);
  assert(newContent._testField === 'test-value-1', 'readJSONAtCommit() shows test field at new commit');

  // 1.10 HEAD
  const head = await spacesGit.head();
  assert(head === commitSpecific.sha, 'head() returns latest commit SHA');

  // 1.11 File history
  const fileHist = await spacesGit.fileHistory(testRelPath);
  assert(fileHist.length === 2, 'fileHistory() shows 2 commits for modified file');
  assert(fileHist[0].sha === commitSpecific.sha, 'fileHistory() latest commit is most recent');

  // 1.12 Last modified by
  const lastMod = await spacesGit.lastModifiedBy(testRelPath);
  assert(lastMod.author === 'specific-committer', 'lastModifiedBy() returns correct author');

  console.log('');

  // ── Branches ─────────────────────────────────────────────────────────────
  console.log('--- Suite 2: Branches ---\n');

  // 2.1 Current branch
  const mainBranch = await spacesGit.currentBranch();
  assert(mainBranch === 'main', 'currentBranch() returns "main"');

  // 2.2 Create branch
  await spacesGit.createBranch('agent/risk-audit');
  const branches1 = await spacesGit.listBranches();
  assert(branches1.includes('agent/risk-audit'), 'createBranch() creates branch');
  assert(branches1.includes('main'), 'listBranches() includes main');

  // 2.3 Checkout branch
  await spacesGit.checkout('agent/risk-audit');
  const currentAfterCheckout = await spacesGit.currentBranch();
  assert(currentAfterCheckout === 'agent/risk-audit', 'checkout() switches branch');

  // 2.4 Commit on branch
  meta._agentEdit = 'risk-audit-finding';
  fs.writeFileSync(testMetaPath, JSON.stringify(meta, null, 2));
  const branchCommit = await spacesGit.commit({
    filepaths: [testRelPath],
    message: 'Agent: risk audit finding',
    authorName: 'risk-auditor-agent',
  });
  assert(branchCommit.sha.length === 40, 'commit on branch returns SHA');

  // 2.5 Switch back to main
  await spacesGit.checkout('main');
  const backOnMain = await spacesGit.currentBranch();
  assert(backOnMain === 'main', 'checkout back to main works');

  // Verify the agent edit is NOT on main
  const mainMeta = JSON.parse(fs.readFileSync(testMetaPath, 'utf8'));
  assert(!mainMeta._agentEdit, 'agent edit is not visible on main before merge');

  // 2.6 Merge
  const mergeResult = await spacesGit.merge({
    theirs: 'agent/risk-audit',
    authorName: 'richardwilson',
  });
  assert(mergeResult.oid, 'merge() returns oid');

  // Verify the agent edit IS on main after merge
  const mergedMeta = JSON.parse(fs.readFileSync(testMetaPath, 'utf8'));
  assert(mergedMeta._agentEdit === 'risk-audit-finding', 'agent edit visible on main after merge');

  // 2.7 Delete branch
  await spacesGit.deleteBranch('agent/risk-audit');
  const branches2 = await spacesGit.listBranches();
  assert(!branches2.includes('agent/risk-audit'), 'deleteBranch() removes branch');

  // 2.8 Log shows merge
  const logAfterMerge = await spacesGit.log({ depth: 10 });
  assert(logAfterMerge.length >= 3, `log shows ${logAfterMerge.length} commits after merge`);

  console.log('');

  // ── Tags ─────────────────────────────────────────────────────────────────
  console.log('--- Suite 3: Tags ---\n');

  // 3.1 Create tag
  await spacesGit.createTag({ name: 'v1.0', message: 'First release' });
  const tags1 = await spacesGit.listTags();
  assert(tags1.includes('v1.0'), 'createTag() creates tag');

  // 3.2 Create tag at specific commit
  await spacesGit.createTag({ name: 'initial', message: 'Initial state', ref: commitResult.sha });
  const tags2 = await spacesGit.listTags();
  assert(tags2.includes('initial'), 'createTag() with ref works');

  // 3.3 Delete tag
  await spacesGit.deleteTag('initial');
  const tags3 = await spacesGit.listTags();
  assert(!tags3.includes('initial'), 'deleteTag() removes tag');

  console.log('');

  // ── Revert ───────────────────────────────────────────────────────────────
  console.log('--- Suite 4: Revert ---\n');

  // 4.1 Make a change to revert
  meta._toRevert = 'this-should-be-reverted';
  fs.writeFileSync(testMetaPath, JSON.stringify(meta, null, 2));
  const revertTarget = await spacesGit.commit({
    filepaths: [testRelPath],
    message: 'Bad change to revert',
    authorName: 'bad-agent',
  });

  // 4.2 Revert it
  const revertResult = await spacesGit.revert(revertTarget.sha, 'richardwilson');
  assert(revertResult.sha.length === 40, 'revert() returns SHA');

  // 4.3 Verify the change is undone
  const afterRevert = JSON.parse(fs.readFileSync(testMetaPath, 'utf8'));
  assert(!afterRevert._toRevert, 'reverted field is gone from working tree');

  // 4.4 History preserved
  const logAfterRevert = await spacesGit.log({ depth: 20 });
  const revertEntry = logAfterRevert.find(e => e.message.startsWith('Revert'));
  assert(!!revertEntry, 'revert commit appears in log');
  assert(revertEntry.message.includes('Bad change to revert'), 'revert commit references original message');

  console.log('');

  // ── CommitAll with no changes ────────────────────────────────────────────
  console.log('--- Suite 5: Edge Cases ---\n');

  // 5.1 Commit with no changes
  const noChangeResult = await spacesGit.commitAll({
    message: 'Should not create commit',
    authorName: 'test',
  });
  assert(noChangeResult.sha === null, 'commitAll() returns null SHA when nothing changed');
  assert(noChangeResult.filesChanged === 0, 'commitAll() returns 0 filesChanged when clean');

  // 5.2 Read file at nonexistent commit
  const badRead = await spacesGit.readFileAtCommit('0000000000000000000000000000000000000000', testRelPath);
  assert(badRead === null, 'readFileAtCommit() returns null for bad commit');

  // 5.3 Resolve ref
  const resolvedHead = await spacesGit.resolveRef('HEAD');
  assert(resolvedHead.length === 40, 'resolveRef(HEAD) returns 40-char SHA');
  const resolvedMain = await spacesGit.resolveRef('main');
  assert(resolvedMain === resolvedHead, 'resolveRef(main) equals HEAD (on main branch)');

  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // TEST SUITE 6: Migration
  // ══════════════════════════════════════════════════════════════════════════
  console.log('--- Suite 6: Migration (fresh copy) ---\n');

  // Create a fresh copy for migration test
  const MIGRATE_DIR = path.join(os.tmpdir(), `or-spaces-migrate-test-${Date.now()}`);
  copyDir(OR_SPACES, MIGRATE_DIR);

  const { migrateToV3 } = require('./lib/spaces-migration');
  const migResult = await migrateToV3({
    dir: MIGRATE_DIR,
    skipBackup: true,
    onProgress: () => {},
  });

  assert(migResult.success, 'migrateToV3() succeeds');
  assert(migResult.stats.spacesProcessed > 0, `migration processed ${migResult.stats.spacesProcessed} spaces`);
  assert(migResult.stats.itemsProcessed > 0, `migration processed ${migResult.stats.itemsProcessed} items`);
  assert(migResult.stats.fieldsStripped > 0, `migration stripped ${migResult.stats.fieldsStripped} legacy fields`);

  const migGit = new SpacesGit(MIGRATE_DIR);
  assert(migGit.isV3(), 'isV3() true after migration');
  assert(migGit.isInitialized(), 'isInitialized() true after migration');

  // Check schema on a space
  const migSpacesDir = path.join(MIGRATE_DIR, 'spaces');
  const migFirstSpace = fs.readdirSync(migSpacesDir, { withFileTypes: true })
    .find(d => d.isDirectory() && !d.name.startsWith('.'));
  const migMeta = JSON.parse(fs.readFileSync(
    path.join(migSpacesDir, migFirstSpace.name, 'space-metadata.json'), 'utf8'
  ));
  assert(migMeta._schema.version === '3.0', 'space metadata schema is 3.0');
  assert(migMeta._schema.storageEngine === 'git', 'space metadata has storageEngine: git');
  assert(!migMeta._schema.migratedFrom, 'migratedFrom field removed');
  assert(!migMeta.events?.versions, 'events.versions removed');
  assert(migMeta.projectConfig?.currentVersion === undefined, 'projectConfig.currentVersion removed');
  assert(!Array.isArray(migMeta.versions), 'legacy versions[] removed');

  // Check item schema
  const migItemsDir = path.join(MIGRATE_DIR, 'items');
  const migFirstItem = fs.readdirSync(migItemsDir, { withFileTypes: true })
    .find(d => d.isDirectory() && !d.name.startsWith('.'));
  if (migFirstItem) {
    const itemMetaPath = path.join(migItemsDir, migFirstItem.name, 'metadata.json');
    if (fs.existsSync(itemMetaPath)) {
      const itemMeta = JSON.parse(fs.readFileSync(itemMetaPath, 'utf8'));
      assert(itemMeta._schema.version === '3.0', 'item metadata schema is 3.0');
      assert(itemMeta._schema.storageEngine === 'git', 'item metadata has storageEngine: git');
      assert(!itemMeta.events?.versions, 'item events.versions removed');
    }
  }

  // Legacy files removed
  assert(!fs.existsSync(path.join(MIGRATE_DIR, 'index.json')), 'index.json removed');
  assert(!fs.existsSync(path.join(MIGRATE_DIR, 'index.json.backup')), 'index.json.backup removed');

  // V3 marker
  const marker = JSON.parse(fs.readFileSync(path.join(MIGRATE_DIR, '.spaces-version'), 'utf8'));
  assert(marker.version === '3.0', 'version marker is 3.0');
  assert(marker.engine === 'git', 'version marker engine is git');

  // Idempotent -- running again should be a no-op
  const migResult2 = await migrateToV3({ dir: MIGRATE_DIR, skipBackup: true, onProgress: () => {} });
  assert(migResult2.stats.alreadyMigrated, 'second migration is a no-op');

  // Git log has 3 commits (initial snapshot, v3 cleanup, version marker)
  const migLog = await migGit.log({ depth: 10 });
  assert(migLog.length === 3, `migration creates 3 commits (got ${migLog.length})`);

  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // TEST SUITE 7: Metadata Schema v3
  // ══════════════════════════════════════════════════════════════════════════
  console.log('--- Suite 7: Metadata Schema v3 ---\n');

  const MetadataSchema = require('./lib/metadata-schema');

  assert(MetadataSchema.SCHEMA_VERSION === '3.0', 'SCHEMA_VERSION is 3.0');

  // Space schema
  const spaceMeta = MetadataSchema.createSpaceMetadata({ id: 'test-space', name: 'Test Space' });
  assert(spaceMeta._schema.version === '3.0', 'createSpaceMetadata sets version 3.0');
  assert(spaceMeta._schema.storageEngine === 'git', 'createSpaceMetadata sets storageEngine: git');
  assert(!spaceMeta.events.versions, 'createSpaceMetadata has no events.versions');
  assert(spaceMeta.projectConfig.currentVersion === undefined, 'createSpaceMetadata has no currentVersion');
  assert(Array.isArray(spaceMeta.events.activityLog), 'createSpaceMetadata still has activityLog');
  assert(Array.isArray(spaceMeta.events.milestones), 'createSpaceMetadata still has milestones');

  // Item schema
  const itemMeta = MetadataSchema.createItemMetadata({ id: 'test-item', type: 'text', spaceId: 'test-space' });
  assert(itemMeta._schema.version === '3.0', 'createItemMetadata sets version 3.0');
  assert(itemMeta._schema.storageEngine === 'git', 'createItemMetadata sets storageEngine: git');
  assert(!itemMeta.events.versions, 'createItemMetadata has no events.versions');
  assert(itemMeta.events.workflowStage === null, 'createItemMetadata still has workflowStage');

  // Verify v1 migration functions are removed
  assert(typeof MetadataSchema.migrateSpaceMetadata === 'undefined', 'migrateSpaceMetadata removed from exports');
  assert(typeof MetadataSchema.migrateItemMetadata === 'undefined', 'migrateItemMetadata removed from exports');

  // Retained functions still work
  assert(typeof MetadataSchema.extractSpaceContext === 'function', 'extractSpaceContext still exported');
  assert(typeof MetadataSchema.extractItemContext === 'function', 'extractItemContext still exported');
  assert(typeof MetadataSchema.validate === 'function', 'validate still exported');
  assert(typeof MetadataSchema.deepMerge === 'function', 'deepMerge still exported');
  assert(typeof MetadataSchema.registerExtension === 'function', 'registerExtension still exported');

  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // TEST SUITE 8: Multiple Agent Branches (PR Workflow)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('--- Suite 8: Agent PR Workflow ---\n');

  // Setup: use the already-initialized TEST_DIR spacesGit

  // Agent 1 creates a branch and makes changes
  await spacesGit.createBranch('agent/weather');
  await spacesGit.checkout('agent/weather');
  const weatherMeta = JSON.parse(fs.readFileSync(testMetaPath, 'utf8'));
  weatherMeta._weather = { forecast: 'sunny', temp: 72 };
  fs.writeFileSync(testMetaPath, JSON.stringify(weatherMeta, null, 2));
  await spacesGit.commit({
    filepaths: [testRelPath],
    message: 'Agent: added weather data',
    authorName: 'weather-agent',
  });

  // Back to main
  await spacesGit.checkout('main');

  // Agent 2 creates a different branch
  await spacesGit.createBranch('agent/calendar');
  await spacesGit.checkout('agent/calendar');
  // Modify a DIFFERENT file to avoid merge conflicts
  const itemsDir = path.join(TEST_DIR, 'items');
  const firstItem = fs.readdirSync(itemsDir, { withFileTypes: true })
    .find(d => d.isDirectory() && !d.name.startsWith('.'));
  if (firstItem) {
    const itemMetaPath = path.join(itemsDir, firstItem.name, 'metadata.json');
    if (fs.existsSync(itemMetaPath)) {
      const itemContent = JSON.parse(fs.readFileSync(itemMetaPath, 'utf8'));
      itemContent._calendarNote = 'meeting at 3pm';
      fs.writeFileSync(itemMetaPath, JSON.stringify(itemContent, null, 2));
      await spacesGit.commit({
        filepaths: [`items/${firstItem.name}/metadata.json`],
        message: 'Agent: added calendar note',
        authorName: 'calendar-agent',
      });
    }
  }

  // Back to main, merge both
  await spacesGit.checkout('main');
  const merge1 = await spacesGit.merge({ theirs: 'agent/weather', authorName: 'user' });
  assert(merge1.oid, 'merge weather branch succeeds');

  const merge2 = await spacesGit.merge({ theirs: 'agent/calendar', authorName: 'user' });
  assert(merge2.oid, 'merge calendar branch succeeds (no conflict with weather)');

  // Both changes visible
  const finalMeta = JSON.parse(fs.readFileSync(testMetaPath, 'utf8'));
  assert(finalMeta._weather?.forecast === 'sunny', 'weather agent changes visible after merge');

  if (firstItem) {
    const finalItemPath = path.join(itemsDir, firstItem.name, 'metadata.json');
    if (fs.existsSync(finalItemPath)) {
      const finalItem = JSON.parse(fs.readFileSync(finalItemPath, 'utf8'));
      assert(finalItem._calendarNote === 'meeting at 3pm', 'calendar agent changes visible after merge');
    }
  }

  // Three branches: main + two agent branches
  const allBranches = await spacesGit.listBranches();
  assert(allBranches.includes('agent/weather'), 'agent/weather branch exists');
  assert(allBranches.includes('agent/calendar'), 'agent/calendar branch exists');

  // Diff between branches shows the changes
  const branchDiff = await spacesGit.diff('agent/weather', 'agent/calendar');
  assert(branchDiff.length > 0, 'diff between agent branches shows changes');

  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════════════════════════════════
  console.log('=== Results ===\n');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }
  console.log(`\n  Test dirs (delete manually):`);
  console.log(`    ${TEST_DIR}`);
  console.log(`    ${MIGRATE_DIR}`);
  console.log(`\n=== ${failed === 0 ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} ===`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('\n=== TEST RUNNER CRASHED ===');
  console.error(err);
  process.exit(2);
});
