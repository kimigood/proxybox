// Assemble deploy inputs from the store: deduped nodes + persisted region groups.
export function assembleInputs(store) {
  const nodes = []
  const regionGroups = []
  const seenTags = new Set()
  for (const sub of store.listSubscriptions()) {
    for (const n of store.getSubscriptionNodes(sub.id)) {
      if (!n?.tag || seenTags.has(n.tag)) continue
      seenTags.add(n.tag)
      nodes.push(n)
    }
    for (const g of store.kvGetJson(`subgroups.${sub.id}`, [])) {
      regionGroups.push({ name: g.name, nodeTags: (g.nodeTags || []).filter((t) => seenTags.has(t)) })
    }
  }
  return { nodes, regionGroups }
}
