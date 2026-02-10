# 28 -- Smart Export

## Overview

Three-surface export system: Format Picker modal (choose format and template), Preview window (rich document preview with AI generation), and Style Guide system. Supports 9 export formats with AI-enhanced content generation.

**Key files:** `smart-export-format-modal.html`, `smart-export-preview.html`, `smart-export-style-guide.html`, `smart-export.js`, `preload-smart-export.js`

## Prerequisites

- App running with at least one Space containing items
- AI API key configured (for AI-enhanced export)
- Smart Export triggered from Spaces UI

## Features

### Format Picker Modal (`smart-export-format-modal.html`)
- 9 format cards in 3-column grid: PDF, DOCX, TXT, PPTX, Web Slides, XLSX, CSV, HTML, Markdown
- Category tabs: All Formats, Documents, Presentations, Data, Web
- 4 export options: Include Images, Include Metadata, AI-Enhanced Content, Table of Contents
- Template selector: 9 templates (Auto-detect, Article, Business Report, Technical Documentation, One-Pager, Design Brief, Product Requirements, Infographic, Dashboard)
- Space context badge: icon + name + item count
- Loading overlay with spinner during generation
- Keyboard shortcuts: Escape to close, Enter to create

### Export Preview (`smart-export-preview.html`)
- Rich document preview via iframe
- Source code view: editable textarea for raw HTML
- Style guide panel: view/edit/copy CSS styles, preview iframe
- AI thinking panel: shows AI reasoning during generation (hidden by default)
- Multi-step loading animation: 4 stages (Analyzing, Preparing, AI Processing, Formatting)
- Progress bar with rotating tips and status text
- Mermaid diagram rendering support
- Template browsing and selection
- Export actions: Save to Space, Export as HTML, Export as PDF
- Regenerate button to re-run AI generation
- Style guide dropdown: select built-in styles, add from URLs

### Style Guide System
- Built-in styles (e.g., "Journey Map")
- View Source / Copy CSS buttons
- Editable CSS textarea
- Preview iframe for live style preview
- Add new styles from URLs via `smart-export:extract-styles`

### 9 Export Formats
1. PDF -- formatted document export
2. Word (.docx) -- Microsoft Word compatible
3. Plain Text (.txt) -- unformatted text
4. PowerPoint (.pptx) -- slide presentation
5. Web Slides (.html) -- HTML-based presentation
6. Excel (.xlsx) -- spreadsheet with data
7. CSV (.csv) -- comma-separated data
8. Web Page (.html) -- standalone web page
9. Markdown (.md) -- markdown formatted text

---

## Checklist

### Format Picker -- Window
- [ ] [A] Format picker opens via IPC `smart-export:open-modal`
- [ ] [A] Window loads without console errors
- [ ] [M] 9 format cards render in grid layout
- [ ] [A] Window closes on Escape key

### Format Picker -- Category Tabs
- [ ] [M] "All Formats" tab shows all 9 formats
- [ ] [M] "Documents" tab filters to PDF, DOCX, TXT
- [ ] [M] "Presentations" tab filters to PPTX, Web Slides
- [ ] [M] "Data" tab filters to XLSX, CSV
- [ ] [M] "Web" tab filters to HTML, Markdown

### Format Picker -- Options
- [ ] [M] Include Images checkbox toggles
- [ ] [M] Include Metadata checkbox toggles
- [ ] [M] AI-Enhanced Content checkbox toggles
- [ ] [M] Table of Contents checkbox toggles

### Format Picker -- Template
- [ ] [M] Template dropdown lists 9 templates
- [ ] [M] Selecting a template updates the selection
- [ ] [M] "Auto-detect" is the default selection

### Format Picker -- Space Context
- [ ] [A] Space context badge shows correct space name and item count via `getSpaceForExport()`

### Format Picker -- Create
- [ ] [M] Selecting a format enables the "Create Document" button
- [ ] [A] Clicking "Create Document" calls `generateExport()` with correct parameters
- [ ] [M] Loading overlay appears during generation
- [ ] [M] Enter key triggers create when format selected

### Export Preview -- Window
- [ ] [A] Preview window opens after format picker completes
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly

### Export Preview -- Tabs
- [ ] [M] Preview tab shows rendered document in iframe
- [ ] [M] Source Code tab shows editable HTML
- [ ] [M] Style Guide tab shows CSS controls
- [ ] [P] AI Thinking tab shows AI reasoning (when AI-enhanced)

### Export Preview -- Loading
- [ ] [M] Multi-step loading animation shows 4 stages
- [ ] [M] Progress bar fills progressively
- [ ] [M] Rotating tips display during loading
- [ ] [M] Status text updates per stage

### Export Preview -- Preview
- [ ] [M] Rendered document displays correctly in iframe
- [ ] [M] Images render if "Include Images" was selected
- [ ] [M] Table of Contents renders if selected
- [ ] [P] Mermaid diagrams render as SVGs

### Export Preview -- Source Code
- [ ] [M] Source textarea shows raw HTML
- [ ] [M] Editing source code updates preview on tab switch

### Export Preview -- Style Guide
- [ ] [M] Style guide dropdown lists available styles
- [ ] [M] "View Source" button shows CSS
- [ ] [M] "Copy CSS" button copies to clipboard
- [ ] [M] Editable CSS textarea updates preview
- [ ] [P] Adding a style from URL extracts and applies CSS

### Export Preview -- Actions
- [ ] [A] "Save to Space" saves HTML to the source Space
- [ ] [A] "Export HTML" downloads an HTML file
- [ ] [A] "Export PDF" generates and downloads a PDF
- [ ] [M] "Regenerate" re-runs AI generation

### Export Format Verification
- [ ] [A] PDF export produces a valid PDF file
- [ ] [A] DOCX export produces a valid Word document
- [ ] [A] TXT export produces a plain text file
- [ ] [A] PPTX export produces a valid PowerPoint file
- [ ] [P] Web Slides export produces an HTML presentation
- [ ] [A] XLSX export produces a valid Excel file
- [ ] [A] CSV export produces valid comma-separated data
- [ ] [A] HTML export produces a standalone web page
- [ ] [A] Markdown export produces valid markdown text

---

## Automation Notes

- Format picker can be opened and interacted with via Playwright
- Category tab filtering verifiable by counting visible format cards
- Export generation requires AI API for enhanced content -- mock for CI
- Preview iframe content accessible via `page.frame()` in Playwright
- Export file verification: check MIME type, file size > 0, basic content validation
- PDF generation requires headless Chromium (bundled in Electron)
- Style guide extraction requires a reachable URL -- use a local test page
- Mermaid diagram rendering depends on Mermaid.js loading in the iframe
