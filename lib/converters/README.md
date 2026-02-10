# Conversion Service Architecture

## Overview

The conversion service provides 59 converter agents for transforming content between formats. Each converter is an autonomous agent that can plan, execute, evaluate, and retry conversions.

## Architecture

### BaseConverterAgent

All converters extend `BaseConverterAgent` which provides:

- **plan(input, options)** - LLM-driven strategy selection
- **execute(input, strategy, options)** - Format-specific conversion logic
- **evaluate(input, output, strategy)** - Quality evaluation with structural checks + LLM spot-check
- **convert(input, options)** - Full lifecycle with agentic retry loop

### Event Logging

Every agent emits structured events through a `ConverterEventLogger`:

| Event | When |
|-------|------|
| converter:start | Conversion begins |
| converter:plan | Strategy selection starts |
| converter:plan:selected | Strategy chosen (includes method: llm/fallback/single-strategy) |
| converter:plan:fallback | LLM plan failed, using default |
| converter:plan:exhausted | All strategies tried, retrying best |
| converter:execute | Execution begins |
| converter:execute:done | Execution completed (includes duration) |
| converter:execute:error | Execution failed (includes error + stack) |
| converter:evaluate | Evaluation begins |
| converter:evaluate:structural | Structural checks running |
| converter:evaluate:issue | Issue detected (includes code, severity, fixable) |
| converter:evaluate:done | Evaluation completed (includes pass/fail, score) |
| converter:retry | Retrying with different strategy |
| converter:success | Conversion succeeded |
| converter:fail | Conversion failed after all attempts |
| converter:llm:call | LLM API call made |
| converter:llm:error | LLM API call failed |
| converter:config | Configuration logged at start |
| converter:attempt | New attempt starting |
| converter:best-updated | New best score achieved |
| converter:no-fixable | No fixable issues, stopping retries |
| converter:lifecycle-error | Error in plan/evaluate phase |

### Listening to Events

```javascript
const agent = new SomeConverterAgent();
agent.logger.on('converter:event', (event) => {
  console.log(`[${event.elapsed}ms] ${event.event}`, event);
});
const result = await agent.convert(input);
// Events also available in report:
console.log(result.report.events);
```

### Execution Report

Every conversion returns a report:

```javascript
{
  agentId: 'converter:md-to-html',
  agentName: 'Markdown to HTML',
  conversionId: 'uuid',
  totalDuration: 150,
  attemptCount: 1,
  attempts: [{ attempt: 1, strategy: 'standard', score: 90, ... }],
  decision: { strategyUsed: 'standard', whyThisStrategy: '...', retryCount: 0 },
  events: [/* full event log */],
}
```

## Converter Categories

- **Image** (4): image-format, image-to-text, image-to-pdf, image-resize
- **Video** (6): video-transcode, video-to-audio, video-to-text, video-to-image, video-to-gif, video-to-summary
- **Audio** (4): audio-format, audio-to-text, audio-to-video, text-to-audio
- **Markdown** (6): md-to-html, html-to-md, md-to-jupyter, jupyter-to-md, md-to-text, text-to-md
- **HTML** (3): html-to-text, html-to-pdf, html-to-image
- **PDF** (4): pdf-to-text, pdf-to-image, pdf-to-md, pdf-to-html
- **Office** (10): content-to-docx/pptx/xlsx, docx-to-text/md/html, pptx-to-text/md, xlsx-to-csv/json
- **Data** (5): csv-to-json, json-to-csv, json-yaml, csv-to-md, csv-to-html
- **URL** (5): url-to-html/md/text/pdf/image
- **Playbook** (6): content-to-playbook, playbook-to-md/html/docx/pptx/audio
- **Code** (4): code-to-html, code-to-md, code-to-explanation, jupyter-to-python
- **AI Generation** (2): text-to-image, text-to-video

## Testing

```bash
# Run all converter tests
npm run test:converters

# Run specific converter
npx vitest run test/unit/converters/md-to-html.test.js

# Run with event logging visible
DEBUG=converter:* npx vitest run test/unit/converters/md-to-html.test.js

# Run eval tests
npm run test:conversion:evals
```

## REST API

See CONVERSION-API.md for the full REST API reference.

## Debugging Tips

1. Check `result.report.events` for the full event trail
2. Look for `converter:execute:error` events for stack traces
3. Check `converter:evaluate:issue` events for quality problems
4. Use `converter:plan:selected` to see which strategy was chosen and why
5. On failure, `result.diagnosis` provides root cause analysis
