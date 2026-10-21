import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  inlineScripts,
  metaScriptHashes,
  requiredExtraHashes,
  scriptHash,
  uncoveredScripts,
} from './inline-hashes.ts';

// Spec 034, section 3: the pure functions behind `pnpm csp-hashes` and the e2e drift check.

/** Independent oracle for fixtures: sha256 of the UTF-8 bytes, base64, with the CSP prefix. */
function hashOf(content: string): string {
  return `sha256-${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('base64')}`;
}

/** The meta CSP tag as Astro writes it, from a map of directive -> sources. */
function metaTag(
  directives: Record<string, string[]>,
  attrs = 'http-equiv="content-security-policy"',
) {
  const content = Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
  return `<meta ${attrs} content="${content}">`;
}

/** A page with a meta CSP holding `hashes` in script-src, and the given scripts as inline scripts. */
function page(scripts: string[], metaHashes: string[] = []): string {
  const meta = metaTag({
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...metaHashes.map((hash) => `'${hash}'`)],
    'style-src': ["'self'", "'unsafe-inline'"],
  });
  const body = scripts.map((script) => `<script>${script}</script>`).join('\n');
  return `<!doctype html><html><head>${meta}</head><body>${body}</body></html>`;
}

describe('inlineScripts', () => {
  test('AC-7: returns the text of a script with no type attribute', () => {
    expect(inlineScripts('<html><body><script>alert(1)</script></body></html>')).toEqual([
      'alert(1)',
    ]);
  });

  test.each([
    ['type=""', '<script type="">a()</script>'],
    ['type="module"', '<script type="module">a()</script>'],
    ['type="text/javascript"', '<script type="text/javascript">a()</script>'],
    ['type="application/javascript"', '<script type="application/javascript">a()</script>'],
    ['an upper-case TYPE attribute name', '<script TYPE="module">a()</script>'],
    ['a mixed-case type value', '<script type="Text/JavaScript">a()</script>'],
    ['an upper-case MODULE value', '<script type="MODULE">a()</script>'],
    ['single quotes', "<script type='module'>a()</script>"],
    ['no quotes', '<script type=module>a()</script>'],
    ['no quotes and other attributes', '<script async type=text/javascript defer>a()</script>'],
    ['other attributes', '<script id="x" data-a="b">a()</script>'],
  ])('AC-7: returns the text of an executable script with %s', (_name, html) => {
    expect(inlineScripts(html)).toEqual(['a()']);
  });

  test('AC-7: handles upper-case <SCRIPT> tags', () => {
    expect(inlineScripts('<SCRIPT>a()</SCRIPT><Script>b()</Script>')).toEqual(['a()', 'b()']);
  });

  test.each([
    ['double quotes', '<script src="/a.js"></script>'],
    ['single quotes', "<script src='/a.js'></script>"],
    ['no quotes', '<script src=/a.js></script>'],
    ['an upper-case SRC', '<script SRC="/a.js"></script>'],
    ['src first among other attributes', '<script src="/a.js" type="module" async></script>'],
    ['src last among other attributes', '<script type="module" async defer src="/a.js"></script>'],
    ['src in the middle', '<script async src="/a.js" defer></script>'],
    ['src and a body', '<script src="/a.js">ignored()</script>'],
  ])('AC-7: skips a script with a src attribute (%s)', (_name, html) => {
    expect(inlineScripts(html)).toEqual([]);
  });

  test('AC-7: a data-src attribute is not a src attribute', () => {
    expect(inlineScripts('<script data-src="/a.js">a()</script>')).toEqual(['a()']);
  });

  test.each([
    ['application/json', '<script type="application/json">{"a":1}</script>'],
    ['application/ld+json', '<script type="application/ld+json">{"@context":"x"}</script>'],
    ['uppercase application/JSON', '<script type="APPLICATION/JSON">{}</script>'],
    ['text/template', '<script type="text/template"><div></div></script>'],
  ])('AC-7: skips a script of type %s', (_name, html) => {
    expect(inlineScripts(html)).toEqual([]);
  });

  test('AC-7: keeps the text exact, with leading and trailing whitespace and newlines', () => {
    const text = '\n  const a = 1;\n\tdoIt(a);\n  ';

    expect(inlineScripts(`<script>${text}</script>`)).toEqual([text]);
  });

  test('AC-7: keeps "<" and quotes inside the script text', () => {
    const text = `if (a<b && "</div>" !== '<p>') { run(); }`;

    expect(inlineScripts(`<script type="module">${text}</script>`)).toEqual([text]);
  });

  test('AC-7: an empty inline script gives an empty text', () => {
    expect(inlineScripts('<script></script>')).toEqual(['']);
  });

  test('AC-7: returns every inline script in document order, mixing the skipped kinds', () => {
    const html = [
      '<head>',
      '<script>first()</script>',
      '<script src="/skip.js"></script>',
      '<script type="application/ld+json">{}</script>',
      '<script type="module">second()</script>',
      '</head><body>',
      '<script>third()</script>',
      '</body>',
    ].join('\n');

    expect(inlineScripts(html)).toEqual(['first()', 'second()', 'third()']);
  });

  test('AC-7: a page without scripts gives []', () => {
    expect(inlineScripts('<html><body><p>No scripts</p></body></html>')).toEqual([]);
  });
});

describe('scriptHash', () => {
  test('AC-8: the hash of the empty script', () => {
    expect(scriptHash('')).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  test('AC-8: the hash of alert(1)', () => {
    expect(scriptHash('alert(1)')).toBe('sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=');
  });

  test('AC-8: a non-ASCII script is hashed over its UTF-8 bytes', () => {
    // 'é' is the two bytes C3 A9 in UTF-8 (a Latin-1 hash would be sha256-3i4zHYka4menAJy0...).
    expect(scriptHash('é')).toBe('sha256-SplVfkAzw1Od4utlRyAXytX5VX96BiWgnxw/biumnEw=');
  });

  test('AC-8: whitespace is part of the hashed content', () => {
    expect(scriptHash(' alert(1)\n')).not.toBe(scriptHash('alert(1)'));
    expect(scriptHash(' alert(1)\n')).toBe(hashOf(' alert(1)\n'));
  });
});

describe('metaScriptHashes', () => {
  const A = hashOf('a');
  const B = hashOf('b');
  const C = hashOf('c');

  function sorted(values: string[]): string[] {
    return [...values].sort();
  }

  test('AC-9: returns the sha256 sources of the script-src directive', () => {
    const html = `<head>${metaTag({
      'script-src': ["'self'", "'wasm-unsafe-eval'", `'${A}'`, `'${B}'`],
    })}</head>`;

    expect(sorted(metaScriptHashes(html))).toEqual(sorted([A, B]));
  });

  test('AC-9: returns the hashes without the quotes around them', () => {
    const html = `<head>${metaTag({ 'script-src': [`'${A}'`] })}</head>`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test('AC-9: ignores the hashes of style-src, default-src and other directives', () => {
    const html = `<head>${metaTag({
      'default-src': [`'${C}'`],
      'script-src': ["'self'", `'${A}'`],
      'style-src': ["'self'", `'${B}'`],
      'img-src': ['data:'],
    })}</head>`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test('AC-9: script-src-elem is not the script-src directive', () => {
    const html = `<head>${metaTag({
      'script-src-elem': [`'${B}'`],
      'script-src': [`'${A}'`],
    })}</head>`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test('AC-9: does not return sha384 or sha512 sources', () => {
    const html = `<head>${metaTag({
      'script-src': [`'${A}'`, `'sha384-${'B'.repeat(64)}'`, `'sha512-${'C'.repeat(86)}=='`],
    })}</head>`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test('AC-9: decodes &#39; around the sources', () => {
    const html = `<meta http-equiv="content-security-policy" content="script-src &#39;self&#39; &#39;${A}&#39; &#39;${B}&#39;; style-src &#39;self&#39;">`;

    expect(sorted(metaScriptHashes(html))).toEqual(sorted([A, B]));
  });

  test('AC-9: decodes &quot; and &amp; in the content without losing the script-src hashes', () => {
    const html = `<meta http-equiv="content-security-policy" content="connect-src https://x.test/?a=1&amp;b=2 &quot;q&quot;; script-src &#39;${A}&#39;; img-src &amp;">`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test.each([
    ['upper-case attribute name and value', 'HTTP-EQUIV="CONTENT-SECURITY-POLICY"'],
    ['mixed case', 'Http-Equiv="Content-Security-Policy"'],
    ['single quotes', "http-equiv='content-security-policy'"],
  ])('AC-9: matches http-equiv in any case (%s)', (_name, attrs) => {
    const html = `<head>${metaTag({ 'script-src': [`'${A}'`] }, attrs)}</head>`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test('AC-9: finds the meta when content comes before http-equiv', () => {
    const html = `<meta content="script-src 'self' '${A}'" http-equiv="content-security-policy">`;

    expect(metaScriptHashes(html)).toEqual([A]);
  });

  test('AC-9: returns [] for a page with no meta CSP', () => {
    expect(metaScriptHashes('<html><head><title>x</title></head><body></body></html>')).toEqual([]);
  });

  test('AC-9: returns [] for a meta CSP without script-src', () => {
    const html = `<head>${metaTag({ 'style-src': ["'self'", `'${A}'`], 'img-src': ['data:'] })}</head>`;

    expect(metaScriptHashes(html)).toEqual([]);
  });

  test('AC-9: ignores a meta with another http-equiv', () => {
    const html = `<head><meta http-equiv="refresh" content="script-src '${A}'"></head>`;

    expect(metaScriptHashes(html)).toEqual([]);
  });
});

describe('requiredExtraHashes', () => {
  const STARLIGHT = 'window.starlight = true;';
  const STARLIGHT_HASH = hashOf(STARLIGHT);
  const ASTRO = 'import("/_astro/island.js");';
  const ASTRO_HASH = hashOf(ASTRO);

  test('AC-10: a page whose inline script is hashed by Astro needs nothing', () => {
    const html = page([ASTRO], [ASTRO_HASH]);

    expect(requiredExtraHashes([html], [])).toEqual([]);
  });

  test('AC-10: an inline script that is not in the meta is required', () => {
    const html = page([STARLIGHT, ASTRO], [ASTRO_HASH]);

    expect(requiredExtraHashes([html], [])).toEqual([STARLIGHT_HASH]);
  });

  test('AC-10: a page with no meta CSP requires all its inline scripts', () => {
    const html = `<html><body><script>${STARLIGHT}</script></body></html>`;

    expect(requiredExtraHashes([html], [])).toEqual([STARLIGHT_HASH]);
  });

  test('AC-10: a configured hash that is in the meta and matches an inline script stays required', () => {
    const html = page([STARLIGHT, ASTRO], [ASTRO_HASH, STARLIGHT_HASH]);

    expect(requiredExtraHashes([html], [STARLIGHT_HASH])).toEqual([STARLIGHT_HASH]);
  });

  test('AC-10: a configured hash that no page needs is dropped', () => {
    const stale = hashOf('removed from starlight();');
    const html = page([ASTRO], [ASTRO_HASH, stale]);

    expect(requiredExtraHashes([html], [stale])).toEqual([]);
  });

  test('AC-10: stale configured hashes are dropped while the needed ones stay', () => {
    const stale = hashOf('removed from starlight();');
    const html = page([STARLIGHT, ASTRO], [ASTRO_HASH, STARLIGHT_HASH, stale]);

    expect(requiredExtraHashes([html], [STARLIGHT_HASH, stale].sort())).toEqual([STARLIGHT_HASH]);
  });

  test('AC-10: the result is the union over the pages, sorted ascending and without duplicates', () => {
    const scripts = ['one();', 'two();', 'three();', 'four();'];
    const hashes = scripts.map(hashOf);
    const descending = [...hashes].sort().reverse();
    const byHash = new Map(hashes.map((hash, index) => [hash, scripts[index] ?? '']));
    const script = (hash: string): string => byHash.get(hash) ?? '';
    const pageOne = page([script(descending[0] ?? ''), script(descending[1] ?? '')]);
    const pageTwo = page([
      script(descending[1] ?? ''),
      script(descending[2] ?? ''),
      script(descending[3] ?? ''),
    ]);
    const pageThree = page([script(descending[0] ?? '')]);

    const result = requiredExtraHashes([pageOne, pageTwo, pageThree], []);

    expect(result).toEqual([...hashes].sort());
  });

  test("AC-10: Astro's hashes are computed per page", () => {
    // Page one hashes ASTRO itself; page two has the same script but no hash for it.
    const hashedByAstro = page([ASTRO], [ASTRO_HASH]);
    const notHashed = page([ASTRO]);

    expect(requiredExtraHashes([hashedByAstro, notHashed], [])).toEqual([ASTRO_HASH]);
  });

  test('AC-10: scripts that are not executable are not required', () => {
    const html = `<html><head>${metaTag({ 'script-src': ["'self'"] })}</head><body>
<script type="application/ld+json">{"a":1}</script><script src="/x.js"></script></body></html>`;

    expect(requiredExtraHashes([html], [])).toEqual([]);
  });

  test('AC-10: no pages gives []', () => {
    expect(requiredExtraHashes([], [])).toEqual([]);
  });

  test('AC-10: pages without inline scripts give []', () => {
    expect(requiredExtraHashes([page([]), page([])], [STARLIGHT_HASH])).toEqual([]);
  });
});

describe('uncoveredScripts', () => {
  test('AC-11: returns the hash and snippet of an inline script that is not in the meta', () => {
    const html = page(['alert(1)'], []);

    expect(uncoveredScripts(html)).toEqual([
      { hash: 'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=', snippet: 'alert(1)' },
    ]);
  });

  test('AC-11: returns [] when every inline script is in the meta', () => {
    const html = page(['alert(1)', 'run();'], [hashOf('alert(1)'), hashOf('run();')]);

    expect(uncoveredScripts(html)).toEqual([]);
  });

  test('AC-11: returns only the scripts that are not covered, in document order', () => {
    const html = page(['first();', 'covered();', 'third();'], [hashOf('covered();')]);

    expect(uncoveredScripts(html)).toEqual([
      { hash: hashOf('first();'), snippet: 'first();' },
      { hash: hashOf('third();'), snippet: 'third();' },
    ]);
  });

  test('AC-11: a hash in style-src does not cover a script', () => {
    const html = `<head>${metaTag({
      'script-src': ["'self'"],
      'style-src': [`'${hashOf('alert(1)')}'`],
    })}</head><body><script>alert(1)</script></body>`;

    expect(uncoveredScripts(html)).toHaveLength(1);
  });

  test('AC-11: without a meta CSP every inline script is uncovered', () => {
    const html = '<html><body><script>a();</script><script>b();</script></body></html>';

    expect(uncoveredScripts(html).map((script) => script.snippet)).toEqual(['a();', 'b();']);
  });

  test('AC-11: scripts with a src or a data type are never reported', () => {
    const html = `<head>${metaTag({ 'script-src': ["'self'"] })}</head><body>
<script src="/a.js"></script><script type="application/json">{}</script></body>`;

    expect(uncoveredScripts(html)).toEqual([]);
  });

  test('AC-11: whitespace runs in the snippet are collapsed to one space', () => {
    const text = 'const a =\n    1;\n\n\tdoIt(a);';

    const [found] = uncoveredScripts(page([text]));

    expect(found?.snippet).toBe('const a = 1; doIt(a);');
    expect(found?.hash).toBe(hashOf(text));
  });

  test('AC-11: the snippet is at most 80 characters', () => {
    const text = `window.longScript = "${'x'.repeat(200)}";`;

    const [found] = uncoveredScripts(page([text]));

    expect(found?.snippet).toBe(text.slice(0, 80));
    expect(found?.hash).toBe(hashOf(text));
  });

  test('AC-11: a long script with whitespace runs gives a snippet of at most 80 characters', () => {
    const text = Array.from({ length: 60 }, (_, index) => `word${String(index)}`).join('\n   ');

    const [found] = uncoveredScripts(page([text]));

    expect((found?.snippet ?? '').length).toBeGreaterThan(0);
    expect((found?.snippet ?? '').length).toBeLessThanOrEqual(80);
    expect(found?.snippet).not.toMatch(/\s{2}|[\r\n\t]/);
    expect(text.replace(/\s+/g, ' ').startsWith(found?.snippet.trimEnd() ?? '!')).toBe(true);
  });
});

// Review round 1 (AC-28): the snippet collapses whitespace and trims FIRST, then cuts to 80 characters.
// Cutting first and collapsing afterwards gives a different snippet for both scripts below.
describe('uncoveredScripts snippet order', () => {
  test('AC-28: whitespace is collapsed before the cut (a + 100 spaces + 100 b)', () => {
    const text = `a${' '.repeat(100)}${'b'.repeat(100)}`;

    const [found] = uncoveredScripts(page([text]));

    expect(found?.snippet).toBe(`a ${'b'.repeat(78)}`);
    expect(found?.hash).toBe(hashOf(text));
  });

  test('AC-28: the text is trimmed before the cut (leading spaces + x + 70 spaces + y + 20 z)', () => {
    const text = `  x${' '.repeat(70)}y${'z'.repeat(20)}`;

    const [found] = uncoveredScripts(page([text]));

    expect(found?.snippet).toBe(`x y${'z'.repeat(20)}`);
    expect(found?.hash).toBe(hashOf(text));
  });
});

// PR #90 CodeQL js/bad-tag-filter (AC-33): a script ends where a browser ends it, at `</script`
// (any case) followed by whitespace, `/` or `>` and then anything up to the next `>`.
describe('inlineScripts closing tag', () => {
  test('AC-33: a closing tag with whitespace (tab, newline, space) and an attribute-like tail ends the script', () => {
    expect(inlineScripts('<script>a()</script\t\n bar>')).toEqual(['a()']);
  });

  test('AC-33: an upper-case closing tag with an attribute ends the script', () => {
    expect(inlineScripts('<script>b()</SCRIPT foo="x">')).toEqual(['b()']);
  });

  test('AC-33: a self-closing style closing tag (</script/>) ends the script', () => {
    expect(inlineScripts('<script>c()</script/>')).toEqual(['c()']);
  });

  test('AC-33: two scripts closed that way stay two entries', () => {
    const html = '<script>a()</script\t\n bar><p>x</p><script>b()</SCRIPT foo="x">';

    expect(inlineScripts(html)).toEqual(['a()', 'b()']);
  });

  test('AC-33: two scripts, one closed with an attribute tail and one with a slash, stay two entries', () => {
    expect(inlineScripts('<script>a()</script foo="x"><script>c()</script/>')).toEqual([
      'a()',
      'c()',
    ]);
  });

  test('AC-33: </scripts> does not end a script', () => {
    expect(inlineScripts('<script>d()</scripts>e()</script>')).toEqual(['d()</scripts>e()']);
  });
});
