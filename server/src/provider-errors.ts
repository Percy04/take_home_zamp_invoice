export type ProviderStage =
  | "CONFIG"
  | "AZURE_ANALYZE"
  | "AZURE_POLL"
  | "AZURE_RESULT"
  | "AZURE_EVIDENCE"
  | "OPENAI_MAPPING"
  | "GEMINI_MAPPING"
  | "AI_RECHECK"
  | "MAPPING_VALIDATION";

export type ProviderDiagnostic = string | number | boolean | null | undefined;

export class ProviderError extends Error {
  constructor(
    readonly stage: ProviderStage,
    message: string,
    readonly diagnostics: Record<string, ProviderDiagnostic> = {},
  ) {
    super(message);
  }
}

export function providerError(
  stage: ProviderStage,
  message: string,
  caught: unknown,
  extra: Record<string, ProviderDiagnostic> = {},
) {
  return new ProviderError(stage, message, { ...extra, ...safeError(caught) });
}

export function safeError(error: unknown): Record<string, ProviderDiagnostic> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const shaped = error as Error & { status?: number; code?: string; type?: string };
  return {
    name: shaped.name,
    message: shaped.message,
    status: shaped.status,
    code: shaped.code,
    type: shaped.type,
  };
}

export async function safeResponseError(response: Response) {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; status?: unknown; message?: unknown } };
    const message = typeof body.error?.message === "string" ? body.error.message.slice(0, 500) : undefined;
    return [body.error?.code, body.error?.status, message].filter((part) => part !== undefined).join(" ");
  } catch {
    return undefined;
  }
}

export function isRetryableMappingError(error: unknown) {
  if (!(error instanceof ProviderError)) return true;
  const status = error.diagnostics.status;
  if (error.diagnostics.malformed) return true;
  return typeof status !== "number" || status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function withOneMappingRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (caught) {
      if (attempt >= 1 || !isRetryableMappingError(caught)) throw caught;
    }
  }
}
