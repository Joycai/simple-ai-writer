/**
 * The two halves of sending one of this app's output schemas in a protocol's
 * *strict* schema mode (`response_format.json_schema` with `strict: true`).
 *
 * Strict mode buys a guarantee — the reply matches the schema — at the price of
 * two rules the schema must satisfy (`docs/api/structured.md` §3): every
 * `object` must say `additionalProperties: false`, and **every property must be
 * listed in `required`**. Optional fields can only be expressed as "this type or
 * null".
 *
 * Five of this app's output schemas have optional fields (一致性检查's
 * `suggestion` / `entity`, the image prompt's `negative` / `style` / `aspect`).
 * Rewriting those definitions to satisfy strict mode would damage the *main*
 * structured path — the forced tool call, where optional means optional and
 * every family honours it — to suit the fallback. So the transformation happens
 * on the way out, mechanically, and its mirror image on the way back in:
 *
 *   - `strictify(schema)`  — what the wire gets. A deep copy; the caller's
 *                            definition is never touched.
 *   - `stripNulls(value)`  — what the caller gets. The `null`s strictify made
 *                            legal are removed again, so a parsed reply has the
 *                            same shape it would have had from the tool path,
 *                            where an omitted field is simply absent. Callers
 *                            are written against *absent*; `null` would be a new
 *                            case for every one of them.
 *
 * Whether DashScope's strict validator accepts the `["string","null"]` type
 * union is the first live check in `docs/api/structured-output-plan.md` §11.
 */

type JsonSchema = Record<string, unknown>;

function isObjectSchema(node: JsonSchema): boolean {
  return node.type === "object" || typeof node.properties === "object";
}

/** `node`, made to accept `null` as well — without changing what else it accepts. */
function nullable(node: JsonSchema): JsonSchema {
  if (Array.isArray(node.type)) {
    const types = node.type as unknown[];
    return types.includes("null") ? node : { ...node, type: [...types, "null"] };
  }
  if (typeof node.type === "string") {
    const out: JsonSchema = { ...node, type: [node.type, "null"] };
    // An enum constrains the value, so the null has to be legal there too or the
    // two keywords contradict each other and strict validators reject the schema.
    if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(null)) {
      out.enum = [...(node.enum as unknown[]), null];
    }
    return out;
  }
  if (Array.isArray(node.anyOf)) {
    return { ...node, anyOf: [...(node.anyOf as unknown[]), { type: "null" }] };
  }
  // No type keyword to widen (a bare description, a $ref): wrap instead.
  return { anyOf: [node, { type: "null" }] };
}

/**
 * A deep copy of `schema` satisfying strict mode's two rules at every level.
 *
 * Idempotent: a schema that is already strict comes back unchanged in meaning,
 * because a field already in `required` is not made nullable and a `null` type
 * is not added twice.
 */
export function strictify(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };

  if (isObjectSchema(out)) {
    const props = (out.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((Array.isArray(out.required) ? out.required : []) as string[]);
    const nextProps: Record<string, JsonSchema> = {};
    for (const [key, prop] of Object.entries(props)) {
      const inner = strictify(prop);
      nextProps[key] = required.has(key) ? inner : nullable(inner);
    }
    out.properties = nextProps;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }

  if (out.items && typeof out.items === "object") {
    out.items = Array.isArray(out.items)
      ? (out.items as JsonSchema[]).map(strictify)
      : strictify(out.items as JsonSchema);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(out[key])) out[key] = (out[key] as JsonSchema[]).map(strictify);
  }
  return out;
}

/**
 * `value` with every `null`-valued object property removed, recursively.
 *
 * Only object *properties* are dropped: that is the one place `strictify`
 * introduces a `null` (an optional field the model left empty). A `null` inside
 * an array was put there by the model on purpose and stays.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}
