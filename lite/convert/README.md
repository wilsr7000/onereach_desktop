# `lite/convert/` -- File conversion, in the app and over MCP

The full Onereach app carries 67 file-conversion agents (`lib/converters/`)
behind an LLM plan / execute / evaluate loop, an HTTP surface that was never
mounted, and an IPC surface only its own windows reach. Lite ports the
deterministic converters as plain functions with the same strategies —
chosen explicitly, not by a model — and offers them to agents as an MCP
server (ADR-100).

## Usage

In the app:

```ts
import { getConvertApi } from '../convert/api.js';

const result = await getConvertApi().convert({ input: markdown, from: 'md', to: 'html', strategy: 'styled' });
result.output;      // the HTML page
result.steps;       // [{ converterId: 'md-to-html', strategy: 'styled', durationMs, stats }]
result.mimeType;    // 'text/html'
```

For Claude Code / Claude Desktop, the built server is
`dist-lite/build/convert-mcp.js` (bundled by `npm run lite:build`, no
Electron, no external modules):

```
claude mcp add onereach-convert -- node /path/to/dist-lite/build/convert-mcp.js
```

Tools: `convert_capabilities` (formats, converters, strategies, reachable
pairs — start here), `convert_pipeline` (the steps a from → to pair would
take), `convert_text` (text in, text out, optional report).

## Formats

`md` (markdown), `html` (htm), `text` (txt, plain), `csv`, `tsv`, `json`,
`yaml` (yml), `ipynb` (jupyter, notebook), `py` (python), `code`. Aliases fold
in `normalizeFormat`; a pair with no direct converter runs the shortest
pipeline through the format graph (BFS, the full app's PipelineResolver rule).

## Converters

| id | from → to | engine | strategies |
|---|---|---|---|
| `code-to-html` | code → html | highlight.js | highlight (default), themed, fragment |
| `code-to-md` | code → md | pure | fenced (default) |
| `csv-to-html` | csv, tsv → html | pure | table (default), styled, sortable |
| `csv-to-json` | csv, tsv → json | pure | auto-type (default), string-only, nested |
| `csv-to-md` | csv, tsv → md | pure | simple (default), aligned |
| `html-to-md` | html → md | turndown | turndown (default), semantic, clean |
| `html-to-text` | html → text | pure | strip, readable (default), article |
| `json-to-csv` | json → csv | pure | flat (default), top-level |
| `json-to-html` | json → html | pure | table (default), tree, pretty |
| `json-to-md` | json → md | pure | table (default), yaml-block, list |
| `json-to-yaml` | json → yaml | js-yaml |  |
| `jupyter-to-md` | ipynb → md | pure | flat (default), sectioned, with-output |
| `jupyter-to-python` | ipynb → py | pure | code-only (default), with-comments, executable |
| `md-to-html` | md → html | marked | standard, enhanced (default), styled |
| `delimited` | csv ↔ tsv | pure | requote |
| `md-to-jupyter` | md → ipynb | pure | auto-cell (default), strict-fence, annotated |
| `md-to-text` | md → text | pure | strip (default), readable, outline |
| `text-to-md` | text → md | pure | minimal, structure (default) |
| `yaml-to-json` | yaml → json | js-yaml |  |

Every converter is `{ spec, execute(input, strategy, options, context) }` in
`converters/`, registered in `converters/index.ts` (`context` names the
formats the step bridges — how `json-to-csv` knows to write tabs for a tsv
target and `code-to-md` that a `py` source is Python). Adding one is adding a
file and a line there, plus a row above and a test in
`lite/test/unit/convert-converters.test.ts`.

## Limits

Three caps, by engine (`CONVERT_TOO_LARGE` names the converter and the step):

| Cap | Converters | Why |
|---|---|---|
| 25 MB | csv/tsv, json, yaml, ipynb parsers | linear parsers; the service cap |
| 8 MB | `html-to-text`, `md-to-text` | linear tag/marker scans (`scan.ts`) |
| 2 MB | `md-to-html`, `html-to-md`, `code-to-html`, `code-to-md`, `text-to-md` | regex engines (marked, turndown, highlight.js) whose cost is not plainly linear |

Everything is in-memory text; binary formats (PDF, Office, media) are later
tranches and will take base64.

**Wall-clock budget.** The MCP server runs every conversion in a worker thread
(`worker.ts`, bundled to `convert-worker.js` beside the server, which refuses
to start without it) with a kill timer — `CONVERT_TIMEOUT_MS`, default 20 s,
1 s to 120 s — and a 512 MB heap. The timer is armed before the worker is
constructed, so handing the input to the thread counts against the budget;
the JSON-RPC parse and schema check before that are the transport's and are
not budgeted. Over budget: the worker is terminated and the caller gets
`CONVERT_TIMEOUT`; out of memory: `CONVERT_FAILED`. The server
itself never runs a conversion, so one hostile input cannot wedge it
(Amendment 1: the review did exactly that with 2 MB of `<script`, before the
scans were made linear and the worker added). Inside the app the api runs
in-process; the caps are its budget.

## Safety

- **HTML out is sanitised by default.** `md-to-html` renders raw HTML in the
  Markdown verbatim (marked has no sanitiser), so its output goes through
  `sanitize-html.ts`: an allowlist of elements and attributes, `http(s)`,
  `mailto:`, `tel:` and relative URLs only (`data:image` for images), no
  scripts, styles, frames, forms, event handlers or inline styles. The option
  `sanitize: false` keeps the raw render — for Markdown you wrote yourself,
  never for someone else's. `csv-to-html`, `json-to-html` and `code-to-html`
  escape their input. Treat any HTML made from untrusted input as untrusted.
- **Entities decode once** (`html-entities.ts`): `&amp;lt;script&amp;gt;` is
  `&lt;script&gt;`, never a live tag.
- **Linear scans** (`scan.ts`): every tag or marker pass walks the text once;
  `convert-hostile.test.ts` holds a budget for each shape the review measured.
  The case fold the scans match on is ASCII-only and length-stable
  (`asciiLower`), so an offset found in the folded copy always lands on the
  same character of the original — `toLowerCase()` grows on U+0130 and let a
  tag through behind a run of İ.
- **`code-to-html` detects on a prefix.** highlight.js's automatic detection
  runs every grammar over the input; on 64 KB it decides the language, then
  the whole input is highlighted once. At the 2 MB cap that is about a second
  inside the worker heap; the old path ran out of memory there.
- **Options** are merged over the declared defaults; prototype-shaped keys are
  dropped. Options given to a multi-step pipeline reach every step and say so
  in a warning, like a strategy does.

## Error catalog

| Code | Meaning | Remediation |
|---|---|---|
| `CONVERT_INVALID_INPUT` | `input` is not a string | Pass text |
| `CONVERT_TOO_LARGE` | Input over the cap | Split the content |
| `CONVERT_UNKNOWN_FORMAT` | `from` / `to` not a known format or alias | Use an id from `convert_capabilities` |
| `CONVERT_NO_PATH` | No converter chain reaches `to` from `from` | Check the reachable pairs |
| `CONVERT_UNKNOWN_STRATEGY` | Strategy not offered by the converter that runs | Use one of its strategies |
| `CONVERT_FAILED` | The converter threw on this input (or its worker died) | Check the input really is the source format |
| `CONVERT_TIMEOUT` | The run exceeded its wall-clock budget and was stopped | Convert a smaller excerpt, or raise `CONVERT_TIMEOUT_MS` |

## Events

`convert.run.start` / `convert.run.finish` / `convert.run.fail` — one span per
`convert()` through the api (formats, pipeline, byte counts, duration). The
MCP server emits nothing; its report is the record.

## Test coverage

`convert-api.test.ts` (Rule 12 conformance + spans), `convert-registry.test.ts`
(aliases, validation, BFS), `convert-converters*.test.ts` (every converter's
strategies), `convert-mcp.test.ts` (tools, schemas, error envelopes),
`convert-hostile.test.ts` (time budgets for hostile inputs, the sanitiser, the
caps, option safety, the honest format graph), `convert-worker.test.ts` (the
worker runner: kill timer, crash, error codes across the thread; the real
bundle end to end).

## Borrowed pattern

`lite/mcp/spaces-mcp.ts` for the server shape; `lib/conversion-service.js`
for the registry + pipeline resolution; each `lib/converters/<id>.js` for the
strategy semantics the port preserves.
