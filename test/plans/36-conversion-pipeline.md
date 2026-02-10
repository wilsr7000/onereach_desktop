# Conversion Pipeline Test Plan

## Prerequisites

- App running (`npm start`)
- Spaces API healthy on port 47291 (conversion routes mounted)
- FFmpeg available on `$PATH` (for audio/video converters)
- Test fixtures present in `test/fixtures/conversion/`
- For Tier 2 live evals: `EVAL_LIVE=true` environment variable

## Features Documentation

The conversion system provides 59 file converter agents orchestrated by a central service with REST API endpoints. Each converter extends `BaseConverterAgent` and follows a plan-execute-evaluate lifecycle with agentic retry. Converters with `generative` mode include a built-in LLM-as-judge quality evaluation via `_llmSpotCheck()`, producing a 0-100 quality score in `result.report.finalScore`.

**Key files:**
- `lib/conversion-service.js` -- Central orchestrator (registry, pipeline resolver, job queue)
- `lib/conversion-routes.js` -- REST API endpoints
- `lib/converters/base-converter-agent.js` -- Base class with plan/execute/evaluate lifecycle
- `lib/converters/*.js` -- 59 individual converter agents
- `lib/converters/playbook-validator.js` -- Playbook validation
- `lib/converters/playbook-diagnostics.js` -- Playbook diagnostics

**REST endpoints (port 47291):**
- `POST /api/convert` -- Convert content between formats
- `GET /api/convert/capabilities` -- List all converters
- `GET /api/convert/graph` -- Format conversion graph
- `POST /api/convert/pipeline` -- Multi-step conversion
- `GET /api/convert/status/:jobId` -- Async job status
- `POST /api/convert/validate/playbook` -- Validate playbook
- `POST /api/convert/diagnose/playbook` -- Diagnose playbook issues

**IPC namespace:** `window.convert.convert()`, `window.convert.capabilities()`, `window.convert.graph()`, `window.convert.pipeline()`, `window.convert.status()`, `window.convert.validatePlaybook()`, `window.convert.diagnosePlaybook()`

## Testing Strategy

**Tier 1 (Deterministic):** Converters using libraries (marked, turndown, Sharp, FFmpeg, etc.) with predictable output. Assert exact content or structural properties.

**Tier 2 (AI/Creative):** Converters calling LLMs, Whisper, TTS, DALL-E. Assert `result.report.finalScore >= 70` (built-in LLM judge) plus structural checks. With `EVAL_LIVE=true`, expanded rubric scoring via `judgeWithRubric()` in `test/evals/converter-quality.eval.js`.

## Checklist

### REST API / Service Layer
- [ ] `[A]` `GET /api/convert/capabilities` returns all 59 converters with id, name, from, to
- [ ] `[A]` `GET /api/convert/graph` returns format adjacency graph with edges
- [ ] `[A]` `POST /api/convert` with `{input: "# Hello", from: "md", to: "html"}` returns HTML output
- [ ] `[A]` `POST /api/convert` with missing `input` returns 400
- [ ] `[A]` `POST /api/convert` with missing `from` returns 400
- [ ] `[A]` `POST /api/convert` with missing `to` returns 400
- [ ] `[A]` `POST /api/convert` with unsupported from/to pair returns 422
- [ ] `[A]` `POST /api/convert` with `async: true` returns `{jobId, status: "queued"}`
- [ ] `[A]` `GET /api/convert/status/:jobId` returns job progress or completion
- [ ] `[A]` `POST /api/convert/pipeline` with `{input: "a,b\n1,2", steps: [{to: "json"}, {to: "yaml"}]}` succeeds
- [ ] `[A]` `POST /api/convert/pipeline` with invalid steps returns error
- [ ] `[A]` `POST /api/convert/validate/playbook` with valid playbook returns pass
- [ ] `[A]` `POST /api/convert/validate/playbook` with invalid playbook returns validation errors
- [ ] `[A]` `POST /api/convert/diagnose/playbook` returns diagnosis with suggestions

### Tier 1: Deterministic Text/Markup
- [ ] `[A]` `md -> html` preserves headings, lists, code blocks (exact tag check)
- [ ] `[A]` `html -> md` round-trips heading + paragraph + list structure
- [ ] `[A]` `html -> text` strips all tags, preserves text content
- [ ] `[A]` `md -> text` strips formatting, preserves content
- [ ] `[A]` `md -> jupyter` creates valid .ipynb JSON with cells array
- [ ] `[A]` `jupyter -> md` extracts markdown and code cell content
- [ ] `[A]` `csv -> html` produces `<table>` with correct row/column count
- [ ] `[A]` `csv -> md` produces pipe-delimited markdown table
- [ ] `[A]` `csv -> json` parses all rows with correct field names
- [ ] `[A]` `json -> csv` produces header row + data rows matching input

### Tier 1: Deterministic Data/Document
- [ ] `[A]` `json <-> yaml` round-trips preserving all keys and values
- [ ] `[A]` `xlsx -> csv` extracts all rows from first sheet
- [ ] `[A]` `xlsx -> json` extracts rows as array of objects
- [ ] `[A]` `content -> docx` produces non-empty DOCX buffer (ZIP magic bytes 50 4B)
- [ ] `[A]` `content -> xlsx` produces non-empty XLSX buffer
- [ ] `[A]` `docx -> text` extracts readable text from DOCX fixture
- [ ] `[A]` `docx -> md` produces markdown with headings from DOCX fixture
- [ ] `[A]` `docx -> html` produces HTML with paragraph tags from DOCX fixture
- [ ] `[A]` `pptx -> text` extracts slide text from PPTX fixture
- [ ] `[A]` `pptx -> md` produces markdown with slide headings from PPTX fixture

### Tier 1: Deterministic Media
- [ ] `[A]` `image-format` converts PNG to JPG (valid JFIF header)
- [ ] `[A]` `image-resize` output has target dimensions (Sharp metadata check)
- [ ] `[A]` `image -> pdf` produces valid PDF buffer (25 50 44 46 magic bytes)
- [ ] `[P]` `video-transcode` mp4 to webm produces valid WebM (FFprobe check)
- [ ] `[P]` `video -> audio` extracts audio track as non-empty audio file
- [ ] `[P]` `video -> image` extracts frame as valid PNG/JPG
- [ ] `[P]` `video -> gif` produces animated GIF (GIF89a header)
- [ ] `[A]` `audio-format` mp3 to wav produces valid WAV header (RIFF magic)

### Tier 1: Deterministic Code
- [ ] `[A]` `code -> html` produces syntax-highlighted HTML with `<span>` class attributes
- [ ] `[A]` `jupyter -> python` extracts code cells as valid Python script
- [ ] `[A]` `code -> md` wraps source in fenced code block with language tag

### Tier 2: AI Creative -- LLM-Judged Quality
- [ ] `[A]` `text -> md` output contains heading + `finalScore >= 70`
- [ ] `[A]` `image -> text` returns non-empty description > 10 chars + `finalScore >= 70`
- [ ] `[A]` `content -> playbook` output has title/sections + `finalScore >= 70`
- [ ] `[A]` `content -> pptx` produces non-empty PPTX buffer + `finalScore >= 70`
- [ ] `[A]` `text -> image` returns valid image buffer > 1KB + `finalScore >= 70`
- [ ] `[A]` `text -> audio` returns valid audio buffer + `finalScore >= 70`
- [ ] `[A]` `text -> video` returns valid video buffer + `finalScore >= 70`
- [ ] `[A]` `audio -> video` returns valid video buffer + `finalScore >= 70`
- [ ] `[A]` `playbook -> audio` returns valid audio buffer + `finalScore >= 70`
- [ ] `[A]` `pdf -> text` returns non-empty string + `finalScore >= 70`
- [ ] `[A]` `code -> explanation` explains function logic + `finalScore >= 70`
- [ ] `[A]` `video -> summary` captures key content keywords + `finalScore >= 70`
- [ ] `[A]` `video -> text` transcription contains expected keywords + `finalScore >= 70`
- [ ] `[A]` `audio -> text` transcription contains expected keywords + `finalScore >= 70`
- [ ] `[A]` `pdf -> md` preserves document headings + `finalScore >= 70`
- [ ] `[A]` `pdf -> html` produces HTML with content + `finalScore >= 70`
- [ ] `[A]` `playbook -> md` renders all sections with headings + `finalScore >= 70`
- [ ] `[A]` `playbook -> html` renders HTML with section structure + `finalScore >= 70`
- [ ] `[A]` `playbook -> pptx` produces PPTX buffer + `finalScore >= 70`

### URL Converters
- [ ] `[P]` `url -> html` fetches raw HTML from known URL (requires network)
- [ ] `[P]` `url -> md` converts fetched HTML to readable markdown
- [ ] `[P]` `url -> text` extracts plain text from fetched page
- [ ] `[P]` `url -> pdf` captures page as valid PDF
- [ ] `[P]` `url -> image` captures screenshot as valid PNG

### New Converters (v2)
- [ ] `[A]` `md -> pdf` produces valid PDF buffer with %PDF magic bytes
- [ ] `[A]` `md -> pdf` styled strategy injects print stylesheet
- [ ] `[A]` `docx -> pdf` produces valid PDF buffer from DOCX input
- [ ] `[A]` `docx -> pdf` styled strategy includes document CSS
- [ ] `[P]` `gif -> video` converts GIF to MP4 via FFmpeg
- [ ] `[P]` `gif -> video` converts GIF to WebM via FFmpeg
- [ ] `[A]` `gif -> video` loop strategy repeats animation
- [ ] `[A]` `audio -> summary` transcript-summary produces text summary + `finalScore >= 70`
- [ ] `[A]` `audio -> summary` chapter-summary produces structured chapters + `finalScore >= 70`
- [ ] `[A]` `audio -> summary` key-points extracts bullet takeaways + `finalScore >= 70`
- [ ] `[A]` `json -> html` table strategy produces `<table>` with headers and data
- [ ] `[A]` `json -> html` tree strategy produces nested `<ul>` structure
- [ ] `[A]` `json -> html` pretty strategy produces syntax-highlighted `<pre>` block
- [ ] `[A]` `json -> html` escapes HTML entities in data values
- [ ] `[A]` `json -> md` table strategy produces pipe-delimited Markdown table
- [ ] `[A]` `json -> md` yaml-block strategy produces fenced YAML code block
- [ ] `[A]` `json -> md` list strategy produces nested bullet list
- [ ] `[A]` `xml -> json` parses XML to valid JSON preserving structure
- [ ] `[A]` `json -> xml` builds valid XML from JSON object
- [ ] `[A]` `xml <-> json` round-trip preserves keys and values
- [ ] `[A]` `xml -> json` compact strategy flattens attributes
- [ ] `[A]` `xml -> json` verbose strategy preserves all attributes and namespaces

### Create New Agent End-to-End
- [ ] `[A]` Create a minimal converter agent extending `BaseConverterAgent` with custom `from`/`to`
- [ ] `[A]` New agent has `id`, `name`, `description`, `from`, `to`, `modes`, `strategies` properties
- [ ] `[A]` New agent `plan()` selects a strategy and returns `{strategy, reasoning}`
- [ ] `[A]` New agent `execute()` transforms input and returns `{output, duration}`
- [ ] `[A]` New agent `convert()` runs full lifecycle and returns `{success, output, report}`
- [ ] `[A]` Report contains `agentId`, `agentName`, `attempts`, `finalScore`, `events`, `decision`
- [ ] `[A]` Report `events` array includes `converter:start` event
- [ ] `[A]` Report `attempts` array has at least one entry with `strategy`, `score`, `duration`
- [ ] `[A]` New agent handles null/empty input gracefully (does not throw unhandled)
- [ ] `[A]` New agent auto-discovered by `ConversionService.initialize()` when file is in `lib/converters/`
- [ ] `[A]` New agent appears in `GET /api/convert/capabilities` response after service init
- [ ] `[A]` New agent's formats appear in `GET /api/convert/graph` adjacency edges
- [ ] `[A]` `POST /api/convert` with the new agent's `from`/`to` pair returns converted output
- [ ] `[A]` New agent's conversion passes `testConverterAgent()` harness (lifecycle compliance suite)
- [ ] `[A]` New agent with `generative` mode includes `_llmSpotCheck()` score in report
- [ ] `[A]` Removing the agent file de-registers it from capabilities on next service init

### Pipeline & Multi-Step
- [ ] `[A]` Pipeline resolver finds shortest path for `docx -> html` via intermediate
- [ ] `[A]` Pipeline resolver returns "no path" for impossible conversion
- [ ] `[A]` Multi-step pipeline `csv -> json -> yaml` produces valid YAML
- [ ] `[P]` Multi-step pipeline `pdf -> text -> playbook` produces valid playbook
- [ ] `[A]` Pipeline handles failure in middle step gracefully (error + partial report)

## Automation Notes

- **Existing unit tests:** `test/unit/converters/` (66 files, mock AI, lifecycle compliance via `converter-test-harness.js`)
- **Quality evals:** `test/evals/converter-quality.eval.js` (20+ converters, LLM-as-judge rubrics)
- **Test harness:** `test/mocks/converter-test-harness.js` (standardized lifecycle tests)
- **Mock infrastructure:** `test/mocks/conversion-mocks.js` (deterministic AI, Sharp mocks)
- **Fixtures:** `test/fixtures/conversion/` (sample.md, .html, .csv, .json, .yaml, .py, .ipynb, .playbook)
- **Spec file:** `test/e2e/conversion-pipeline.spec.js` for REST API items
- **LLM judge:** Primary quality gate for Tier 2 via `result.report.finalScore >= 70`
- **Two modes:** `EVAL_LIVE=false` (CI, mock AI, fast) / `EVAL_LIVE=true` (real AI, on-demand quality audit)
- **URL tests:** Require network; `[P]` for automated fetch + human spot-check
- **Video/audio tests:** Require FFmpeg + test media files in `test/fixtures/media/`
