/**
 * Example project-local compatibility shim.
 *
 * Copy this shape into your app's `rn-bun.config.ts` under `compat.shims` to
 * teach the compatibility layer about a native library it does not ship a
 * shim for. Registration order, conflicts, and overrides are handled by the
 * registry — see the "Extending" section of the README.
 */

import { defineShim, type LibraryShim } from "../../src/index.ts";

/**
 * Presentation-only example: renders `FancyView` from the (fictional)
 * `react-native-fancy-view` package as a plain View. `surface: "presentation"`
 * documents that this shim renders children and forwards test props — it does
 * not model native behavior.
 */
export const exampleLocalShim: LibraryShim = defineShim({
  name: "example-local-view",
  packages: ["react"],
  provenance: "local",
  surface: "presentation",
  targets: ["react-native-fancy-view"],
  register: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { View } = require("react-native") as typeof import("react-native");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mockBoth } = require("../../src/libraries/helpers.ts") as {
      mockBoth: (specifier: string, factory: () => unknown) => void;
    };
    mockBoth("react-native-fancy-view", () => ({
      default: View,
      FancyView: View,
    }));
  },
});
