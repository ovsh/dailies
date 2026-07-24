import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under .claude/worktrees carry their own node_modules
    // (Electron-ABI natives) and duplicate test files; never scan them.
    exclude: [...defaultExclude, "**/.claude/**"],
  },
});
