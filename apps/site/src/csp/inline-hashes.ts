import { createHash } from 'node:crypto';

export interface UncoveredScript {
  hash: string;
  snippet: string;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const META = /<meta\b[^>]*>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const EXECUTABLE_TYPES = ['', 'module', 'text/javascript', 'application/javascript'];
const SNIPPET_LENGTH = 80;

/** Attribute name (lower case) to value. */
function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name = '', double, single, bare] of tag.matchAll(ATTRIBUTE)) {
    found.set(name.toLowerCase(), double ?? single ?? bare ?? '');
  }
  return found;
}

/** The exact text of every executable inline `<script>` of a page, in document order. */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  for (const [, tag = '', text = ''] of html.matchAll(SCRIPT)) {
    const attrs = attributes(tag);
    const type = (attrs.get('type') ?? '').trim().toLowerCase();
    if (!attrs.has('src') && EXECUTABLE_TYPES.includes(type)) scripts.push(text);
  }
  return scripts;
}

/** `sha256-` + base64 SHA-256 of the UTF-8 bytes. */
export function scriptHash(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`;
}

/** The text with whitespace runs collapsed, cut to a line a person can scan. */
export function snippetOf(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

/** The `sha256-` sources of the `script-src` directive of the page's meta CSP. */
export function metaScriptHashes(html: string): string[] {
  for (const [tag = ''] of html.matchAll(META)) {
    const attrs = attributes(tag);
    if (attrs.get('http-equiv')?.toLowerCase() !== 'content-security-policy') continue;
    const policy = (attrs.get('content') ?? '')
      .replaceAll('&#39;', "'")
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&');
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() !== 'script-src') continue;
      return sources.flatMap((source) => /^'(sha256-[^']+)'$/.exec(source)?.[1] ?? []);
    }
    return [];
  }
  return [];
}

/** The hashes the pinned list must hold so that every inline script of every page is allowed. */
export function requiredExtraHashes(
  pages: readonly string[],
  configured: readonly string[],
): string[] {
  const required = new Set<string>();
  for (const html of pages) {
    const own = new Set(metaScriptHashes(html).filter((hash) => !configured.includes(hash)));
    for (const script of inlineScripts(html)) {
      const hash = scriptHash(script);
      if (!own.has(hash)) required.add(hash);
    }
  }
  return [...required].sort();
}

/** Inline scripts whose hash is not in the page's meta `script-src`. */
export function uncoveredScripts(html: string): UncoveredScript[] {
  const allowed = new Set(metaScriptHashes(html));
  return inlineScripts(html)
    .map((script) => ({ hash: scriptHash(script), snippet: snippetOf(script) }))
    .filter(({ hash }) => !allowed.has(hash));
}
