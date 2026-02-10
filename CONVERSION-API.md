# Conversion API Reference

## Endpoints

### POST /api/convert
Convert content between formats.

**Request:**
```json
{
  "input": "base64-or-text-content",
  "from": "md",
  "to": "html",
  "mode": "symbolic",
  "options": {},
  "async": false
}
```

**Response (sync):**
```json
{
  "success": true,
  "output": "converted content (base64 for binary)",
  "metadata": {},
  "report": { "agentId": "...", "events": ["..."] }
}
```

**Response (async):**
```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

### GET /api/convert/capabilities
List all available converters.

### GET /api/convert/graph
Get the conversion graph (format -> format edges).

### POST /api/convert/pipeline
Run multi-step conversion.

**Request:**
```json
{
  "input": "content",
  "steps": [{ "to": "text" }, { "to": "md" }]
}
```

### GET /api/convert/status/:jobId
Check async job status.

### POST /api/convert/validate/playbook
Validate a playbook structure.

### POST /api/convert/diagnose/playbook
Get LLM diagnosis for playbook issues.

## IPC Bridge (Renderer Process)

```javascript
// From any renderer window:
const result = await window.convert.convert({ input: 'hello', from: 'text', to: 'md' });
const caps = await window.convert.capabilities();
const graph = await window.convert.graph();
const pipeline = await window.convert.pipeline({ input: 'data', steps: [{ to: 'json' }] });
const status = await window.convert.status(jobId);
const validation = await window.convert.validatePlaybook(playbookData);
const diagnosis = await window.convert.diagnosePlaybook(diagData);
```
