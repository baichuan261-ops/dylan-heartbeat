const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePushText } = require('../push_text');
test('preserves title and body across supported model formats', () => {
  for (const input of ['[BARK]想你了\n来抱一下[/BARK]', '想你了\\n来抱一下', '标题：想你了 正文：来抱一下', '{"title":"想你了","body":"来抱一下"}']) {
    assert.deepEqual(parsePushText(input), { title: '想你了', body: '来抱一下' });
  }
});
test('does not invent a body or discard single-line messages', () => {
  assert.deepEqual(parsePushText('来抱一下'), { title: 'Silas', body: '来抱一下' });
  assert.deepEqual(parsePushText(''), { title: '', body: '' });
});
