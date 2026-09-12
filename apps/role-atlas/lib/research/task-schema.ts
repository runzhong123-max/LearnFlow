import { z } from "zod/v4";
export const taskFieldSchema = z.object({
  text: z.string().max(4000),
  review: z.object({ status: z.enum(["supported", "partially_supported", "conflicting", "undetermined"]), reason: z.string() }).optional(),
  basis: z.enum(["public_material", "synthesis", "downstream_required", "unknown"]),
  evidence: z.array(z.object({ segmentId: z.string(), quote: z.string().min(1).max(1200) })).default([]),
});
export const taskDefinitionSchema = z.object({
  schemaVersion: z.literal("role-task-definition/v1"),
  goal: taskFieldSchema, trigger: taskFieldSchema, inputs: taskFieldSchema, actors: taskFieldSchema,
  activities: taskFieldSchema, deliverables: taskFieldSchema, qualityCriteria: taskFieldSchema,
  exceptions: taskFieldSchema, downstreamNeeds: z.array(z.string().max(1000)).default([]),
});
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
