import { z } from "zod";
import { graphDraftStructureSchema } from "./graph";

// Reuse exactly the structural identity shape; this does not validate a producer.
export const producerOutputReferenceSchema =
  graphDraftStructureSchema.shape.nodes.element.shape.references.element;
export type ProducerOutputReference = z.infer<typeof producerOutputReferenceSchema>;

export type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue };

// Inspect data descriptors only: accessors/native objects are not JSON data.
export const jsonValueSchema = z.custom<JsonValue>(() => true).superRefine((value, ctx) => {
  const active = new Set<object>();
  const pending: { value: unknown; path: (string | number)[]; exit?: boolean }[] =
    [{ value, path: [] }];
  const invalid = (path: (string | number)[]) => ctx.addIssue({
    code: "custom", path, message: "Expected finite JSON data without cycles or executable objects",
  });
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const item = entry.value;
    if (entry.exit) { active.delete(item as object); continue; }
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object" || item === null) { invalid(entry.path); continue; }
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (active.has(item) || (array ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null)) {
      invalid(entry.path); continue;
    }
    active.add(item);
    pending.push({ ...entry, exit: true });
    const keys = Reflect.ownKeys(item).filter((key) => !array || key !== "length");
    if (array && keys.length !== item.length) invalid(entry.path);
    for (const key of keys) {
      const path = [...entry.path, array && typeof key === "string" ? Number(key) : String(key)];
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) {
        invalid(path); continue;
      }
      pending.push({ value: descriptor.value, path });
    }
  }
});

const referenceValueSchema = z.strictObject({
  kind: z.literal("reference"), reference: producerOutputReferenceSchema,
});
export const stringParameterValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: z.string() }), referenceValueSchema,
]);
export const jsonParameterValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: jsonValueSchema }), referenceValueSchema,
]);
export type StringParameterValue = z.infer<typeof stringParameterValueSchema>;
export type JsonParameterValue = z.infer<typeof jsonParameterValueSchema>;
