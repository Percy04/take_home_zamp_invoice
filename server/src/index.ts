import path from "node:path";
import { createApp } from "./app.js";
import { env } from "./env.js";

const clientDirectory =
  env.NODE_ENV === "production" ? path.resolve(process.cwd(), "dist/client") : undefined;

createApp(clientDirectory).listen(env.PORT, () => {
  console.log(`AP Resolution Agent listening on http://localhost:${env.PORT}`);
});
