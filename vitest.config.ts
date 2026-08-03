import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under .claude/worktrees carry their own node_modules
    // (Electron-ABI natives) and duplicate test files; never scan them.
    // infra/ holds the standalone Vercel projects. They are not part of the
    // app's build and their tests are node:test, which vitest collects and
    // then fails on with "No test suite found". They run through
    // `npm --prefix infra/telemetry test`.
    exclude: [...defaultExclude, "**/.claude/**", "infra/**"],
  },
});
