import type { z } from 'zod'

/**
 * An IPC argument that may be left out. The shell passes arguments as JSON, where an omitted
 * (undefined) argument arrives as null, and zod's optional() rejects null.
 */
export const optionalArg = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined)
