import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cargo's build directory. build.rs stages the minified room UI into OUT_DIR
    // to embed it in the relay binary, and those copies are not ours to lint.
    "rust-server/target/**",
  ]),
]);

export default eslintConfig;
