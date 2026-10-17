// HC-01 bundle size gate. Fails the build when any bundle artifact exceeds
// the platform limit passed as argv[2] (MB).

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const maxMB = Number(process.argv[2] || 30);
const bundleDir = "src-tauri/target";

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(exe|msi|dmg|deb|AppImage|app\.tar\.gz)$/.test(e.name)) out.push(p);
  }
  return out;
}

const artifacts = walk(bundleDir);
if (artifacts.length === 0) {
  console.error("size-gate: no bundle artifacts found");
  process.exit(1);
}

let failed = false;
for (const f of artifacts) {
  const mb = statSync(f).size / (1024 * 1024);
  const ok = mb <= maxMB;
  console.log(`${ok ? "PASS" : "FAIL"}  ${mb.toFixed(2)} MB / ${maxMB} MB  ${f}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
