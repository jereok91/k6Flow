import { z } from "zod";

export const CONTRACT_VERSION = 1;

// Foundation only: product schemas must explicitly define their own fields.
export const versionEnvelopeSchema = z.strictObject({
  version: z.literal(CONTRACT_VERSION),
});

export type VersionEnvelope = z.infer<typeof versionEnvelopeSchema>;
