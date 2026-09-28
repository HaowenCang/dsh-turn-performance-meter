/**
 * Shared navigation for the completed-card element tree.
 *
 * Both card test files drive `completedTree` with a recording `createElement` and
 * then have to address elements inside the result. Phase 9 added a nested
 * shell (`.dsh-tpm-card > .dsh-tpm-card-body > header + detail`), so the two
 * files share one walker rather than each growing its own copy of it.
 *
 * `card()` exists because the default card is now **collapsed**: a test that
 * asserts on a metric column has to ask for the detail, and it should say so
 * explicitly. `settledCardTree` therefore takes `{ collapsed }` and defaults to
 * expanded, so the pre-Phase-9 assertions read unchanged while the collapse
 * tests opt in.
 */

import { completedTree } from '../../src/client/completed/completed-tree.js'

/**
 * A recording `createElement`: returns the tree as plain data.
 *
 * Children are kept nested exactly as React receives them — no flattening — so an
 * assertion can address `cell.children[1].children[0]` (the number inside the
 * value row) rather than a flattened bag of strings.
 */
export function rec(tag, props, children) {
  const list = Array.isArray(children) ? children.filter(child => child !== null && child !== undefined) : [children]
  return { tag, props: props ?? {}, children: list }
}

/** Every element of a tree whose class list contains `name`, in document order. */
export function byClass(node, name, found = []) {
  if (node === null || node === undefined || typeof node === 'string') return found
  if (String(node.props.className ?? '').split(/\s+/).includes(name)) found.push(node)
  for (const child of node.children) byClass(child, name, found)
  return found
}

/** Every text node of a tree, in document order. */
export function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return node.children.flatMap(texts)
}

/** Every element tag present anywhere in a tree. */
export function tagsOf(tree) {
  const tags = new Set()
  const walk = node => {
    if (node === null || node === undefined || typeof node === 'string') return
    tags.add(node.tag)
    for (const child of node.children) walk(child)
  }
  walk(tree)
  return tags
}

/** The first element of a tree carrying `name` in its class list. */
export function one(node, name) {
  return byClass(node, name)[0]
}

/** The stacked layer of one detail view (`summary` / `curve`), or `undefined`. */
export function layer(tree, name) {
  return byClass(tree, 'dsh-tpm-view').find(node => node.props['data-view'] === name)
}

/** A card built from an already-shaped view model. */
export function cardOfView(view, translate, interaction = {}) {
  return completedTree(rec, view, translate, { collapsed: false, ...interaction })
}

/** A card built from a settled snapshot. */
export function cardOfSettled(settled, viewModelOf, translate, interaction = {}) {
  return cardOfView(viewModelOf(settled), translate, interaction)
}
