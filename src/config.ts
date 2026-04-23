import { z } from "zod";

export const EnvSchema = z.object({
  BUGZILLA_API_KEY: z.string().min(1),
  PHABRICATOR_API_TOKEN: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
});

export type ParsedEnv = z.infer<typeof EnvSchema>;

export interface LoadEnvOptions {
  dryRun: boolean;
}

export const loadEnv = (
  source: NodeJS.ProcessEnv,
  options: LoadEnvOptions,
): ParsedEnv => {
  const schema = options.dryRun
    ? EnvSchema.extend({
        ANTHROPIC_API_KEY: z.string().optional().default(""),
      })
    : EnvSchema;
  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Missing required env var(s): ${missing}`);
  }
  return {
    BUGZILLA_API_KEY: result.data.BUGZILLA_API_KEY,
    PHABRICATOR_API_TOKEN: result.data.PHABRICATOR_API_TOKEN,
    ANTHROPIC_API_KEY: result.data.ANTHROPIC_API_KEY,
  };
};
