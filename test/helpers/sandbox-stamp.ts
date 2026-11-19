/**
 * Shared cache-invalidation stamp for integration sandboxes that install a
 * copy of the plugin via `file:`. Bun copies file: dependencies into
 * node_modules, so any source change (new commit or dirty tree) must produce
 * a new stamp or the sandbox keeps serving a stale copy.
 */

import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

export function pluginSourceStamp(): string {
  const rev = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"]);
  const head = rev.stdout.toString().trim();
  const status = Bun.spawnSync(["git", "-C", REPO_ROOT, "status", "--porcelain", "--", "src", "package.json"]);
  return `${head}:${status.stdout.toString().trim() === "" ? "clean" : "dirty"}`;
}

export { REPO_ROOT as PLUGIN_REPO_ROOT };
