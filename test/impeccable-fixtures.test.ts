/**
 * impeccable fixture pins (commit 1 of the design-detector interop).
 *
 * gstack never runs impeccable's engine in CI. What the detector wrapper and
 * the catalog rely on is pinned here from real captures instead:
 *   - the rule registry (61 ids) at the commit the engine-v0.1.3 release shipped
 *   - the `detect --json` output shape over gstack's own planted-slop fixture,
 *     once as a source scan and once over the rendered-DOM dump that
 *     lib/dom-dump-script.ts produces through the browse engine
 *   - the dump script's own contract (IIFE, no single quotes, no `${`)
 * Re-capture protocol: test/fixtures/impeccable-captures.meta.json.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { DOM_DUMP_SCRIPT, DOM_DUMP_STYLE_ATTR, DOM_DUMP_NOTE_PREFIX, DOM_DUMP_FILE } from '../lib/dom-dump-script';

const FIXTURES = path.join(import.meta.dir, 'fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
const json = (name: string) => JSON.parse(read(name));

interface RegistryEntry { id: string; name: string; category: string; description: string }
interface Finding {
  antipattern: string; name: string; description: string; severity: string;
  category: string; file: string; line: number; snippet: string;
}

const registry = json('impeccable-antipatterns.json') as { _source: Record<string, string>; rules: RegistryEntry[] };
const sourceSample = json('impeccable-detect-sample.json') as Finding[];
const domSample = json('impeccable-detect-dom-sample.json') as Finding[];
const meta = json('impeccable-captures.meta.json');
const dump = read('review-eval-design-slop.dom.html');
const registryIds = new Set(registry.rules.map(r => r.id));
const categoryOf = new Map(registry.rules.map(r => [r.id, r.category]));

describe('impeccable rule registry fixture', () => {
  test('is the upstream file at a pinned commit', () => {
    expect(registry._source.path).toBe('crates/live/assets/antipatterns.json');
    expect(registry._source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(registry._source.engineRelease).toBe('engine-v0.1.3');
    expect(meta.registry.commit).toBe(registry._source.commit);
  });

  test('has 61 well-formed entries with unique kebab-case ids', () => {
    expect(registry.rules.length).toBe(61);
    expect(meta.registry.entries).toBe(61);
    for (const r of registry.rules) {
      expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(['slop', 'quality']).toContain(r.category);
    }
    expect(registryIds.size).toBe(61);
  });

  test('splits 32 slop / 29 quality', () => {
    const slop = registry.rules.filter(r => r.category === 'slop').length;
    expect(slop).toBe(32);
    expect(registry.rules.length - slop).toBe(29);
  });

  test('carries the ids the doctrine names', () => {
    for (const id of ['side-tab', 'overused-font', 'nested-cards', 'kicker-above-heading', 'icon-tile-stack',
      'gradient-text', 'ai-color-palette', 'cream-palette', 'dark-glow', 'pulsing-dot', 'em-dash-overuse',
      'low-contrast', 'broken-image', 'design-system-font', 'design-system-color', 'design-system-radius',
      'design-system-font-size']) {
      expect(registryIds.has(id)).toBe(true);
    }
  });
});

function checkFindings(sample: Finding[], expectedFile: string) {
  expect(Array.isArray(sample)).toBe(true);
  expect(sample.length).toBeGreaterThan(0);
  for (const f of sample) {
    expect(Object.keys(f).sort()).toEqual(meta.findingFields.slice().sort());
    expect(registryIds.has(f.antipattern)).toBe(true);
    expect(f.category).toBe(categoryOf.get(f.antipattern));
    expect(typeof f.severity).toBe('string');
    expect(typeof f.line).toBe('number');
    expect(typeof f.snippet).toBe('string');
    expect(f.file).toBe(expectedFile);
    expect(f.file.startsWith('/')).toBe(false);
  }
}

describe('detect --json source-scan sample', () => {
  test('is a real capture over the planted-slop fixture, paths normalized', () => {
    checkFindings(sourceSample, 'test/fixtures/review-eval-design-slop.html');
    expect(meta.captures['impeccable-detect-sample.json'].exit).toBe(2);
  });

  test('contains a deterministic slop id and a quality id', () => {
    const ids = new Set(sourceSample.map(f => f.antipattern));
    expect(ids.has('ai-color-palette')).toBe(true);
    expect(ids.has('low-contrast')).toBe(true);
  });
});

describe('detect --json DOM-dump sample', () => {
  test('is a real capture over the committed dump, paths normalized', () => {
    checkFindings(domSample, 'test/fixtures/review-eval-design-slop.dom.html');
    expect(meta.captures['impeccable-detect-dom-sample.json'].exit).toBe(2);
    expect(meta.captures['impeccable-detect-dom-sample.json'].stderrBytes).toBe(0);
  });

  test('the static engine reads inlined <style>: same id set as the source scan', () => {
    const src = [...new Set(sourceSample.map(f => f.antipattern))].sort();
    const dom = [...new Set(domSample.map(f => f.antipattern))].sort();
    expect(dom).toEqual(src);
  });
});

describe('committed DOM dump', () => {
  test('came from the dump script: inlined-style marker, trailing note, no leftover stylesheet link', () => {
    expect(dump.startsWith('<!DOCTYPE html>\n')).toBe(true);
    expect(dump).toContain(`<style ${DOM_DUMP_STYLE_ATTR}=""`);
    expect(dump).toContain(`<!-- ${DOM_DUMP_NOTE_PREFIX} `);
    expect(dump).not.toMatch(/<link[^>]*rel="?stylesheet/);
  });

  test('folds CSSOM rgb() back to the author hex so palette rules still fire', () => {
    expect(dump).toContain('#6366f1');
    expect(dump).not.toMatch(/rgb\(\d+, \d+, \d+\)/);
  });

  test('carries no capture-time port or temp path', () => {
    expect(dump).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(dump).not.toContain('/tmp/');
  });
});

describe('DOM_DUMP_SCRIPT contract', () => {
  test('is an expression that fits inside a single-quoted bash string and a template literal', () => {
    expect(DOM_DUMP_SCRIPT).not.toContain("'");
    expect(DOM_DUMP_SCRIPT).not.toContain('${');
    expect(DOM_DUMP_SCRIPT).not.toContain('`');
    // An arrow FUNCTION, not a self-calling IIFE: Aside's pg.evaluate(fn) runs it in
    // the page; the fallback engine calls it with `$B js '('"$_DUMP"')()'`.
    expect(DOM_DUMP_SCRIPT.trim().startsWith('() => {')).toBe(true);
    expect(DOM_DUMP_SCRIPT.trim().endsWith('}')).toBe(true);
    expect(() => new Function('return ' + DOM_DUMP_SCRIPT)).not.toThrow();
    expect(typeof new Function('return ' + DOM_DUMP_SCRIPT)()).toBe('function');
  });

  test('works on a clone and applies the hygiene rules', () => {
    expect(DOM_DUMP_SCRIPT).toContain('document.documentElement.cloneNode(true)');
    expect(DOM_DUMP_SCRIPT).toContain('"srcset"');
    expect(DOM_DUMP_SCRIPT).toContain('"formaction"');
    expect(DOM_DUMP_SCRIPT).toContain(DOM_DUMP_STYLE_ATTR);
    expect(DOM_DUMP_SCRIPT).toContain(DOM_DUMP_NOTE_PREFIX);
    for (const rule of ['querySelectorAll("script")', 'querySelectorAll("textarea")', 'value.length > 32',
      'name === "content" && el.nodeName === "META"', 'cutQuery(value)', 'value.length > 1024',
      'gstack-stripped', 'cloneLinks[i].remove()', 'querySelectorAll("style")', 'querySelectorAll("template, noscript")', 'name.indexOf("on") === 0', 'name === "srcdoc"', 'cleanCss(value)', '"xlink:href"']) {
      expect(DOM_DUMP_SCRIPT).toContain(rule);
    }
  });

  test('committed lib/dom-dump.js is the script byte-for-byte (gen-skill-docs writes it)', () => {
    expect(DOM_DUMP_FILE).toBe('lib/dom-dump.js');
    const committed = fs.readFileSync(path.join(import.meta.dir, '..', DOM_DUMP_FILE), 'utf-8');
    expect(committed).toBe(DOM_DUMP_SCRIPT + '\n');
    expect(() => new Function('return ' + committed)).not.toThrow();
  });

  test('lib module is pure: no I/O, no scripts/ imports', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'dom-dump-script.ts'), 'utf-8');
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/from ['"]\.\.\/scripts/);
  });
});

describe('detect --help fixture', () => {
  test('pins the flags and exit codes the wrapper relies on', () => {
    const help = read('impeccable-detect-help.txt');
    expect(help).toContain('--json');
    expect(help).toContain('--no-config');
    expect(help).toMatch(/0\s+Scan completed with no primary findings/);
    expect(help).toMatch(/1\s+At least one requested target could not be scanned/);
    expect(help).toMatch(/2\s+Scan completed with primary findings/);
    expect(help).toContain('impeccable-disable');
  });
});
