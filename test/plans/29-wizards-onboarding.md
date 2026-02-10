# 29 -- Wizards & Onboarding

## Overview

Four wizard interfaces: Setup Wizard (IDW/agent management), Onboarding Wizard (project setup), Intro Wizard (first-launch/what's new), and Extension Setup (browser extension installation).

**Key files:** `setup-wizard.html`, `onboarding-wizard.html`, `intro-wizard.html`, `extension-setup.html`, `preload.js`

## Prerequisites

- App running
- For setup wizard: at least one IDW environment URL
- For extension setup: Chrome browser installed
- For intro wizard: control `lastSeenVersion` in localStorage

## Features

### Setup Wizard (`setup-wizard.html`)
- Central management hub for digital workers and agents
- Add/remove IDWs with name, URL, and GSX link configuration
- Add external AI agents: ChatGPT, Claude, Perplexity, Gemini, Grok, custom
- Add AI image creators: Midjourney, Stable Diffusion, Ideogram, OpenAI Image, Adobe Firefly
- Add AI video creators: Veo3, Flow, Runway, Pika, Synthesia, HeyGen
- Add AI audio generators: Music, Sound Effects, Narration/Voice, Custom categories
- Add UI design tools
- Category filtering: All, IDWs, External AI, Image, Video, Audio, UI Design
- Agent Explorer for pre-built agents
- Multi-step wizard with progress bar

### Onboarding Wizard (`onboarding-wizard.html`)
- 4-step project onboarding flow
- Step 1: Project discovery (name, description, priority)
- Step 2: AI-generated project plan with improvement suggestions
  - Suggestion chips: add milestones, risks, metrics, resources
  - Freeform improvement requests
  - Plan approval: approve inline or email for review
- Step 3: Invite collaborators
  - Humans: name, email, role
  - AI agents: Research, Developer, Writer, QA presets
  - Bidding HUD explanation
- Step 4: Completion summary with IDW introduction
  - Feature showcase: Hyperconnected, Intelligent Routing, Live Dashboard, Proactive Management
  - "Launch Tour" button

### Intro Wizard (`intro-wizard.html`)
- Dual-mode: Intro (first-time) or Updates (returning user)
- **Intro mode:** 4-slide carousel
  - Slide 1: Welcome banner with product image
  - Slide 2: Feature grid (Spaces, GSX Create, Video Editor, AI Agents)
  - Slide 3: Intelligent Digital Workers overview
  - Slide 4: "Ready to Go" with keyboard shortcut tips
- **Updates mode:** Version changelog from v3.0.0 to current
  - Blog-post-style entries with NEW badge on current version
  - Change tags: new (green), improved (blue), fixed (orange)
  - Scrollable changelog
- Keyboard navigation: arrow keys, Enter, Escape
- Progress dots for slides

### Extension Setup (`extension-setup.html`)
- Browser selection: Chrome vs Safari
- Chrome: step-by-step extension install instructions
  - Developer mode instructions
  - "Load unpacked" instructions
  - Auth token display and copy-to-clipboard
  - Extension path display
  - "Open Chrome Extensions" and "Show in Finder" buttons
- Safari: "Coming soon" placeholder with workarounds
- Automatic connection status polling (every 2 seconds)
- Success message when extension connects

---

## Checklist

### Setup Wizard -- Window
- [ ] [A] Setup Wizard opens via App menu > Manage Environments or IDW > Add/Remove (Cmd+A)
- [ ] [A] Window loads without console errors
- [ ] [A] Window opens as modal (parent: main window)
- [ ] [A] Window closes cleanly

### Setup Wizard -- Category Filter
- [ ] [M] "All" shows all configured items
- [ ] [M] "IDWs" filters to IDW entries only
- [ ] [M] "External AI" filters to external bot entries
- [ ] [M] "Image" filters to image creator entries
- [ ] [M] "Video" filters to video creator entries
- [ ] [M] "Audio" filters to audio generator entries
- [ ] [M] "UI Design" filters to design tool entries

### Setup Wizard -- Add IDW
- [ ] [M] "Add" button opens the add wizard
- [ ] [M] Choose IDW type
- [ ] [M] Enter name, URL, and GSX link
- [ ] [A] Saving adds the IDW to the configuration
- [ ] [A] New IDW appears in the manager list
- [ ] [A] Menu refreshes with new IDW entry

### Setup Wizard -- Add External AI
- [ ] [M] Choose external AI type
- [ ] [M] Select preset (ChatGPT, Claude, Perplexity, Gemini, Grok) or custom
- [ ] [M] Enter name and URL for custom
- [ ] [A] Saving adds the agent to configuration
- [ ] [A] Agent appears in IDW menu under External Bots

### Setup Wizard -- Add Image/Video/Audio Creator
- [ ] [M] Choose image/video/audio creator type
- [ ] [M] Select from preset services
- [ ] [A] Saving adds to configuration
- [ ] [A] Creator appears in IDW menu under appropriate section

### Setup Wizard -- Remove
- [ ] [M] Select an item from the manager list
- [ ] [M] Delete button removes the item
- [ ] [A] Item is removed from configuration
- [ ] [A] Menu refreshes without removed item

### Onboarding Wizard -- Window
- [ ] [A] Onboarding opens via IPC or first-launch trigger
- [ ] [A] Window loads without console errors
- [ ] [A] 4-step progress bar displays

### Onboarding Wizard -- Step 1
- [ ] [M] Project name input accepts text
- [ ] [M] Description textarea accepts text
- [ ] [M] Priority selector works
- [ ] [M] "Continue" advances to Step 2

### Onboarding Wizard -- Step 2
- [ ] [P] AI generates a project plan from Step 1 inputs
- [ ] [P] Plan shows goals, timeline, and success metrics
- [ ] [M] Suggestion chips add content to the plan
- [ ] [M] Freeform input allows custom improvements
- [ ] [M] "Approve Now" advances to Step 3
- [ ] [M] "Email Me the Plan" opens email form

### Onboarding Wizard -- Step 3
- [ ] [M] Humans tab shows collaborator form
- [ ] [M] Add human collaborator with name, email, role
- [ ] [M] AI Agents tab shows preset agent cards
- [ ] [M] Selecting an agent preset adds it to the team

### Onboarding Wizard -- Step 4
- [ ] [M] Completion summary shows checklist
- [ ] [M] IDW feature showcase renders
- [ ] [M] "Launch Tour" button is clickable

### Intro Wizard -- Window
- [ ] [A] Intro Wizard opens via `createIntroWizardWindow()` or first-launch
- [ ] [A] Window loads without console errors

### Intro Wizard -- Intro Mode
- [ ] [M] Slide 1: Welcome banner renders
- [ ] [M] Slide 2: Feature grid shows 4 features
- [ ] [M] Slide 3: IDW overview renders
- [ ] [M] Slide 4: Keyboard shortcuts display
- [ ] [M] Progress dots update per slide
- [ ] [M] Arrow keys navigate between slides
- [ ] [M] "Get Started" closes wizard

### Intro Wizard -- Updates Mode
- [ ] [P] Changelog loads version entries
- [ ] [P] Current version has "NEW" badge
- [ ] [P] Change tags are color-coded (new/improved/fixed)
- [ ] [M] Changelog is scrollable
- [ ] [M] "Continue to App" closes wizard

### Extension Setup -- Window
- [ ] [A] Extension Setup opens via Help > Browser Extension Setup
- [ ] [A] Window loads without console errors

### Extension Setup -- Chrome
- [ ] [M] Chrome tab shows step-by-step instructions
- [ ] [M] Auth token displays in monospace box
- [ ] [M] "Copy" button copies token to clipboard
- [ ] [M] Extension path displays
- [ ] [M] "Open Chrome Extensions" button works
- [ ] [M] "Show in Finder" button works

### Extension Setup -- Connection
- [ ] [A] Connection polling runs every 2 seconds
- [ ] [P] Success message appears when extension connects
- [ ] [M] Status indicator shows connected/disconnected

### Extension Setup -- Safari
- [ ] [M] Safari tab shows "Coming soon" message

---

## Automation Notes

- All wizards testable via window lifecycle smoke tests
- Setup Wizard configuration changes verify via `settings.json` or IPC
- Menu refresh after setup wizard changes verifiable via menu IPC
- Onboarding Step 2 AI plan generation requires API key -- mock for CI
- Intro Wizard mode detection depends on `lastSeenVersion` -- settable via `page.evaluate()`
- Extension Setup connection polling testable with a mock WebSocket/HTTP endpoint
- Keyboard navigation testable via Playwright `keyboard.press()`
