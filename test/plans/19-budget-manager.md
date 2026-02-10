# 19 -- Budget Manager

## Overview

Three-window budget system for AI cost tracking and project estimation. Includes the Budget Dashboard (cost overview and activity), Budget Setup Wizard (initial configuration), and Budget Estimator (project cost calculator).

**Key files:** `budget-dashboard.html`, `budget-setup.html`, `budget-estimator.html`, `preload-budget.js`, `preload-budget-estimator.js`, `budget-manager.js`, `llm-usage-tracker.js`, `pricing-config.js`

## Prerequisites

- App running with Budget Manager initialized
- At least one AI API key configured (for cost tracking to have data)
- Budget not yet configured (for setup wizard tests) or configured (for dashboard tests)

## Features

### Budget Dashboard (`budget-dashboard.html`)
- 4 summary cards: Budget Limit, Estimated, Actual Spent, Variance with progress bar
- Project selector dropdown (global view or per-project)
- Budget table: Category, Estimated, Actual, Variance, Status columns with totals
- Recent activity feed: timestamped transaction history with provider and cost
- Estimate modal: add/edit line items (category, description, amount, units)
- JSON export of full budget data
- Refresh button to reload data
- Toast notifications for success/error feedback
- 6 budget categories: AI Voice Generation, Audio Transcription, AI Translation, Scene Descriptions, Sound Effects, Video Dubbing

### Budget Setup Wizard (`budget-setup.html`)
- 2-step wizard with dot progress indicators
- Step 1: Per-provider budget limits (Global, OpenAI, ElevenLabs, Anthropic) with dollar inputs
- Step 1: Alert threshold checkboxes (50%, 75%, 90%)
- Step 2: Summary review before saving
- Skip option with confirmation dialog (applies defaults: $50/$20/$20/$10)
- Auto-loads existing config if already set up
- Back/Continue/Complete navigation

### Budget Estimator (`budget-estimator.html`)
- Split-pane layout: Markdown editor (left) + cost calculator (right)
- 4 AI feature calculators with real-time cost estimation:
  - AI Voice Generation (ElevenLabs): chars, segments, voice tier
  - Audio Transcription (Whisper): minutes, language
  - AI Translation (Claude): chars, target languages, quality iterations (1/3/5)
  - Scene Descriptions (Claude): scene count, detail level (brief/standard/detailed)
- 4 project templates: Basic, Voiceover, Translation, Full Production
- Auto-detection from markdown checkboxes/numbers
- Budget check indicator: green (OK), yellow (>75%), red (over)
- Saved estimates list (last 5, stored in localStorage)
- Register estimates as trackable projects

### IPC Bridge (`preload-budget.js`)
- 26 IPC methods via `window.budgetAPI`
- Categories: cost tracking, budget limits, projects, estimates, config, import/export, pricing, backup, reset, events, navigation

---

## Checklist

### Budget Dashboard -- Window
- [ ] [A] Dashboard window opens via IPC `open-budget-dashboard`
- [ ] [A] Window loads without console errors
- [ ] [M] All 4 summary cards display with correct formatting
- [ ] [M] Progress bar reflects actual/budget ratio

### Budget Dashboard -- Project Selector
- [ ] [A] Project selector populates from `budget:getAllProjects`
- [ ] [P] Switching projects updates all cards, table, and activity feed
- [ ] [P] "Global" view aggregates all project data

### Budget Dashboard -- Budget Table
- [ ] [A] Table loads 6 budget categories
- [ ] [P] Estimated, Actual, Variance columns calculate correctly
- [ ] [P] Status column shows correct indicator (under/near/over)
- [ ] [P] Totals row sums all categories

### Budget Dashboard -- Activity Feed
- [ ] [A] Recent activity loads from `budget:getUsageHistory`
- [ ] [P] Activity entries show timestamp, provider, cost, description
- [ ] [M] Activity feed scrolls for long histories

### Budget Dashboard -- Estimate Modal
- [ ] [M] "Add Estimate" opens the estimate modal
- [ ] [M] Category dropdown lists all 6 categories
- [ ] [A] Saving an estimate persists via `budget:saveEstimates`
- [ ] [M] Editing an existing estimate pre-fills the form

### Budget Dashboard -- Export
- [ ] [A] Export button triggers JSON download
- [ ] [A] Exported JSON contains budget limits, estimates, and usage history

### Budget Setup Wizard -- Window
- [ ] [A] Setup wizard opens via IPC `open-budget-setup`
- [ ] [A] Window loads without console errors
- [ ] [A] Already-configured state auto-loads existing values

### Budget Setup Wizard -- Step 1
- [ ] [M] 4 budget limit inputs accept dollar amounts
- [ ] [M] Default values pre-fill ($50/$20/$20/$10)
- [ ] [M] Alert threshold checkboxes toggle correctly
- [ ] [M] "Continue" advances to Step 2

### Budget Setup Wizard -- Step 2
- [ ] [P] Summary shows entered values and alert settings
- [ ] [A] "Complete Setup" saves via `budget:setBudgetLimit` and `budget:markBudgetConfigured`
- [ ] [M] "Back" returns to Step 1 with values preserved

### Budget Setup Wizard -- Skip
- [ ] [M] "Skip" link shows confirmation dialog
- [ ] [A] Confirming skip applies default values

### Budget Estimator -- Window
- [ ] [A] Estimator window opens via IPC `open-budget-estimator`
- [ ] [A] Window loads without console errors
- [ ] [A] Pricing data loads from `pricingGetAll()` IPC

### Budget Estimator -- Markdown Editor
- [ ] [M] Markdown textarea accepts project description input
- [ ] [M] Templates populate the editor (Basic, Voiceover, Translation, Full Production)
- [ ] [M] "Clear" button empties the editor
- [ ] [P] Auto-detection parses checkboxes and numbers from markdown

### Budget Estimator -- Feature Calculators
- [ ] [M] Voice Generation: char count and segment inputs update cost in real-time
- [ ] [M] Transcription: minutes input updates cost
- [ ] [M] Translation: chars, languages, iterations update cost
- [ ] [M] Scene Descriptions: count and detail level update cost
- [ ] [P] Total cost sums all enabled features correctly

### Budget Estimator -- Budget Check
- [ ] [A] Budget check indicator loads current budget from IPC
- [ ] [P] Green indicator when estimate < budget
- [ ] [P] Yellow indicator when estimate > 75% of budget
- [ ] [P] Red indicator when estimate > budget

### Budget Estimator -- Save & Track
- [ ] [A] "Save Estimate" persists to localStorage
- [ ] [A] Saved estimates appear in the recent list (max 5)
- [ ] [A] Clicking a saved estimate restores all values
- [ ] [A] Register as project calls `budget:registerProject`

### Budget IPC Bridge
- [ ] [A] All 26 IPC methods in `preload-budget.js` resolve without error
- [ ] [A] `budget:updated` event listener receives budget change notifications
- [ ] [A] `budget:warning` event listener receives threshold alerts
- [ ] [A] `budget:exportData` returns complete budget data object
- [ ] [A] `budget:importData` restores from exported data

---

## Automation Notes

- Dashboard and Setup windows can be opened programmatically via `electronApp.evaluate()`
- Budget IPC channels are testable via `electronApp.evaluate()` calling `ipcMain.handle` directly
- Pricing data can be mocked for deterministic calculator tests
- Setup wizard "already configured" state requires pre-seeding budget config
- Estimator localStorage tests need `page.evaluate()` to check persistence
- Budget check indicator color can be verified via element class or style attribute
