'use strict';

const fs = require('fs');
const path = require('path');

const PLANS_DIR = path.join(__dirname, '..', 'plans');

// Matches checklist items in both formats:
//   - [ ] `[A]` Description text    (plans 01-17, backtick-wrapped)
//   - [ ] [A] Description text      (plans 18-35, no backticks)
//   - [x] [A] Description text      (already checked)
const CHECKLIST_RE = /^- \[[ x]\] +`?\[([AMP])\]`? +(.+)$/;

// Matches plan title:  # 18 -- AI Service & Runtimes  OR  # Settings Test Plan
const PLAN_TITLE_RE = /^# +(?:(\d+) +-- +)?(.+)$/;

// Matches section headers:  ### Window Lifecycle
const SECTION_RE = /^### +(.+)$/;

// Extracts plan number from filename: 01-settings.md -> 1
const FILENAME_NUM_RE = /^(\d+)-/;

/**
 * Slugify a string for use in deterministic IDs.
 * "Settings window opens via menu (Cmd+,) or IPC" -> "settings-window-opens-via-menu-cmd-or-ipc"
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // strip non-alphanumeric
    .replace(/\s+/g, '-') // spaces to hyphens
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
    .slice(0, 80); // cap length
}

/**
 * Parse a single test plan markdown file.
 * @param {string} filePath - Absolute path to the .md file
 * @returns {Array<Object>} - Array of structured checklist items
 */
function parsePlanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const filename = path.basename(filePath);

  // Extract plan number from filename
  const numMatch = filename.match(FILENAME_NUM_RE);
  const planNumber = numMatch ? parseInt(numMatch[1], 10) : 0;

  // Skip master checklist
  if (planNumber === 0) return [];

  let planName = '';
  let currentSection = '';
  const items = [];
  let itemIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match plan title
    const titleMatch = line.match(PLAN_TITLE_RE);
    if (titleMatch && !planName) {
      planName = titleMatch[2].replace(/ Test Plan$/i, '').trim();
      continue;
    }

    // Match section header
    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Match checklist item
    const checkMatch = line.match(CHECKLIST_RE);
    if (checkMatch) {
      const type = checkMatch[1]; // A, M, or P
      const description = checkMatch[2].trim();

      const sectionSlug = slugify(currentSection || 'general');
      const descSlug = slugify(description);
      const planSlug = filename.replace(/\.md$/, '');

      const id = `${planSlug}--${sectionSlug}--${descSlug}`;

      items.push({
        id,
        planNumber,
        planFile: filename,
        planName,
        section: currentSection || 'General',
        description,
        type,
        lineNumber: i + 1, // 1-based
        index: itemIndex,
      });

      itemIndex++;
    }
  }

  return items;
}

/**
 * Parse all test plan files in the plans directory.
 * @returns {Array<Object>} - Flat array of all checklist items across all plans, ordered by plan number then item index.
 */
function parseAllPlans() {
  const files = fs
    .readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('00-'))
    .sort();

  const allItems = [];

  for (const file of files) {
    const filePath = path.join(PLANS_DIR, file);
    const items = parsePlanFile(filePath);
    allItems.push(...items);
  }

  return allItems;
}

/**
 * Get a summary of all parsed plans.
 * @returns {Object} - { totalItems, plans: [{ number, name, file, itemCount, automated, manual, partial }] }
 */
function getPlanSummary() {
  const items = parseAllPlans();
  const planMap = new Map();

  for (const item of items) {
    if (!planMap.has(item.planNumber)) {
      planMap.set(item.planNumber, {
        number: item.planNumber,
        name: item.planName,
        file: item.planFile,
        itemCount: 0,
        automated: 0,
        manual: 0,
        partial: 0,
      });
    }
    const plan = planMap.get(item.planNumber);
    plan.itemCount++;
    if (item.type === 'A') plan.automated++;
    else if (item.type === 'M') plan.manual++;
    else if (item.type === 'P') plan.partial++;
  }

  return {
    totalItems: items.length,
    plans: Array.from(planMap.values()).sort((a, b) => a.number - b.number),
  };
}

module.exports = {
  parsePlanFile,
  parseAllPlans,
  getPlanSummary,
  slugify,
  PLANS_DIR,
};
