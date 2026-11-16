import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  // No tsconfigPaths: this package's tsconfig `paths` point at declaration
  // files for type checking only. Tests resolve the built workspace packages.
});
