/**
 * npm-distributed compatibility shim packages.
 *
 * Discovery: a consumer dependency named `bun-rn-compat-*` (documented
 * convention) is loaded automatically; explicit `compat.compatPackages`
 * entries work for packages outside the convention and come first.
 *
 * Loading: each package must expose its shims via a `./shim` export (or the
 * package root), as an array of shim objects. A package that resolves but
 * does not export shims is a reported error — never a silent skip.
 */

import { readFileSync } from "node:fs";
import type { LibraryShim } from "./libraries/helpers.ts";
import { defineShim } from "./shim.ts";

export const COMPAT_PACKAGE_PATTERN = /^bun-rn-compat-/;

export type CompatPackageLoad = {
  name: string;
  shims: LibraryShim[];
  errors: string[];
};

/**
 * Package names to load: explicit entries first, then `bun-rn-compat-*`
 * dependencies and devDependencies from the consumer's package.json.
 */
export function discoverCompatPackages(cwd: string, explicit: readonly string[] = []): string[] {
  const found = new Set<string>();
  for (const name of explicit) {
    if (typeof name === "string" && name !== "") found.add(name);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const section of [pkg.dependencies, pkg.devDependencies]) {
      for (const name of Object.keys(section ?? {})) {
        if (COMPAT_PACKAGE_PATTERN.test(name)) found.add(name);
      }
    }
  } catch {
    // No readable package.json: only explicit entries apply.
  }
  return [...found];
}

/** Load and validate the shims one compat package exports. */
export function loadCompatPackageShims(name: string, cwd: string): CompatPackageLoad {
  let mod: unknown = null;
  let resolvedFrom: string | null = null;
  for (const specifier of [`${name}/shim`, name]) {
    try {
      const abs = Bun.resolveSync(specifier, cwd);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(abs);
      resolvedFrom = abs;
      break;
    } catch {
      // try the next specifier
    }
  }
  if (mod == null) {
    return {
      name,
      shims: [],
      errors: [
        `[rn-bun] compat package "${name}" is installed but exports no ./shim module (expected \`exports["./shim"]\` exporting an array of shims)`,
      ],
    };
  }

  const raw = (mod as { shims?: unknown; default?: unknown }).shims ?? (mod as { default?: unknown }).default ?? mod;
  const candidates = Array.isArray(raw) ? raw : [];
  const shims: LibraryShim[] = [];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      shims.push(defineShim(candidate as LibraryShim));
    } catch (err) {
      errors.push(
        `[rn-bun] compat package "${name}" (${resolvedFrom ?? name}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!Array.isArray(raw)) {
    errors.push(`[rn-bun] compat package "${name}" did not export an array of shims`);
  }
  return { name, shims, errors };
}

/**
 * Collect the registry sources implied by the consumer's compat configuration
 * and package.json: project-local shims plus npm compat package shims.
 * Shared by the preload entry and `registerCompat` so both paths behave alike.
 */
export function collectCompatSources(
  compatPackages: readonly string[],
  cwd: string,
): { packageShims: LibraryShim[]; errors: string[] } {
  const names = discoverCompatPackages(cwd, compatPackages);
  const packageShims: LibraryShim[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const loaded = loadCompatPackageShims(name, cwd);
    packageShims.push(...loaded.shims);
    errors.push(...loaded.errors);
  }
  return { packageShims, errors };
}
