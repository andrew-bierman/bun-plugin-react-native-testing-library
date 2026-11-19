/**
 * Compatibility doctor: read-only audit of the consumer's compatibility
 * state, plus starter-shim scaffolding.
 *
 * The audit plans the registry exactly like the preload does (same config
 * resolution, same source collection) but never registers, so its report
 * cannot drift from what a real run would activate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectCompatSources, readConsumerPackageJson } from "./compat-packages.ts";
import { type ResolvedConfig, resolveConfig } from "./config.ts";
import { LIBRARY_REGISTRY, resolveRegistry } from "./libraries/index.ts";

export type DoctorShimRow = {
  name: string;
  provenance: string;
  state: "planned" | "unavailable" | "disabled" | "filtered";
  reason: string;
};

export type DoctorCoverageRow = {
  dependency: string;
  state: "core" | "shimmed" | "uncovered";
  note?: string;
};

export type DoctorPackageRow = {
  name: string;
  loaded: boolean;
  shims: string[];
  errors: string[];
};

export type DoctorReport = {
  bun: string;
  cwd: string;
  platform: string;
  libraryMocks: ResolvedConfig["libraryMocks"];
  packages: DoctorPackageRow[];
  shims: DoctorShimRow[];
  coverage: DoctorCoverageRow[];
  uncovered: string[];
  jestExpo: { present: boolean; version: string | null; note: string };
};

/** Dependencies worth coverage reporting: RN and Expo ecosystem shapes. */
const ECOSYSTEM_PATTERNS = [
  /^react-native$/,
  /^react-native-/,
  /^@react-native\//,
  /^@react-native-community\//,
  /^expo$/,
  /^expo-/,
  /^@expo\//,
];

const CORE_DEPS = new Set(["react-native", "expo", "expo-modules-core"]);

/** JS-only build tooling the plugin's transform pipeline handles directly. */
const TOOLING_ALLOWLIST = [
  /^@react-native\/babel-/,
  /^@react-native\/codegen$/,
  /^@react-native\/community-cli-plugin$/,
  /^@react-native\/eslint/,
  /^@react-native\/js-polyfills$/,
  /^@react-native\/assets-registry$/,
  /^@react-native\/normalize-colors$/,
  /^@react-native\/virtualized-lists$/,
  /^@react-native\/gradle-plugin$/,
];

function ecosystemDeps(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string[] {
  const names = new Set<string>();
  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    for (const name of Object.keys(section ?? {})) {
      if (ECOSYSTEM_PATTERNS.some((p) => p.test(name))) names.add(name);
    }
  }
  return [...names].sort();
}

function jestExpoInfo(cwd: string): DoctorReport["jestExpo"] {
  try {
    const abs = Bun.resolveSync("jest-expo/package.json", cwd);
    const version = (JSON.parse(readFileSync(abs, "utf8")) as { version?: string }).version ?? null;
    return {
      present: true,
      version,
      note: "official native-module definitions are available for uncovered Expo modules",
    };
  } catch {
    return {
      present: false,
      version: null,
      note: "install jest-expo at your Expo SDK version to provide official native-module definitions",
    };
  }
}

/**
 * Audit the compatibility state at `cwd` without registering anything.
 */
export function runDoctorAudit(cwd: string): DoctorReport {
  const pkg = readConsumerPackageJson(cwd);
  const config = resolveConfig({});
  const compatSources = collectCompatSources(config.compat.compatPackages, cwd);

  const plan = resolveRegistry(config, {
    localShims: config.compat.localShims,
    packageShims: compatSources.packageShims,
    cwd,
  });

  const stateByName = new Map<string, { state: DoctorShimRow["state"]; reason: string; provenance: string }>();
  for (const shim of plan.ordered) {
    stateByName.set(shim.name, {
      state: "planned",
      reason: "packages resolve and no conflict applies",
      provenance: shim.provenance ?? "builtin",
    });
  }
  const recordMissing = (names: readonly string[], state: DoctorShimRow["state"], reason: string): void => {
    for (const name of names) {
      const known = [...LIBRARY_REGISTRY, ...compatSources.packageShims, ...(config.compat.localShims ?? [])].find(
        (s) => s.name === name,
      );
      stateByName.set(name, { state, reason, provenance: known?.provenance ?? "builtin" });
    }
  };
  recordMissing(plan.unavailable, "unavailable", "activation packages do not all resolve from cwd");
  recordMissing(plan.disabled, "disabled", "listed in the disable option");
  recordMissing(plan.filteredOut, "filtered", "filtered out by the libraryMocks option");

  const shims: DoctorShimRow[] = [...stateByName.entries()]
    .map(([name, entry]) => ({ name, provenance: entry.provenance, state: entry.state, reason: entry.reason }))
    .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state.localeCompare(b.state)));

  const jestExpo = jestExpoInfo(cwd);
  const coverage: DoctorCoverageRow[] = [];
  const uncovered: string[] = [];
  for (const dep of ecosystemDeps(pkg)) {
    if (CORE_DEPS.has(dep)) {
      coverage.push({ dependency: dep, state: "core", note: "covered by the RN core mocks" });
      continue;
    }
    if (TOOLING_ALLOWLIST.some((p) => p.test(dep))) {
      coverage.push({ dependency: dep, state: "core", note: "build tooling handled by the plugin transform" });
      continue;
    }
    const byActivation = plan.ordered.find((s) => s.packages.includes(dep));
    if (byActivation) {
      coverage.push({ dependency: dep, state: "shimmed", note: `shim "${byActivation.name}"` });
      continue;
    }
    if ((dep.startsWith("expo-") || dep.startsWith("@expo/")) && jestExpo.present) {
      coverage.push({ dependency: dep, state: "shimmed", note: "via jest-expo native-module definitions" });
      continue;
    }
    coverage.push({ dependency: dep, state: "uncovered" });
    uncovered.push(dep);
  }

  return {
    bun: process.versions.bun,
    cwd,
    platform: config.platform,
    libraryMocks: config.libraryMocks,
    packages: compatSources.packages,
    shims,
    coverage,
    uncovered,
    jestExpo,
  };
}

const SCAFFOLD_TEMPLATE = (packageName: string) => `/**
 * Compatibility shim for ${packageName}.
 *
 * Generated by \`bun-rn-doctor scaffold\`. Replace the mock surface below with
 * the behavior your tests need; set \`surface: "behavioral"\` only when the
 * mock faithfully models the native API. See the README "Extending" section.
 */

import { defineShim, type LibraryShim } from "bun-plugin-react-native-testing-library";

export const shim: LibraryShim = defineShim({
  name: "${packageName.replace(/^@/, "").replaceAll("/", "-")}",
  packages: ["${packageName}"],
  provenance: "local",
  surface: "presentation",
  targets: ["${packageName}"],
  register: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mock } = require("bun:test");
    mock.module("${packageName}", () => ({
      // Replace with the exports your tests touch. Unknown behavior should
      // fail clearly rather than silently pass — avoid catch-all proxies.
    }));
  },
});

export default shim;
`;

/**
 * Write a starter shim for `packageName` under `<cwd>/rn-bun.shims/`.
 * Returns the written path. Throws when the file already exists.
 */
export function scaffoldShim(packageName: string, cwd: string): { path: string } {
  const dir = path.join(cwd, "rn-bun.shims");
  const segments = packageName.split("/");
  const filePath = path.join(dir, ...segments.slice(0, -1), `${segments[segments.length - 1]}.ts`);
  if (existsSync(filePath)) {
    throw new Error(`[rn-bun] scaffold: ${filePath} already exists — remove it first if you want to regenerate`);
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, SCAFFOLD_TEMPLATE(packageName));
  return { path: filePath };
}
