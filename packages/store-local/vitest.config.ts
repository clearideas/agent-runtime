import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@clearideas/agent-runtime-contracts": fileURLToPath(
        new URL("../contracts/src/index.ts", import.meta.url),
      ),
      "@clearideas/agent-runtime-core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
