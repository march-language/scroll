// test/js/scroll-utils.test.js
// Unit tests for pure helpers extracted from assets/js/scroll.js.
//
// Run with:  npm test
//            npx vitest run test/js/scroll-utils.test.js

import { describe, test, expect } from 'vitest';
import { isPotentiallyLongRunning, detectOutputType, parseFencedOutput, renderBlobHtml } from '../../assets/js/scroll-utils.js';

// ── isPotentiallyLongRunning ──────────────────────────────────────────────────

describe('isPotentiallyLongRunning', () => {
  test('returns false for a plain arithmetic expression', () => {
    expect(isPotentiallyLongRunning('1 + 1')).toBe(false);
  });

  test('returns true for Http.get', () => {
    expect(isPotentiallyLongRunning('Http.get("https://example.com")')).toBe(true);
  });

  test('returns true for HttpClient usage', () => {
    expect(isPotentiallyLongRunning('HttpClient.new() |> HttpClient.request("GET", url)')).toBe(true);
  });

  test('returns true for Task.async', () => {
    expect(isPotentiallyLongRunning('let t = Task.async(fn -> work())')).toBe(true);
  });

  test('returns true for System.sleep', () => {
    expect(isPotentiallyLongRunning('System.sleep(1000)')).toBe(true);
  });

  test('returns true for File.read', () => {
    expect(isPotentiallyLongRunning('File.read("/etc/passwd")')).toBe(true);
  });

  test('returns true for recursive function (self-call pattern)', () => {
    // fn go(...) ... go(...) — calls itself
    const src = 'fn go(n) do\n  if n == 0 do 0\n  else go(n - 1)\n  end\nend';
    expect(isPotentiallyLongRunning(src)).toBe(true);
  });

  test('returns false for a simple let-binding block', () => {
    expect(isPotentiallyLongRunning('let x = 42\nlet y = x * 2\nprintln(y)')).toBe(false);
  });

  test('returns false for fn definition whose name does not appear in its body', () => {
    // A function whose name ("double") does not appear inside its own body.
    // Note: if the name appears anywhere after the fn keyword (e.g. a later
    // call site), the heuristic conservatively returns true — that is
    // acceptable because the badge is informational and not blocking.
    expect(isPotentiallyLongRunning('fn double(n) do n * 2 end')).toBe(false);
  });
});

// ── detectOutputType ──────────────────────────────────────────────────────────

describe('detectOutputType', () => {
  test('detects Vega-Lite JSON by $schema', () => {
    const spec = JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', mark: 'bar' });
    expect(detectOutputType(spec)).toBe('vega');
  });

  test('detects SVG output', () => {
    expect(detectOutputType('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe('html');
  });

  test('detects HTML table', () => {
    expect(detectOutputType('<table><tr><td>a</td></tr></table>')).toBe('html');
  });

  test('detects DOCTYPE html', () => {
    expect(detectOutputType('<!DOCTYPE html><html></html>')).toBe('html');
  });

  test('detects fenced code block output (Stage 1.3)', () => {
    expect(detectOutputType('```json\n{"a": 1}\n```')).toBe('fenced');
  });

  test('detects fenced block with leading whitespace trimmed', () => {
    expect(detectOutputType('  ```python\nprint("hi")\n```')).toBe('fenced');
  });

  test('plain text returns text', () => {
    expect(detectOutputType('hello world')).toBe('text');
  });

  test('empty string returns text', () => {
    expect(detectOutputType('')).toBe('text');
  });

  test('JSON without vega schema returns text', () => {
    expect(detectOutputType('{"a": 1}')).toBe('text');
  });
});

// ── parseFencedOutput ─────────────────────────────────────────────────────────
// parseFencedOutput(text) → { lang, body } | null

describe('parseFencedOutput', () => {
  test('parses a simple fenced block', () => {
    const result = parseFencedOutput('```json\n{"a": 1}\n```');
    expect(result).toEqual({ lang: 'json', body: '{"a": 1}' });
  });

  test('parses fenced block with no lang tag', () => {
    const result = parseFencedOutput('```\nhello\n```');
    expect(result).toEqual({ lang: '', body: 'hello' });
  });

  test('parses multi-line body', () => {
    const result = parseFencedOutput('```python\nline1\nline2\nline3\n```');
    expect(result).toEqual({ lang: 'python', body: 'line1\nline2\nline3' });
  });

  test('trims leading whitespace before the fence', () => {
    const result = parseFencedOutput('  ```sql\nSELECT 1\n```');
    expect(result).toEqual({ lang: 'sql', body: 'SELECT 1' });
  });

  test('returns null for plain text', () => {
    expect(parseFencedOutput('hello')).toBeNull();
  });

  test('returns null for HTML output', () => {
    expect(parseFencedOutput('<div>hi</div>')).toBeNull();
  });

  test('returns null for unclosed fence', () => {
    expect(parseFencedOutput('```json\n{"a": 1}')).toBeNull();
  });

  test('handles empty body', () => {
    const result = parseFencedOutput('```text\n```');
    expect(result).toEqual({ lang: 'text', body: '' });
  });

  test('handles 4-backtick fence (produced by ScrollCode.fenced for embedded backticks)', () => {
    const result = parseFencedOutput('````md\nbefore\n```\nafter\n````');
    expect(result).toEqual({ lang: 'md', body: 'before\n```\nafter' });
  });
});

// ── renderBlobHtml ────────────────────────────────────────────────────────────

describe('renderBlobHtml', () => {
  test('renders image/png as <img> tag', () => {
    const html = renderBlobHtml({ mime: 'image/png', data: 'aGVsbG8=' });
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,aGVsbG8=');
    expect(html).toContain('blob-image');
  });

  test('renders image/jpeg as <img> tag', () => {
    const html = renderBlobHtml({ mime: 'image/jpeg', data: 'anBnZWc=' });
    expect(html).toContain('<img');
    expect(html).toContain('data:image/jpeg;base64,');
  });

  test('renders image/svg+xml as <img> tag', () => {
    const html = renderBlobHtml({ mime: 'image/svg+xml', data: 'dGVzdA==' });
    expect(html).toContain('<img');
    expect(html).toContain('data:image/svg+xml;base64,');
  });

  test('renders audio/wav as <audio controls>', () => {
    const html = renderBlobHtml({ mime: 'audio/wav', data: 'd2F2ZQ==' });
    expect(html).toContain('<audio');
    expect(html).toContain('controls');
    expect(html).toContain('data:audio/wav;base64,');
    expect(html).toContain('blob-audio');
  });

  test('renders audio/mpeg as <audio controls>', () => {
    const html = renderBlobHtml({ mime: 'audio/mpeg', data: 'bXAz' });
    expect(html).toContain('<audio');
    expect(html).toContain('controls');
  });

  test('renders video/mp4 as <video controls>', () => {
    const html = renderBlobHtml({ mime: 'video/mp4', data: 'bXA0' });
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('data:video/mp4;base64,');
    expect(html).toContain('blob-video');
  });

  test('renders application/pdf as <embed>', () => {
    const html = renderBlobHtml({ mime: 'application/pdf', data: 'cGRm' });
    expect(html).toContain('<embed');
    expect(html).toContain('data:application/pdf;base64,');
    expect(html).toContain('Download PDF');
    expect(html).toContain('blob-pdf');
  });

  test('renders unknown MIME as download link', () => {
    const html = renderBlobHtml({ mime: 'application/octet-stream', data: 'YWJj' });
    expect(html).toContain('<a');
    expect(html).toContain('download');
    expect(html).toContain('blob-unknown');
  });

  test('escapes MIME type in src attribute', () => {
    // Malicious MIME with quotes should not break the attribute
    const html = renderBlobHtml({ mime: 'image/png"onload="alert(1)', data: 'abc' });
    expect(html).not.toContain('"onload="alert(1)');
  });
});
