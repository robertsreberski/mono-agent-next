// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';

import { rehypeFocusableTables } from '../rehype-focusable-tables.mjs';

test('makes nested tables keyboard-focusable without replacing properties', () => {
  const table = {
    type: 'element',
    tagName: 'table',
    properties: { className: ['wide'] },
    children: [],
  };
  const tree = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'section',
        properties: {},
        children: [table],
      },
    ],
  };

  rehypeFocusableTables()(tree);

  assert.deepEqual(table.properties, {
    className: ['wide'],
    tabIndex: 0,
  });
});

test('preserves an explicitly configured table tab index', () => {
  const table = {
    type: 'element',
    tagName: 'table',
    properties: { tabIndex: -1 },
    children: [],
  };

  rehypeFocusableTables()({ type: 'root', children: [table] });

  assert.equal(table.properties.tabIndex, -1);
});
