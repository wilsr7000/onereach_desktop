/**
 * spaces-git.js -- Git-based versioning engine for Spaces
 * 
 * Thin wrapper around isomorphic-git providing Space-specific operations:
 * init, commit, log, diff, branch, merge, status, tag, revert, stash.
 * 
 * This module is the sole interface between the Spaces storage layer
 * and isomorphic-git. All Git operations go through here.
 * 
 * Storage: ~/Documents/OR-Spaces/ is a single Git repo.
 * Binary content (images, video, audio) is excluded via .gitignore.
 * DuckDB remains the query index. Git is the history engine.
 */

const git = require('isomorphic-git');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────

const OR_SPACES_DIR = path.join(os.homedir(), 'Documents', 'OR-Spaces');
const SPACES_VERSION_FILE = '.spaces-version';
const GITIGNORE_FILE = '.gitignore';
const DEFAULT_BRANCH = 'main';
const SYSTEM_AUTHOR = { name: 'OneReach System', email: 'system@onereach.ai' };

/** Binary extensions excluded from Git tracking */
const BINARY_EXTENSIONS = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.ico',
  '*.mp4', '*.mov', '*.avi', '*.webm', '*.mkv',
  '*.mp3', '*.wav', '*.ogg', '*.m4a', '*.flac', '*.aac',
  '*.pdf',
  '*.zip', '*.tar', '*.gz', '*.bz2', '*.7z', '*.rar',
  '*.dmg', '*.iso', '*.exe', '*.app',
];

/** Files/dirs always excluded from Git tracking */
const ALWAYS_IGNORED = [
  '# DuckDB database',
  '*.duckdb',
  '*.duckdb.wal',
  '',
  '# Legacy index files',
  'index.json',
  'index.json.backup',
  'index.json.backup-*',
  'backup-legacy-files-*',
  '',
  '# Thumbnails',
  'thumbnail.*',
  '**/thumbnail.*',
  '',
  '# Logs',
  'logs/',
  '',
  '# OS files',
  '.DS_Store',
  'Thumbs.db',
  '',
  '# Smart folders (managed by DuckDB)',
  'smart-folders.json',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAuthor(name, email) {
  return {
    name: name || SYSTEM_AUTHOR.name,
    email: email || SYSTEM_AUTHOR.email,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset(),
  };
}

/**
 * Check if a file path matches a .gitignore-style pattern (simplified).
 * Used for pre-filtering before git.add().
 */
function isIgnoredExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const binarySet = new Set(BINARY_EXTENSIONS.map(p => p.replace('*', '')));
  return binarySet.has(ext);
}

// ── SpacesGit Class ──────────────────────────────────────────────────────────

class SpacesGit {
  constructor(dir) {
    this.dir = dir || OR_SPACES_DIR;
    this.fs = fs;
    this._initialized = false;
  }

  // ── Initialization ───────────────────────────────────────────────────────

  /**
   * Check if the Spaces directory is already a Git repo.
   */
  isInitialized() {
    return fs.existsSync(path.join(this.dir, '.git'));
  }

  /**
   * Check if the v3 migration has been completed.
   */
  isV3() {
    const versionFile = path.join(this.dir, SPACES_VERSION_FILE);
    if (!fs.existsSync(versionFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return data.version === '3.0';
    } catch {
      return false;
    }
  }

  /**
   * Initialize the Spaces directory as a Git repo.
   * Creates .gitignore and makes the initial commit.
   */
  async init() {
    if (this.isInitialized()) {
      this._initialized = true;
      return { alreadyInitialized: true };
    }

    // git init
    await git.init({ fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });

    // Write .gitignore
    this._writeGitignore();

    this._initialized = true;
    return { alreadyInitialized: false };
  }

  /**
   * Write the .gitignore file with binary and system exclusions.
   */
  _writeGitignore() {
    const lines = [
      '# === Spaces Git -- Auto-generated ===',
      '# Binary content tracked by content hash, not Git',
      ...BINARY_EXTENSIONS,
      '',
      ...ALWAYS_IGNORED,
    ];
    fs.writeFileSync(path.join(this.dir, GITIGNORE_FILE), lines.join('\n'));
  }

  // ── Core Operations ──────────────────────────────────────────────────────

  /**
   * Stage and commit changes to specific files.
   * 
   * @param {Object} opts
   * @param {string[]} opts.filepaths - Relative paths to stage (e.g., ['spaces/abc/space-metadata.json'])
   * @param {string} opts.message - Commit message
   * @param {string} [opts.authorName] - Author name (defaults to system)
   * @param {string} [opts.authorEmail] - Author email
   * @returns {Promise<{sha: string, message: string}>}
   */
  async commit({ filepaths, message, authorName, authorEmail }) {
    this._ensureInit();

    // Stage files
    for (const fp of filepaths) {
      if (isIgnoredExtension(fp)) continue;
      const fullPath = path.join(this.dir, fp);
      if (fs.existsSync(fullPath)) {
        await git.add({ fs, dir: this.dir, filepath: fp });
      } else {
        // File was deleted -- stage removal
        await git.remove({ fs, dir: this.dir, filepath: fp });
      }
    }

    const sha = await git.commit({
      fs,
      dir: this.dir,
      message,
      author: makeAuthor(authorName, authorEmail),
    });

    return { sha, message };
  }

  /**
   * Stage ALL changed files and commit.
   * Walks the working tree, stages everything that changed.
   * 
   * @param {Object} opts
   * @param {string} opts.message - Commit message
   * @param {string} [opts.authorName]
   * @param {string} [opts.authorEmail]
   * @returns {Promise<{sha: string, filesChanged: number}>}
   */
  async commitAll({ message, authorName, authorEmail }) {
    this._ensureInit();

    const statusMatrix = await git.statusMatrix({ fs, dir: this.dir });
    let filesChanged = 0;

    for (const [filepath, head, workdir, stage] of statusMatrix) {
      // Skip if clean (1,1,1)
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (isIgnoredExtension(filepath)) continue;

      if (workdir === 0) {
        // File deleted
        await git.remove({ fs, dir: this.dir, filepath });
        filesChanged++;
      } else {
        // File added or modified
        await git.add({ fs, dir: this.dir, filepath });
        filesChanged++;
      }
    }

    if (filesChanged === 0) {
      return { sha: null, filesChanged: 0 };
    }

    const sha = await git.commit({
      fs,
      dir: this.dir,
      message,
      author: makeAuthor(authorName, authorEmail),
    });

    return { sha, filesChanged };
  }

  /**
   * Get commit history.
   * 
   * @param {Object} [opts]
   * @param {number} [opts.depth=50] - Max commits to return
   * @param {string} [opts.ref] - Branch or commit to start from (defaults to HEAD)
   * @param {string} [opts.filepath] - Only show commits that changed this file
   * @returns {Promise<Array<{sha, message, author, timestamp, parentShas}>>}
   */
  async log({ depth = 50, ref, filepath } = {}) {
    this._ensureInit();

    const logOpts = { fs, dir: this.dir, depth };
    if (ref) logOpts.ref = ref;
    if (filepath) logOpts.filepath = filepath;

    const entries = await git.log(logOpts);

    return entries.map(entry => ({
      sha: entry.oid,
      message: entry.commit.message.trim(),
      author: entry.commit.author.name,
      authorEmail: entry.commit.author.email,
      timestamp: new Date(entry.commit.author.timestamp * 1000).toISOString(),
      parentShas: entry.commit.parent,
    }));
  }

  /**
   * Get list of files changed between two commits.
   * 
   * @param {string} sha1 - Base commit SHA (or branch name)
   * @param {string} sha2 - Target commit SHA (or branch name)
   * @returns {Promise<Array<{filepath, status}>>} - status: 'added'|'modified'|'deleted'
   */
  async diff(sha1, sha2) {
    this._ensureInit();

    // Resolve branch names to SHAs if needed
    const oid1 = await git.resolveRef({ fs, dir: this.dir, ref: sha1 });
    const oid2 = await git.resolveRef({ fs, dir: this.dir, ref: sha2 });

    const changes = [];
    await git.walk({
      fs,
      dir: this.dir,
      trees: [git.TREE({ ref: oid1 }), git.TREE({ ref: oid2 })],
      map: async (filepath, [A, B]) => {
        if (filepath === '.') return;
        const aOid = A ? await A.oid() : null;
        const bOid = B ? await B.oid() : null;
        if (aOid === bOid) return;
        const aType = A ? await A.type() : null;
        const bType = B ? await B.type() : null;
        if (aType === 'tree' || bType === 'tree') return;
        changes.push({
          filepath,
          status: !aOid ? 'added' : !bOid ? 'deleted' : 'modified',
        });
      },
    });

    return changes;
  }

  /**
   * Get the full content of a file at a specific commit.
   * 
   * @param {string} sha - Commit SHA
   * @param {string} filepath - Relative file path
   * @returns {Promise<string|null>} - File content or null if not found
   */
  async readFileAtCommit(sha, filepath) {
    this._ensureInit();

    try {
      const { blob } = await git.readBlob({
        fs,
        dir: this.dir,
        oid: sha,
        filepath,
      });
      return Buffer.from(blob).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * Get JSON content of a file at a specific commit, parsed.
   * 
   * @param {string} sha - Commit SHA
   * @param {string} filepath - Relative file path
   * @returns {Promise<Object|null>}
   */
  async readJSONAtCommit(sha, filepath) {
    const content = await this.readFileAtCommit(sha, filepath);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Get working tree status.
   * 
   * @returns {Promise<{clean: number, modified: Array, added: Array, deleted: Array}>}
   */
  async status() {
    this._ensureInit();

    const matrix = await git.statusMatrix({ fs, dir: this.dir });
    const result = { clean: 0, modified: [], added: [], deleted: [] };

    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) {
        result.clean++;
      } else if (head === 0 && workdir === 2) {
        result.added.push(filepath);
      } else if (head === 1 && workdir === 0) {
        result.deleted.push(filepath);
      } else if (head === 1 && workdir === 2) {
        result.modified.push(filepath);
      } else {
        // Other states (staged but not committed, etc.)
        result.modified.push(filepath);
      }
    }

    return result;
  }

  // ── Branches ─────────────────────────────────────────────────────────────

  /**
   * Create a new branch.
   * 
   * @param {string} name - Branch name (e.g., 'agent/risk-audit')
   * @param {string} [startPoint] - Commit or branch to start from (defaults to HEAD)
   * @returns {Promise<void>}
   */
  async createBranch(name, startPoint) {
    this._ensureInit();
    const opts = { fs, dir: this.dir, ref: name };
    if (startPoint) opts.object = startPoint;
    await git.branch(opts);
  }

  /**
   * Switch to a branch.
   * 
   * @param {string} name - Branch name
   * @returns {Promise<void>}
   */
  async checkout(name) {
    this._ensureInit();
    await git.checkout({ fs, dir: this.dir, ref: name, force: true });
  }

  /**
   * Get current branch name.
   * 
   * @returns {Promise<string|null>}
   */
  async currentBranch() {
    this._ensureInit();
    return git.currentBranch({ fs, dir: this.dir });
  }

  /**
   * List all branches.
   * 
   * @returns {Promise<string[]>}
   */
  async listBranches() {
    this._ensureInit();
    return git.listBranches({ fs, dir: this.dir });
  }

  /**
   * Delete a branch.
   * 
   * @param {string} name - Branch name
   * @returns {Promise<void>}
   */
  async deleteBranch(name) {
    this._ensureInit();
    await git.deleteBranch({ fs, dir: this.dir, ref: name });
  }

  /**
   * Merge a branch into the current branch.
   * 
   * @param {Object} opts
   * @param {string} opts.theirs - Branch to merge in
   * @param {string} [opts.authorName]
   * @param {string} [opts.authorEmail]
   * @param {string} [opts.message] - Custom merge message
   * @returns {Promise<{oid: string, alreadyMerged: boolean, fastForward: boolean}>}
   */
  async merge({ theirs, authorName, authorEmail, message }) {
    this._ensureInit();

    const ours = await this.currentBranch();
    const result = await git.merge({
      fs,
      dir: this.dir,
      ours,
      theirs,
      author: makeAuthor(authorName, authorEmail),
      message: message || `Merge branch '${theirs}' into ${ours}`,
    });

    // After merge, checkout to update working tree
    if (!result.alreadyMerged) {
      await git.checkout({ fs, dir: this.dir, ref: ours, force: true });
    }

    return {
      oid: result.oid,
      alreadyMerged: result.alreadyMerged || false,
      fastForward: !result.mergeCommit,
    };
  }

  // ── Tags ─────────────────────────────────────────────────────────────────

  /**
   * Create an annotated tag (milestone marker).
   * 
   * @param {Object} opts
   * @param {string} opts.name - Tag name (e.g., 'client-approved')
   * @param {string} [opts.message] - Tag message
   * @param {string} [opts.ref] - Commit to tag (defaults to HEAD)
   * @param {string} [opts.authorName]
   * @returns {Promise<void>}
   */
  async createTag({ name, message, ref, authorName }) {
    this._ensureInit();

    await git.annotatedTag({
      fs,
      dir: this.dir,
      ref: name,
      message: message || name,
      object: ref, // defaults to HEAD if undefined
      tagger: makeAuthor(authorName),
    });
  }

  /**
   * List all tags.
   * 
   * @returns {Promise<string[]>}
   */
  async listTags() {
    this._ensureInit();
    return git.listTags({ fs, dir: this.dir });
  }

  /**
   * Delete a tag.
   * 
   * @param {string} name
   * @returns {Promise<void>}
   */
  async deleteTag(name) {
    this._ensureInit();
    await git.deleteTag({ fs, dir: this.dir, ref: name });
  }

  // ── Revert ───────────────────────────────────────────────────────────────

  /**
   * Revert a commit by creating a new commit that undoes its changes.
   * Reads the parent's tree and creates a new commit with that state.
   * 
   * @param {string} sha - Commit SHA to revert
   * @param {string} [authorName]
   * @returns {Promise<{sha: string}>}
   */
  async revert(sha, authorName) {
    this._ensureInit();

    // Read the commit to get its parent and message
    const { commit } = await git.readCommit({ fs, dir: this.dir, oid: sha });
    const parentSha = commit.parent[0];

    if (!parentSha) {
      throw new Error('Cannot revert the initial commit');
    }

    // Get the changed files between parent and this commit
    const changes = await this.diff(parentSha, sha);

    // For each changed file, restore the parent version
    for (const change of changes) {
      if (change.status === 'added') {
        // File was added in the commit we're reverting -- delete it
        const fullPath = path.join(this.dir, change.filepath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          await git.remove({ fs, dir: this.dir, filepath: change.filepath });
        }
      } else {
        // File was modified or deleted -- restore parent version
        const content = await this.readFileAtCommit(parentSha, change.filepath);
        if (content !== null) {
          const fullPath = path.join(this.dir, change.filepath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content);
          await git.add({ fs, dir: this.dir, filepath: change.filepath });
        }
      }
    }

    const revertSha = await git.commit({
      fs,
      dir: this.dir,
      message: `Revert "${commit.message.trim()}"\n\nThis reverts commit ${sha}.`,
      author: makeAuthor(authorName),
    });

    return { sha: revertSha };
  }

  // ── File History ─────────────────────────────────────────────────────────

  /**
   * Get commit history for a specific file (blame-like).
   * 
   * @param {string} filepath - Relative file path
   * @param {number} [depth=20]
   * @returns {Promise<Array<{sha, message, author, timestamp}>>}
   */
  async fileHistory(filepath, depth = 20) {
    return this.log({ filepath, depth });
  }

  /**
   * Get the last commit that modified a specific file.
   * 
   * @param {string} filepath
   * @returns {Promise<{sha, message, author, timestamp}|null>}
   */
  async lastModifiedBy(filepath) {
    const history = await this.fileHistory(filepath, 1);
    return history.length > 0 ? history[0] : null;
  }

  // ── Resolve ──────────────────────────────────────────────────────────────

  /**
   * Resolve a ref (branch name, tag name, 'HEAD') to a commit SHA.
   * 
   * @param {string} ref
   * @returns {Promise<string>}
   */
  async resolveRef(ref) {
    return git.resolveRef({ fs, dir: this.dir, ref });
  }

  /**
   * Get HEAD commit SHA.
   * 
   * @returns {Promise<string>}
   */
  async head() {
    return this.resolveRef('HEAD');
  }

  // ── Version Marker ───────────────────────────────────────────────────────

  /**
   * Write the v3 version marker file.
   */
  writeV3Marker() {
    const data = {
      version: '3.0',
      engine: 'git',
      migratedAt: new Date().toISOString(),
      migratedFrom: '2.0',
    };
    fs.writeFileSync(
      path.join(this.dir, SPACES_VERSION_FILE),
      JSON.stringify(data, null, 2)
    );
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _ensureInit() {
    if (!this._initialized && !this.isInitialized()) {
      throw new Error('SpacesGit: repository not initialized. Call init() or run migration first.');
    }
    this._initialized = true;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance = null;

/**
 * Get the singleton SpacesGit instance for the default OR-Spaces directory.
 * @returns {SpacesGit}
 */
function getSpacesGit() {
  if (!_instance) {
    _instance = new SpacesGit(OR_SPACES_DIR);
  }
  return _instance;
}

module.exports = { SpacesGit, getSpacesGit, OR_SPACES_DIR, BINARY_EXTENSIONS, ALWAYS_IGNORED };
