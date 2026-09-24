import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Sources import core as `@localpass/core/dist/*.js`, which Parcel resolves
// but Node rejects (not in core's `exports` map), so point it at core/dist.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@localpass\/core\/dist\/(.*)$/,
        replacement: fileURLToPath(new URL("../core/dist/$1", import.meta.url)),
      },
    ],
  },
  test: { include: ["src/**/*.test.ts"] },
});
