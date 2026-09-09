import { fileURLToPath } from "node:url";
import { createViteServer } from "vitest/node";
import { createPhoneBackend } from "./phone-backend.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
const phone = await createPhoneBackend();
const server = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("./", import.meta.url)),
  cacheDir: `${project}node_modules/.vite/grip-browser`,
  plugins: [
    {
      name: "local-fixture-backend",
      configureServer(server) {
        // Fault injection stays at the local backend boundary, never in reader/cache logic.
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.startsWith("/fixture/rpc/")) {
            try {
              const method = request.url.slice("/fixture/rpc/".length);
              if (
                request.method !== "POST" ||
                ![
                  "start_phone_import",
                  "get_phone_import",
                  "stop_phone_import",
                ].includes(method)
              ) {
                response.writeHead(404).end();
                return;
              }
              let body = "";
              for await (const chunk of request) {
                body += chunk;
                if (body.length > 8192)
                  throw new Error("Fixture RPC body too large");
              }
              const result = await phone.call(method, JSON.parse(body).args);
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(JSON.stringify(result ?? null));
            } catch (error) {
              response.writeHead(500).end(String(error));
            }
            return;
          }
          if (!request.url?.startsWith("/fixture/")) return next();
          response.writeHead(204);
          response.end();
        });
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: /^@decky\/ui$/,
        replacement: fileURLToPath(new URL("./decky-ui.tsx", import.meta.url)),
      },
      {
        find: /^@decky\/api$/,
        replacement: fileURLToPath(new URL("./decky-api.ts", import.meta.url)),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: { allow: [project] },
  },
});
try {
  await server.listen();
} catch (error) {
  await phone.close();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    await phone.close();
    process.exit(0);
  });
}
