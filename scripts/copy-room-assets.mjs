import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const output = join(process.cwd(), "self-host-dist");
mkdirSync(output, { recursive: true });
for (const name of ["favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "manifest.webmanifest"]) {
  cpSync(join(process.cwd(), "public", name), join(output, name));
}
