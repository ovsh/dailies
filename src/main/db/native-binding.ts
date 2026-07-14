import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

interface NativePaths {
  binding: string;
  manager: string;
}

function resolveNativePaths(): NativePaths | null {
  try {
    const from = typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json");
    const require = createRequire(from);
    const packageJsonPath = require.resolve("better-sqlite3/package.json");
    const packageRoot = path.dirname(packageJsonPath);
    const projectRoot = path.resolve(packageRoot, "..", "..");
    const version = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;
    const runtime = process.versions.electron ? "electron" : "node";
    const runtimeVersion = process.versions.electron ?? process.versions.node;
    const filename = `${runtime}-${runtimeVersion}-abi-${process.versions.modules}-${process.platform}-${process.arch}.node`;
    return {
      binding: path.join(
        projectRoot,
        ".native-cache",
        `better-sqlite3-${version}`,
        filename,
      ),
      manager: path.join(projectRoot, "scripts", "manage-better-sqlite3.mjs"),
    };
  } catch {
    return null;
  }
}

/** Returns the side-by-side native binding for this runtime, when it has been cached. */
export function cachedBetterSqlite3Binding(): string | undefined {
  const binding = resolveNativePaths()?.binding;
  return binding && existsSync(binding) ? binding : undefined;
}

/**
 * Repairs an ABI mismatch for direct Node harnesses that bypass npm lifecycle scripts.
 * Normal app/test startup never spawns this process because the matching cache is used.
 */
export function repairBetterSqlite3Binding(): string | undefined {
  const paths = resolveNativePaths();
  if (!paths || !existsSync(paths.manager)) return undefined;

  const target = process.versions.electron ? "electron" : "node";
  const env = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const result = spawnSync(process.execPath, [paths.manager, target], {
    cwd: path.dirname(path.dirname(paths.manager)),
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`Automatic better-sqlite3 ABI repair failed${details ? `:\n${details}` : "."}`);
  }
  return existsSync(paths.binding) ? paths.binding : undefined;
}
