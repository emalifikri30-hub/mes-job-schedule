import { defineConfig, loadEnv } from "vite-plus";
import devServer from "@hono/vite-dev-server";

const env = loadEnv("development", process.cwd(), "");

export default defineConfig({
  server: {
    // STRICT, so a busy port is an error rather than a silent move to the next
    // one. Vite's default is to increment: with 3002 already held by a stale api
    // process, `pnpm dev:all` came up looking healthy while the BFF kept talking
    // to that stale server — a browser showing 62 fabricated rows against a table
    // DBeaver reported as empty. Failing to bind is the diagnosis; moving is not.
    strictPort: true,
    // 3002, not 3001. The fallback here was a copy of the BFF's and only stayed
    // harmless because apps/api/.env sets PORT — without it the api would try to
    // bind the BFF's port, which strictPort now turns into an immediate error
    // instead of whichever of the two lost the race.
    port: parseInt(env.PORT) || 3002,
  },
  test: {
    include: ["src/**/*.test.ts"],
    // EVERY TEST RUNS IN A ZONE THAT HAS DST, AND THAT IS DELIBERATE.
    //
    // This product's plants are in Indonesia (WIB/WITA/WIT), none of which
    // observes daylight saving. That means a date bug of the form "assumed the
    // process's local zone" or "added 24 hours to cross a day" CANNOT FAIL on a
    // developer's machine, on a Jakarta server, or under the UTC that CI would
    // otherwise default to. It fails the first time a site in another offset is
    // added, or the first time somebody corrects a site's zone upstream — in
    // production, silently, by moving every planned shift by an hour.
    //
    // America/New_York has two transitions a year, so the suite exercises both
    // a 23-hour and a 25-hour local day on every run. Combined with the
    // explicit-zone cases in shared/shift.test.ts, that is what turns a
    // dormant bug class into a red build today.
    //
    // Do not "simplify" this to UTC. UTC is the zone in which these bugs are
    // invisible.
    env: {
      TZ: "America/New_York",
    },
  },
  build: {
    ssr: "./src/cmd/api/index.ts",
    outDir: "dist",
    rollupOptions: {
      // Keep modules that OpenTelemetry patches at runtime un-bundled so the
      // require/import hooks installed by instrumentation.mjs can intercept
      // them. The OTel SDK/instrumentations must stay real modules; pino's
      // transport workers resolve targets by name. `postgres` is external
      // because it resolves its runtime variant (node/cf/deno) dynamically.
      external: ["postgres", /^@opentelemetry\//, "pino", "pino-pretty", "thread-stream"],
      output: {
        entryFileNames: "index.js",
      },
    },
  },
  plugins: [
    devServer({
      entry: "./src/cmd/api/app.ts",
    }),
  ],
  lint: {
    ignorePatterns: ["dist"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
