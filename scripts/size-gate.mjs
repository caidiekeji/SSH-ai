// HC-01 bundle size gate. Fails the build when bundle artifacts exceed the
// platform limit passed as argv[2] (MB).
//
// argv[3] (optional): comma-separated artifact extensions to check, e.g.
//   "deb,rpm" or "exe,msi" or "dmg,app.tar.gz".
// Rationale (PRD §7 / HC-01): self-contained formats that bundle the system
// webview (Linux AppImage) are excluded from the gate; deb/rpm are the
// reference "installer" format matching the PRD's size targets.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const maxMB = Number(process.argv[2] || 30);
const extFilter = (process.argv[3] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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
    // Only final installers under a bundle/ directory count — intermediate
    // build artifacts (build scripts, dep binaries) are not installers.
    else if (p.replace(/\\/g, "/").includes("/bundle/") && /\.(exe|msi|dmg|deb|AppImage|app\.tar\.gz|rpm)$/.test(e.name)) out.push(p);
  }
  return out;
}

const allowed = (f) =>
  extFilter.length === 0 || extFilter.some((ext) => f.endsWith(ext));

const artifacts = walk(bundleDir).filter(allowed);
if (artifacts.length === 0) {
  console.error(`size-gate: no bundle artifacts found (filter: ${extFilter.join(",") || "none"})`);
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
