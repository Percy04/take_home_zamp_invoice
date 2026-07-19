import path from "node:path";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { extractAndMapLive } from "./providers.js";
import { Storage } from "./storage.js";

const clientDirectory = env.NODE_ENV === "production" ? path.resolve(process.cwd(), "dist/client") : undefined;

const storage = new Storage(env.RUNTIME_DIR);
const server = createApp({ clientDirectory, storage, extractInvoice: extractAndMapLive }).listen(env.PORT, () => {
  console.log(`AP Resolution Agent listening on http://localhost:${env.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => storage.close()));
}
