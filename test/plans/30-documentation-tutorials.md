# 30 -- Documentation & Tutorials

## Overview

In-app documentation windows (User Guide, AI Run Times Guide, Spaces API Guide) and the Tutorials/Agentic University hub. Also covers the AI Run Times feed window.

**Key files:** `docs-readme.html`, `docs-ai-insights.html`, `docs-spaces-api.html`, `tutorials.html`, `tutorials.js`, `Flipboard-IDW-Feed/uxmag.html`

## Prerequisites

- App running
- Internet connection (for tutorials content and AI Run Times feed)

## Features

### User Guide (`docs-readme.html`)
- Navigation pills: Getting Started, Daily Use, AI Run Times, Troubleshooting, FAQ
- Getting Started: 4-step quick setup (open wizard, add environment, add GSX services, start working)
- Daily Use Guide: morning startup, switching environments, using GSX services, integrated testing
- Common tasks reference table with keyboard shortcuts
- Window management tips
- AI Run Times section: RSS reader overview with reading time estimation
- Troubleshooting: environment won't load, AI Run Times issues, missing menu items
- Advanced troubleshooting with Developer Tools instructions
- FAQ: multiple environments, session persistence, custom links, updates, security, export/import
- Info boxes (blue), warning boxes (amber), success boxes (green), tip boxes (purple)

### AI Run Times Guide (`docs-ai-insights.html`)
- Quick Start: 4-step guide (open via menu, wait for load, reading times auto-update, click to read)
- Feature documentation: intelligent reading time estimation (200 wpm), real-time content fetching
- Technical details: word counting, Electron net.request for CORS bypass, IPC communication
- Interface guide: article tiles, reading time badges, progress bars, green highlights
- Troubleshooting: "Loading..." stuck, articles not loading, progress bars showing zeros

### Spaces API Guide (`docs-spaces-api.html`)
- REST API endpoint documentation for port 47291
- Space CRUD operations
- Item management
- Tag management
- Search API
- File upload API

### Tutorials (`tutorials.html`)
- Netflix-style tutorial browser
- Hero section branded "Agentic University"
- Sticky navigation with dynamic category tabs
- Featured content carousel (600px cards, horizontal scroll)
- Tutorial grid with 16:9 aspect ratio cards
- Duration badges on cards
- "New" and "Completed" badges
- "Recommended" badges on featured content
- Progress tracking per tutorial
- Loading overlay with shimmer placeholders

### AI Run Times Feed (`Flipboard-IDW-Feed/uxmag.html`)
- Flipboard-style content feed
- Article tiles with reading time estimation
- Real-time content fetching
- Progress tracking

---

## Checklist

### User Guide -- Window
- [ ] [A] User Guide opens via Help > Documentation > Local Documentation
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly

### User Guide -- Navigation
- [ ] [M] "Getting Started" pill navigates to that section
- [ ] [M] "Daily Use" pill navigates to that section
- [ ] [M] "AI Run Times" pill navigates to that section
- [ ] [M] "Troubleshooting" pill navigates to that section
- [ ] [M] "FAQ" pill navigates to that section

### User Guide -- Content
- [ ] [M] Getting Started shows 4-step quick setup
- [ ] [M] Common tasks table renders with keyboard shortcuts
- [ ] [M] Info/warning/success/tip boxes render with correct colors
- [ ] [M] FAQ items are visible and readable

### AI Run Times Guide -- Window
- [ ] [A] AI Run Times Guide opens via Help > Documentation > AI Run Times Guide
- [ ] [A] Window loads without console errors

### AI Run Times Guide -- Content
- [ ] [M] Quick Start shows 4-step guide
- [ ] [M] Feature documentation sections render
- [ ] [M] Technical details are present
- [ ] [M] Troubleshooting section is present

### Spaces API Guide -- Window
- [ ] [A] Spaces API Guide opens via Help > Developer Docs > Spaces API Guide
- [ ] [A] Window loads without console errors

### Spaces API Guide -- Content
- [ ] [M] REST API endpoints documented
- [ ] [M] Request/response examples are present
- [ ] [M] All CRUD operations are covered (Spaces, Items, Tags, Search)

### Tutorials -- Window
- [ ] [A] Tutorials opens via Agentic University > Quick Starts > View All Tutorials
- [ ] [A] Window loads without console errors

### Tutorials -- Navigation
- [ ] [M] Hero section renders with branding
- [ ] [M] Category tabs display in sticky nav
- [ ] [M] Clicking a category tab scrolls to that section

### Tutorials -- Featured Content
- [ ] [M] Featured carousel renders with 600px cards
- [ ] [M] Carousel scrolls horizontally
- [ ] [M] Play button is visible on feature cards
- [ ] [M] "Recommended" badge shows on featured items

### Tutorials -- Tutorial Grid
- [ ] [M] Tutorial cards render in responsive grid
- [ ] [M] Duration badge shows on each card
- [ ] [M] "New" badge shows on new tutorials
- [ ] [M] "Completed" badge shows on completed tutorials
- [ ] [P] Progress bar reflects viewing progress

### Tutorials -- Loading
- [ ] [M] Loading overlay shows while content fetches
- [ ] [M] Shimmer placeholders display during load

### AI Run Times Feed -- Window
- [ ] [A] AI Run Times feed opens via Agentic University > AI Run Times
- [ ] [A] Window loads without console errors

### AI Run Times Feed -- Content
- [ ] [P] Article tiles render with reading time estimation
- [ ] [P] Content fetches from RSS sources
- [ ] [P] Progress bars show reading progress
- [ ] [M] Clicking an article opens it for reading

---

## Automation Notes

- All doc windows testable via window lifecycle smoke tests
- Navigation pill/tab clicks testable via Playwright click + scroll verification
- Content presence verifiable by checking for expected DOM elements/text
- Tutorials content may require internet access for dynamic loading
- AI Run Times feed requires internet for RSS fetching
- Reading time estimation accuracy can be verified with known word-count articles
- Progress tracking requires simulating scroll/viewing events
