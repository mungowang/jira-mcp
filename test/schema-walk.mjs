/**
 * Schema walkers shared by the description invariants, kept in their own module so they can be
 * tested against schemas that are *known* to contain the bug they exist to find.
 *
 * The reason is a real miss: the first version of the `$ref` check walked only `properties` and
 * `items`, so it reported zero while four `$ref`s sat inside `additionalProperties` - the value
 * schema of a `z.record` reused within one schema. A checker that cannot see its own target is
 * worse than no checker, because it gets believed.
 */

/** Every `$ref` anywhere in a schema, with the path that holds it. */
export function refs(node, path, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.$ref === 'string') out.push(`${path} -> ${node.$ref}`);
  for (const key of ['properties', 'patternProperties']) {
    if (node[key]) for (const [k, v] of Object.entries(node[key])) refs(v, `${path}.${k}`, out);
  }
  if (node.items) refs(node.items, `${path}[]`, out);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    refs(node.additionalProperties, `${path}{}`, out);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((v, i) => refs(v, `${path}.${key}[${i}]`, out));
  }
  return out;
}

/**
 * Every *named* property at every level that carries no description.
 *
 * Deliberately shallower than {@link refs}: `additionalProperties` describes map values, which have
 * no name of their own, so requiring a description there would demand text nobody can place.
 */
export function undescribed(node, path, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) {
      const has = typeof v.description === 'string' && v.description.trim().length > 0;
      if (!has) out.push(`${path}.${k}`);
      undescribed(v, `${path}.${k}`, out);
    }
  }
  if (node.items) undescribed(node.items, `${path}[]`, out);
  return out;
}
