import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(PROJECT_ROOT, ".cinder-bin");
const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

function needsCloudflared(routeMode = process.env.CINDER_ROUTES ?? "both") {
  return routeMode === "cloudflare" || routeMode === "both";
}

function cloudflaredCommand() {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function localCloudflaredPath() {
  return join(BIN_DIR, cloudflaredCommand());
}

function isExecutableAvailable(command) {
  const probe = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return probe.status === 0;
}

function cloudflaredAsset() {
  const { platform, arch } = process;
  if (platform === "win32") {
    if (arch === "x64") return { name: "cloudflared-windows-amd64.exe", extract: false };
    if (arch === "ia32") return { name: "cloudflared-windows-386.exe", extract: false };
  }
  if (platform === "darwin") {
    if (arch === "arm64") return { name: "cloudflared-darwin-arm64.tgz", extract: true };
    if (arch === "x64") return { name: "cloudflared-darwin-amd64.tgz", extract: true };
  }
  if (platform === "linux") {
    if (arch === "x64") return { name: "cloudflared-linux-amd64", extract: false };
    if (arch === "arm64") return { name: "cloudflared-linux-arm64", extract: false };
    if (arch === "ia32") return { name: "cloudflared-linux-386", extract: false };
  }
  return null;
}

function prependPath(environment, directory) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = environment[pathKey] ?? "";
  environment[pathKey] = current ? `${directory}${process.platform === "win32" ? ";" : ":"}${current}` : directory;
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  if (!response.body) throw new Error(`Download returned no body for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function installCloudflared() {
  const asset = cloudflaredAsset();
  if (!asset) {
    throw new Error(`Automatic cloudflared install is not supported on ${process.platform}-${process.arch}.`);
  }

  mkdirSync(BIN_DIR, { recursive: true });
  const destination = localCloudflaredPath();
  const downloadPath = asset.extract ? join(BIN_DIR, asset.name) : destination;
  const url = `${RELEASE_BASE}/${asset.name}`;

  console.log("Cinder is downloading cloudflared for your platform...");
  await downloadFile(url, downloadPath);

  if (asset.extract) {
    const extract = spawnSync("tar", ["-xzf", downloadPath, "-C", BIN_DIR, "cloudflared"], { stdio: "inherit" });
    if (extract.status !== 0) throw new Error("Could not extract the cloudflared archive.");
    chmodSync(destination, 0o755);
  } else if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }

  if (!isExecutableAvailable(destination)) {
    throw new Error("Downloaded cloudflared failed its version check.");
  }

  console.log(`Cinder installed cloudflared to ${destination}\n`);
  return BIN_DIR;
}

export async function ensureCloudflaredOnPath(routeMode = process.env.CINDER_ROUTES ?? "both", environment = process.env) {
  if (!needsCloudflared(routeMode)) return null;
  if (process.env.CINDER_AUTO_INSTALL_CLOUDFLARED === "false") return null;

  if (isExecutableAvailable("cloudflared")) return null;

  const localPath = localCloudflaredPath();
  if (existsSync(localPath) && isExecutableAvailable(localPath)) {
    prependPath(environment, BIN_DIR);
    return BIN_DIR;
  }

  try {
    const binDir = await installCloudflared();
    prependPath(environment, binDir);
    return binDir;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown cloudflared install error";
    if (routeMode === "cloudflare") {
      console.error(`Could not install cloudflared automatically: ${message}`);
      console.error("Install cloudflared manually or use CINDER_ROUTES=local.");
      process.exit(1);
    }
    console.log(`Normal-browser route unavailable: ${message}`);
    console.log("Install cloudflared manually or use CINDER_ROUTES=local.\n");
    return null;
  }
}
