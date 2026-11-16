import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          ATLAS_INGEST_HMAC_SECRET: "test-hmac-secret",
          ATLAS_VIEW_PASSWORD: "test-view-password",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.js"],
    setupFiles: ["./tests/apply-migrations.js"],
  },
});
