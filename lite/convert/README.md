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
| `md-to-jupyter` | md → ipynb | pure | auto-cell (default), strict-fence, annotated |
| `md-to-text` | md → text | pure | strip (default), readable, outline |
| `text-to-md` | text → md | pure | minimal, structure (default) |
| `yaml-to-json` | yaml → json | js-yaml |  |

Every converter is `{ spec, execute(input, strategy, options) }` in
`converters/`, registered in `converters/index.ts`. Adding one is adding a
file and a line there, plus a row above and a test in
`lite/test/unit/convert-converters.test.ts`.

## Limits

Inputs above 25 MB are refused (`CONVERT_TOO_LARGE`). Everything is in-memory
text; binary formats (PDF, Office, media) are later tranches and will take
base64.

## Error catalog

| Code | Meaning | Remediation |
|---|---|---|
| `CONVERT_INVALID_INPUT` | `input` is not a string | Pass text |
| `CONVERT_TOO_LARGE` | Input over the cap | Split the content |
| `CONVERT_UNKNOWN_FORMAT` | `from` / `to` not a known format or alias | Use an id from `convert_capabilities` |
| `CONVERT_NO_PATH` | No converter chain reaches `to` from `from` | Check the reachable pairs |
| `CONVERT_UNKNOWN_STRATEGY` | Strategy not offered by the converter that runs | Use one of its strategies |
| `CONVERT_FAILED` | The converter threw on this input | Check the input really is the source format |

## Events

`convert.run.start` / `convert.run.finish` / `convert.run.fail` — one span per
`convert()` through the api (formats, pipeline, byte counts, duration). The
MCP server emits nothing; its report is the record.

## Test coverage

`convert-api.test.ts` (Rule 12 conformance + spans), `convert-registry.test.ts`
(aliases, validation, BFS), `convert-converters.test.ts` (every converter's
strategies), `convert-mcp.test.ts` (tools, schemas, error envelopes).

## Borrowed pattern

`lite/mcp/spaces-mcp.ts` for the server shape; `lib/conversion-service.js`
for the registry + pipeline resolution; each `lib/converters/<id>.js` for the
strategy semantics the port preserves.
