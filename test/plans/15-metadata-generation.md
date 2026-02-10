# Metadata Generation Test Plan

## Prerequisites

- App running (`npm start`)
- AI API keys configured (Anthropic and/or OpenAI for metadata generation)
- A test space with items of various types (image, text, code, HTML, PDF)
- Budget available for AI API calls

## Features Documentation

The metadata generator (`metadata-generator.js`) uses AI to generate structured metadata for items in Spaces. Each asset type has its own metadata schema (images get title/description/category/tags/extracted_text, code gets language/purpose/complexity, etc.). Generation is triggered automatically on item save (when `autoAIMetadata` is enabled) or manually via the metadata modal button. The system routes to different AI models: vision models for images/PDFs, large context models for text/code, and standard models for everything else. Generated metadata includes cost tracking and model info.

**Key files:** `metadata-generator.js`, `clipboard-manager-v2-adapter.js` (auto-trigger), `clipboard-viewer.js` (manual trigger)
**IPC:** `spaces:items:generateMetadata`
**Models:** Vision (Claude Sonnet), Large (GPT-5.2), Standard (Claude Sonnet)
**Common fields:** `_model_used`, `_method`, `_cost`, `ai_metadata_generated`, `ai_metadata_timestamp`

## Checklist

### Auto-Generation Triggers
- [ ] `[P]` Adding an image to a space auto-triggers metadata generation (when `autoAIMetadata` enabled)
- [ ] `[P]` Adding a code file auto-triggers metadata generation
- [ ] `[A]` Auto-generation is skipped when `autoAIMetadata` is disabled in settings

### Manual Generation
- [ ] `[M]` Click "Generate Metadata" button in metadata modal -- fields populate with AI results
- [ ] `[M]` Generated metadata includes title, description, and tags at minimum
- [ ] `[M]` Generation shows loading indicator while processing

### Image Metadata
- [ ] `[P]` Image metadata includes: title, description, category, tags, extracted_text
- [ ] `[P]` Category is one of: screenshot, photo, diagram, design, chart, document, ui-mockup, other
- [ ] `[P]` Vision model used (check `_method` field contains "vision")

### Code Metadata
- [ ] `[P]` Code metadata includes: title, description, language, purpose, complexity
- [ ] `[P]` Language correctly identified (JavaScript, Python, etc.)
- [ ] `[P]` Large context model used (check `_model_used` field)

### Text Metadata
- [ ] `[P]` Text metadata includes: title, description, contentType, topics, keyPoints, tags
- [ ] `[P]` Content type classified correctly (notes, article, documentation, etc.)

### Cost Tracking
- [ ] `[A]` Generated metadata includes `_cost` field with numeric value
- [ ] `[A]` `ai_metadata_generated` is set to `true` after generation
- [ ] `[A]` `ai_metadata_timestamp` is a valid ISO timestamp

## Automation Notes

- **Existing coverage:** None
- **Gaps:** All items need new tests
- **Spec file:** Create `test/e2e/metadata-generation.spec.js`
- **Strategy:** Upload test items via API, trigger generation via IPC, verify fields via API read-back
- **Cost warning:** Each test item generates an AI API call -- use small test content to minimize cost
- **Note:** Many items are `[P]` because generation is automated but results need human quality check
