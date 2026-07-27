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
      "@clearideas/agent-runtime-config": fileURLToPath(
        new URL("../runtime/src/index.ts", import.meta.url),
      ),
      "@clearideas/agent-runtime-condition-jexl": fileURLToPath(
        new URL("../condition-jexl/src/index.ts", import.meta.url),
      ),
      "@clearideas/agent-runtime-step-loop": fileURLToPath(
        new URL("../step-loop/src/index.ts", import.meta.url),
      ),
      "@clearideas/agent-runtime-step-prompt": fileURLToPath(
        new URL("../step-prompt/src/index.ts", import.meta.url),
      ),
      "@clearideas/agent-runtime-step-standard": fileURLToPath(
        new URL("../step-standard/src/index.ts", import.meta.url),
      ),
      "@clearideas/agent-runtime-store-local": fileURLToPath(
        new URL("../store-local/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
