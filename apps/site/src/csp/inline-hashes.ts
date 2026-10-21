// Interface stub of spec 034, section 3: the implementation comes after the tests.

export interface UncoveredScript {
  hash: string;
  snippet: string;
}

/** The exact text of every executable inline `<script>` of a page, in document order. */
export function inlineScripts(html: string): string[] {
  void html;
  throw new Error('not implemented');
}

/** `sha256-` + base64 SHA-256 of the UTF-8 bytes. */
export function scriptHash(content: string): string {
  void content;
  throw new Error('not implemented');
}

/** The `sha256-` sources of the `script-src` directive of the page's meta CSP. */
export function metaScriptHashes(html: string): string[] {
  void html;
  throw new Error('not implemented');
}

/** The hashes the pinned list must hold so that every inline script of every page is allowed. */
export function requiredExtraHashes(
  pages: readonly string[],
  configured: readonly string[],
): string[] {
  void pages;
  void configured;
  throw new Error('not implemented');
}

/** Inline scripts whose hash is not in the page's meta `script-src`. */
export function uncoveredScripts(html: string): UncoveredScript[] {
  void html;
  throw new Error('not implemented');
}
