import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = resolve(projectRoot, ".sites-runtime");
const timeoutMs = Number.parseInt(process.env.SITES_BUILD_TIMEOUT_MS ?? "180000", 10);

for (const directory of ["home", "npm-cache", "xdg-config", "tmp", "wrangler/logs"]) {
  mkdirSync(resolve(runtimeRoot, directory), { recursive: true });
}

const environment = {
  ...process.env,
  SITES_ENV_READY: "1",
  SITES_PROJECT_ROOT: projectRoot,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: resolve(runtimeRoot, "wrangler/logs"),
  MINIFLARE_REGISTRY_PATH: resolve(runtimeRoot, "wrangler/registry"),
};

const cli = resolve(projectRoot, "node_modules/vinext/dist/cli.js");
const child = spawn(process.execPath, [cli, "build"], { cwd: projectRoot, env: environment, stdio: "inherit" });
const timer = setTimeout(() => {
  console.error(`Vinext build exceeded ${timeoutMs}ms and was stopped.`);
  child.kill("SIGTERM");
}, timeoutMs);
timer.unref();

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  process.exitCode = code ?? (signal ? 1 : 0);
});
