'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { LABELS } = require('../scripts/install-labels.js');

const workflow = path.join(__dirname, '..', '.github', 'workflows', 'install-labels.yml');

test('install-labels.yml inlines the same LABELS as scripts/install-labels.js', () => {
  const source = fs.readFileSync(workflow, 'utf8');
  const match = /const LABELS = (\[[\s\S]*?\n\s*\]);/.exec(source);
  assert.ok(match, `no LABELS array found in ${workflow}`);
  const inlined = vm.runInNewContext(match[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(inlined)), JSON.parse(JSON.stringify(LABELS)));
});

test('LABELS are well-formed and unique', () => {
  const names = new Set();
  for (const label of LABELS) {
    assert.match(label.name, /^agent\/[a-z-]+$/);
    assert.match(label.color, /^[0-9A-F]{6}$/);
    assert.ok(label.description.length > 0 && label.description.length <= 100, `${label.name} description length`);
    assert.ok(!names.has(label.name.toLowerCase()), `duplicate ${label.name}`);
    names.add(label.name.toLowerCase());
  }
});
