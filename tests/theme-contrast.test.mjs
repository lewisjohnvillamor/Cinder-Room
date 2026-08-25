import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dark mode is present in initial HTML and owns readable foreground tokens", async () => {
  const [layout, css] = await Promise.all([
    readFile("app/layout.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);

  assert.match(layout, /<html[^>]+data-theme="dark"/);
  assert.match(css, /\[data-theme="dark"\][\s\S]*?--ink:\s*#f1f1e9/);
  assert.match(css, /--panel:\s*var\(--surface\)/);
  assert.match(css, /\.message-copy\s*\{[\s\S]*?color:\s*var\(--ink\)/);
  assert.match(css, /\.file-name\s*\{[\s\S]*?color:\s*var\(--ink\)/);
  assert.match(css, /\.brand strong\s*\{[\s\S]*?color:\s*var\(--ink\)/);
});
