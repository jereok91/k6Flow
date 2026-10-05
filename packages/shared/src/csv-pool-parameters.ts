import { z } from "zod";
import { producerOutputReferenceSchema } from "./parameter-values";
import { versionEnvelopeSchema } from "./version";

// Structural identity only: no attachment resolution or security guarantee.
export const csvPoolAttachmentSchema = z.strictObject({
  id: producerOutputReferenceSchema.shape.output,
});
export const csvPoolOutputSchema = z.strictObject({
  header: z.string().refine((value) => value.trim().length > 0, {
    message: "Expected a nonblank CSV header name",
  }),
  name: producerOutputReferenceSchema.shape.output,
  expectedType: z.literal("string"),
  required: z.literal(true),
});
export const csvPoolAllocationSchema = z.literal("csv-order-distinct-row-per-vu");
export const csvPoolCapacityPolicySchema = z.literal("reject-before-execution");

// Manual user entry for User Pool
export const manualUserSchema = z.strictObject({
  username: z.string(),
  password: z.string(),
});

// Mode selector for User Pool data source
export const csvPoolModeSchema = z.enum(["csv", "manual"]);

// Declaration only: ingestion, capacity checks and stable VU assignment are future work.
export const csvPoolParametersSchema = z.strictObject({
  version: versionEnvelopeSchema.shape.version,
  attachment: csvPoolAttachmentSchema.optional(),
  allocation: csvPoolAllocationSchema,
  onInsufficientCapacity: csvPoolCapacityPolicySchema,
  outputs: z.array(csvPoolOutputSchema),
  // Optional manual users for direct entry without CSV
  manualUsers: z.array(manualUserSchema).optional(),
  // Mode selector: csv or manual
  mode: csvPoolModeSchema.optional(),
}).superRefine((parameters, ctx) => {
  const names = new Set<string>();
  parameters.outputs.forEach((output, index) => {
    if (names.has(output.name)) {
      ctx.addIssue({ code: "custom", path: ["outputs", index, "name"],
        message: "Duplicate CSV pool output identity" });
    }
    names.add(output.name);
  });
});

export type CsvPoolAttachment = z.infer<typeof csvPoolAttachmentSchema>;
export type CsvPoolOutput = z.infer<typeof csvPoolOutputSchema>;
export type CsvPoolAllocation = z.infer<typeof csvPoolAllocationSchema>;
export type CsvPoolCapacityPolicy = z.infer<typeof csvPoolCapacityPolicySchema>;
export type ManualUser = z.infer<typeof manualUserSchema>;
export type CsvPoolMode = z.infer<typeof csvPoolModeSchema>;
export type CsvPoolParameters = z.infer<typeof csvPoolParametersSchema>;
