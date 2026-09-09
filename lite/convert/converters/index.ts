/**
 * The converters Lite ships (ADR-100), registered in one place. Order
 * matters only for the BFS tie-break when two converters cover the same
 * pair — the first registered wins.
 */

import { ConverterRegistry } from '../registry.js';
import type { Converter } from '../types.js';
import { csvToJson } from './csv-to-json.js';
import { jsonToCsv } from './json-to-csv.js';
import { csvToMd } from './csv-to-md.js';
import { csvToHtml } from './csv-to-html.js';
import { jsonToMd } from './json-to-md.js';
import { jsonToHtml } from './json-to-html.js';
import { jsonToYaml, yamlToJson } from './json-yaml.js';
import { mdToHtml } from './md-to-html.js';
import { htmlToMd } from './html-to-md.js';
import { htmlToText } from './html-to-text.js';
import { mdToText } from './md-to-text.js';
import { textToMd } from './text-to-md.js';
import { jupyterToMd } from './jupyter-to-md.js';
import { jupyterToPython } from './jupyter-to-python.js';
import { mdToJupyter } from './md-to-jupyter.js';
import { codeToHtml } from './code-to-html.js';
import { codeToMd } from './code-to-md.js';

export const CONVERTERS: readonly Converter[] = [
  // data
  csvToJson,
  jsonToCsv,
  csvToMd,
  csvToHtml,
  jsonToMd,
  jsonToHtml,
  jsonToYaml,
  yamlToJson,
  // documents
  mdToHtml,
  htmlToMd,
  htmlToText,
  mdToText,
  textToMd,
  // notebooks + code
  jupyterToMd,
  jupyterToPython,
  mdToJupyter,
  codeToHtml,
  codeToMd,
];

export function createDefaultRegistry(): ConverterRegistry {
  const registry = new ConverterRegistry();
  for (const c of CONVERTERS) registry.register(c);
  return registry;
}
