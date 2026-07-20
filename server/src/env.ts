import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    RUNTIME_DIR: z.string().min(1).default("data/runtime"),
    MAPPING_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: z.url().optional(),
    AZURE_DOCUMENT_INTELLIGENCE_KEY: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash"),
    DEV_CORS_ORIGIN: z.url().default("http://localhost:5173"),
    ALLOW_DEMO_RESET: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "test") return;
    for (const [name, configured] of [
      ["AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", value.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT],
      ["AZURE_DOCUMENT_INTELLIGENCE_KEY", value.AZURE_DOCUMENT_INTELLIGENCE_KEY],
      [
        value.MAPPING_PROVIDER === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY",
        value.MAPPING_PROVIDER === "openai" ? value.OPENAI_API_KEY : value.GEMINI_API_KEY,
      ],
    ] as const) {
      if (!configured)
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required outside automated tests.`,
        });
    }
  });

export function parseEnv(source: NodeJS.ProcessEnv) {
  return envSchema.parse(source);
}

const parsed = parseEnv(process.env);

export const env = {
  ...parsed,
  ALLOW_DEMO_RESET: parsed.ALLOW_DEMO_RESET ?? parsed.NODE_ENV !== "production",
};
