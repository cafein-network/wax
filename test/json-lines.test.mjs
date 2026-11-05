import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonLineError, parseJsonLines, pointerOf } from '../src/json-lines.mjs';

const lineWith = (text, needle, from = 0) => text.split('\n').findIndex((row, index) => index >= from && row.includes(needle)) + 1;

test('json-lines: values equal JSON.parse for indented and compact JSON', () => {
  const samples = [
    { schemaVersion: 1, id: 'a', proofs: [{ id: 'p1', output: 'line\nnext "quoted" \\ back', exitCode: 1 }, { id: 'p2', exitCode: 0, durationMs: 1.5e3 }], empty: {}, list: [], n: -0.25, yes: true, no: false, none: null },
    [1, 'two', [3, [4, { five: '五 🎉 \u2028' }]]],
    'just a string', 42, null,
  ];
  for (const sample of samples) {
    for (const text of [JSON.stringify(sample, null, 2), JSON.stringify(sample), `\ufeff${JSON.stringify(sample, null, 2)}\n`]) {
      assert.deepEqual(parseJsonLines(text).value, JSON.parse(text.replace(/^\ufeff/, '')));
    }
  }
});

test('json-lines: each value gives the line it starts on, by JSON pointer', () => {
  const feature = { id: 'shop', proofs: [{ id: 'p1', output: 'a\nb' }, { id: 'p2', tree: { head: 'abc', files: { 'src/a b.js': null } } }], 'a/b': { '~x': 1 } };
  const text = JSON.stringify(feature, null, 2);
  const { lineOf, lines } = parseJsonLines(text);
  assert.equal(lineOf(''), 1);
  assert.equal(lineOf('/id'), lineWith(text, '"id": "shop"'));
  assert.equal(lineOf('/proofs'), lineWith(text, '"proofs"'));
  assert.equal(lineOf('/proofs/1'), lineWith(text, '"id": "p2"') - 1);
  assert.equal(lineOf('/proofs/1/tree/files/src~1a b.js'), lineWith(text, '"src/a b.js"'));
  assert.equal(lineOf(pointerOf(['a/b', '~x'])), lineWith(text, '"~x"'));
  assert.equal(pointerOf(['a/b', '~x']), '/a~1b/~0x');
  assert.equal(lineOf('/nope'), null, 'a pointer outside the document has no line');
  assert.equal(lineOf('proofs'), null, 'a pointer must start with /');
  assert.ok(lines.size >= 10);
});

test('json-lines: deep values past the recorded depth fall back to the nearest recorded parent', () => {
  const doc = { a: { b: { c: { d: 1 } } } };
  const text = JSON.stringify(doc, null, 2);
  const { lineOf, lines } = parseJsonLines(text, { pointerDepth: 2 });
  assert.equal(lines.has('/a/b/c'), false);
  assert.equal(lineOf('/a/b/c/d'), lineWith(text, '"b"'));
  const many = parseJsonLines(JSON.stringify({ list: Array.from({ length: 50 }, (_, i) => i) }, null, 2), { maxPointers: 5 });
  assert.equal(many.lines.size, 5);
  assert.equal(many.lineOf('/list/40'), many.lineOf('/list'), 'values past maxPointers use the parent line');
});

test('json-lines: bad JSON throws with the line, deep nesting is refused, __proto__ stays a plain key', () => {
  for (const [text, line] of [['{\n  "a": 1,\n  "b": \n}', 4], ['[1,\n2,\n]', 3], ['{"a": 1}\nx', 2], ['"bad \\q escape"', 1], ['01', 1], ['"a\nb"', 1], ['', 1], ['{"a" 1}', 1], ['[1 2]', 1]]) {
    assert.throws(() => parseJsonLines(text), (error) => error instanceof JsonLineError && error.line === line, JSON.stringify(text));
  }
  assert.throws(() => parseJsonLines('['.repeat(300) + ']'.repeat(300)), /nested too deeply/);
  assert.deepEqual(parseJsonLines('['.repeat(5) + ']'.repeat(5), { maxDepth: 5 }).value, [[[[[]]]]]);
  const parsed = parseJsonLines('{"__proto__": {"polluted": true}, "a": 1, "a": 2}').value;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'a']);
  assert.equal(parsed.a, 2, 'the last duplicate wins, like JSON.parse');
  assert.equal(({}).polluted, undefined);
});
