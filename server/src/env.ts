import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  RUNTIME_DIR: z.string().min(1).default("data/runtime"),
  PROVIDER_MODE: z.enum(["recorded", "live"]).default("recorded"),
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: z.url().optional(),
  AZURE_DOCUMENT_INTELLIGENCE_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4-mini"),
});

export const env = envSchema.parse(process.env);
