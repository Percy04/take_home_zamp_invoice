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
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash"),
});

const source =
  process.env.NODE_ENV === "test"
    ? { ...process.env, PROVIDER_MODE: "recorded" }
    : process.env;

export const env = envSchema.parse(source);
