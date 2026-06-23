import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // Spawning real child processes (git/node) — give them room.
    testTimeout: 30_000,
  },
});
