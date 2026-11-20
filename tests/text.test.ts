import { describe, it, expect } from 'vitest';
import { htmlToText, renderMarkdown, splitComposeBody, stripQuotedText, parseAddress, stripThinking, textToHtml } from '../src/core/text';

describe('htmlToText', () => {
  it('strips tags, scripts and decodes entities', () => {
    const t = htmlToText('<style>p{}</style><p>Hello&nbsp;<b>world</b> &amp; you</p><br><ul><li>One</li><li>Two</li></ul><script>x()</script>');
    expect(t).toContain('Hello world & you');
    expect(t).toContain('• One');
    expect(t).not.toContain('x()');
    expect(t).not.toContain('p{}');
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML so model output cannot inject markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **bold**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>bold</strong>');
  });
  it('renders lists and code', () => {
    const html = renderMarkdown('- a\n- b\n\n```\n<x>\n```');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<pre><code>&lt;x&gt;</code></pre>');
  });
});

describe('splitComposeBody', () => {
  it('keeps the quoted reply and signature out of the rewritable part (HTML)', () => {
    const body = '<p>My new text</p><div class="moz-signature">-- Me</div><div class="moz-cite-prefix">On Mon, Bob wrote:</div><blockquote type="cite">old</blockquote>';
    const { own, rest } = splitComposeBody(body, true);
    expect(own).toBe('<p>My new text</p>');
    expect(rest.startsWith('<div class="moz-signature">')).toBe(true);
  });
  it('splits plain text at the signature or quote header', () => {
    const { own, rest } = splitComposeBody('Hi Bob\nSee you.\n-- \nMe\n\nOn Mon, Bob wrote:\n> hi', false);
    expect(own).toBe('Hi Bob\nSee you.');
    expect(rest.startsWith('-- ')).toBe(true);
  });
});

describe('misc', () => {
  it('stripQuotedText removes reply history', () => {
    expect(stripQuotedText('Thanks!\n\nOn Tue, 3 Jan 2023, Ann wrote:\n> earlier')).toBe('Thanks!');
  });
  it('parseAddress handles both forms', () => {
    expect(parseAddress('"Deals Inc" <Deals@Shop.Example>')).toEqual({ name: 'Deals Inc', address: 'deals@shop.example' });
    expect(parseAddress('bob@x.org')).toEqual({ name: '', address: 'bob@x.org' });
  });
  it('stripThinking hides reasoning blocks', () => {
    expect(stripThinking('<think>hmm</think>Answer')).toBe('Answer');
    expect(stripThinking('<think>still thinking')).toBe('');
  });
  it('textToHtml escapes and paragraphs', () => {
    expect(textToHtml('a<b\nc\n\nd')).toBe('<p>a&lt;b<br>c</p>\n<p>d</p>');
  });
});
