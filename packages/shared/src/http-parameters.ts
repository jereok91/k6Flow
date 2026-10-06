import { z } from "zod";
import { jsonParameterValueSchema, stringParameterValueSchema } from "./parameter-values";

// HTTP token syntax permits extension methods; case is preserved, not normalized.
export const httpMethodSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\s\S])/);
export const httpNamedValueSchema = z.strictObject({
  name: z.string().min(1), value: stringParameterValueSchema,
});
export const httpBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("text"), value: stringParameterValueSchema }),
  z.strictObject({ kind: z.literal("json"), value: stringParameterValueSchema }),
  z.strictObject({ kind: z.literal("xml"), value: stringParameterValueSchema }),
  z.strictObject({ kind: z.literal("form"), value: stringParameterValueSchema }),
]);
export const httpParametersSchema = z.strictObject({
  method: httpMethodSchema,
  url: stringParameterValueSchema,
  headers: z.array(httpNamedValueSchema).optional(),
  query: z.array(httpNamedValueSchema).optional(),
  body: httpBodySchema.optional(),
});
export type HttpMethod = z.infer<typeof httpMethodSchema>;
export type HttpNamedValue = z.infer<typeof httpNamedValueSchema>;
export type HttpBody = z.infer<typeof httpBodySchema>;
export type HttpParameters = z.infer<typeof httpParametersSchema>;
