#!/usr/bin/env node
/** Bump every packages/*\/package.json to the OSS-publish-ready shape:
 *    version       0.0.0 → <NEW_VERSION>
 *    private       removed (npm scoped packages default to private; the
 *                  publishConfig.access below opts each one in to public)
 *    license       Apache-2.0
 *    publishConfig { access: "public" }
 *    repository    github.com/logtura/logtura, with a directory pointer
 *                  so npmjs.com renders the right link per package
 *    homepage      same repo + #readme
 *    bugs          same repo + /issues
 *    author        Erik Aronesty (Logtura)
 *    files         keeps existing entries, ensures LICENSE is included
 *
 *  Idempotent — re-run safe after any version bump or new package.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NEW_VERSION = process.argv[2] ?? "0.1.0";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES_DIR = join(__dirname, "..", "packages");

const REPO_URL = "https://github.com/logtura/logtura";

for (const name of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  if (name.name === "node_modules") continue;
  const pkgPath = join(PACKAGES_DIR, name.name, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }

  pkg.version = NEW_VERSION;
  delete pkg.private;
  pkg.license = "Apache-2.0";
  pkg.author = "Erik Aronesty (Logtura)";
  pkg.repository = {
    type: "git",
    url: `git+${REPO_URL}.git`,
    directory: `packages/${name.name}`,
  };
  pkg.homepage = `${REPO_URL}#readme`;
  pkg.bugs = { url: `${REPO_URL}/issues` };
  pkg.publishConfig = { access: "public" };

  // Make sure LICENSE + README ship inside the npm tarball alongside
  // src/. files: ["src"] alone would exclude them, which npm
  // tolerates but warns about.
  const files = new Set(pkg.files ?? ["src"]);
  files.add("LICENSE");
  files.add("README.md");
  pkg.files = [...files];

  // Stable key order for diff sanity.
  const ordered = {};
  const head = [
    "name",
    "version",
    "description",
    "license",
    "author",
    "homepage",
    "repository",
    "bugs",
    "type",
    "main",
    "types",
    "exports",
    "files",
    "scripts",
    "publishConfig",
    "peerDependencies",
    "dependencies",
    "devDependencies",
  ];
  for (const k of head) if (k in pkg) ordered[k] = pkg[k];
  for (const k of Object.keys(pkg)) if (!(k in ordered)) ordered[k] = pkg[k];

  writeFileSync(pkgPath, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`bumped ${pkg.name} → ${NEW_VERSION}`);
}
