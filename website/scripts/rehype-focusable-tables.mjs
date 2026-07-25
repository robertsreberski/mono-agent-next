// SPDX-License-Identifier: MIT
/**
 * Add keyboard focus to rendered Markdown tables.
 *
 * Starlight applies horizontal overflow directly to `<table>` elements. A
 * focusable table lets keyboard users reach and scroll that region when its
 * content is wider than the viewport.
 */
export function rehypeFocusableTables() {
  return (tree) => {
    visit(tree);
  };
}

function visit(node) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'element' && node.tagName === 'table') {
    node.properties ??= {};
    if (node.properties.tabIndex === undefined) {
      node.properties.tabIndex = 0;
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child);
  }
}
