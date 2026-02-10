# Item Tagging Test Plan

## Prerequisites

- App running (`npm start`)
- Spaces API healthy on port 47291
- A test space created for item creation

## Features Documentation

When items are added to Spaces, they are automatically classified by content type. The system detects file types from extensions (50+ mappings), content patterns (JSON, XML, YAML, CSV, HTML, code, markdown, URL), and specialized subtypes (style-guide, journey-map for JSON). Each item gets four classification fields: `type` (text/image/html/code/file), `fileType` (specific format), `fileCategory` (media/document/code/data/design/archive), and `fileExt` (extension with dot prefix).

**Key files:** `clipboard-storage-v2.js` (`detectContentType()`, `getFileType()`), `clipboard-manager-v2-adapter.js` (file category detection)
**Detection methods:** Extension mapping, content pattern matching, MIME type

## Checklist

### Content Type Detection
- [ ] `[A]` Plain text content detected as `type: "text"`
- [ ] `[A]` JSON string (`{"key": "value"}`) detected as `json` content type
- [ ] `[A]` XML string (`<?xml ...>`) detected as `xml` content type
- [ ] `[A]` YAML string (`---\nkey: value`) detected as `yaml` content type
- [ ] `[A]` CSV string (multiple rows with commas) detected as `csv` content type
- [ ] `[A]` HTML string (`<html><body>...`) detected as `html` content type
- [ ] `[A]` JavaScript code (`function foo() {}`) detected as code
- [ ] `[A]` Python code (`def foo():`) detected as code
- [ ] `[A]` Markdown content (headers, lists) detected as `markdown`
- [ ] `[A]` URL string (`https://example.com`) detected as `url`

### File Extension Mapping
- [ ] `[A]` `.js` file tagged as `code` category, `javascript` fileType
- [ ] `[A]` `.png` file tagged as `media` category, `image` type
- [ ] `[A]` `.pdf` file tagged as `document` category, `pdf` fileType
- [ ] `[A]` `.mp4` file tagged as `media` category, `video` fileType

## Automation Notes

- **Existing coverage:** None (no spec file for type detection)
- **Gaps:** All items need new tests
- **Spec file:** Create `test/unit/item-tagging.test.js` (unit tests, not E2E)
- **Strategy:** These are highly automatable as pure-function unit tests
- **Approach:** Import `detectContentType()` and `getFileType()` directly and test with sample inputs
- **Note:** This is one of the most automatable areas -- 12 of 14 items are `[A]`
