/**
 * Ambient declarations for conversion libraries that ship no types.
 * Only the surface the converters use; extend when a port needs more.
 */

declare module 'turndown' {
  interface TurndownOptions {
    headingStyle?: 'setext' | 'atx';
    hr?: string;
    bulletListMarker?: '-' | '+' | '*';
    codeBlockStyle?: 'indented' | 'fenced';
    fence?: '```' | '~~~';
    emDelimiter?: '_' | '*';
    strongDelimiter?: '__' | '**';
    linkStyle?: 'inlined' | 'referenced';
    linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut';
    preformattedCode?: boolean;
  }
  interface TurndownRule {
    filter: string | string[] | ((node: Node, options: TurndownOptions) => boolean);
    replacement: (content: string, node: Node, options: TurndownOptions) => string;
  }
  class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string): string;
    addRule(key: string, rule: TurndownRule): this;
    keep(filter: string | string[]): this;
    remove(filter: string | string[]): this;
    use(plugin: (service: TurndownService) => void): this;
  }
  export = TurndownService;
}

declare module 'js-yaml' {
  interface DumpOptions {
    indent?: number;
    noArrayIndent?: boolean;
    skipInvalid?: boolean;
    flowLevel?: number;
    sortKeys?: boolean;
    lineWidth?: number;
    noRefs?: boolean;
    noCompatMode?: boolean;
    forceQuotes?: boolean;
    quotingType?: '"' | "'";
  }
  interface LoadOptions {
    filename?: string;
    json?: boolean;
  }
  export function load(str: string, opts?: LoadOptions): unknown;
  export function loadAll(str: string, iterator?: (doc: unknown) => void, opts?: LoadOptions): unknown[];
  export function dump(obj: unknown, opts?: DumpOptions): string;
  export class YAMLException extends Error {}
}
