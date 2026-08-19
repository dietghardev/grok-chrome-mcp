// The extension lives beside this package in the repo, but npm cannot pack a
// sibling directory. Copy it in for the tarball, then remove it again so the
// working tree keeps one copy of the truth.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const staged = path.join(here, "..", "extension");
const source = path.join(here, "..", "..", "extension");

const docs = ["README.md", "LICENSE"].map((name) => ({
  from: path.join(here, "..", "..", name),
  to: path.join(here, "..", name),
}));

if (process.argv.includes("--clean")) {
  fs.rmSync(staged, { recursive: true, force: true });
  for (const doc of docs) fs.rmSync(doc.to, { force: true });
  console.log("prepack: removed staged copies");
} else {
  if (!fs.existsSync(path.join(source, "manifest.json"))) {
    console.error(`prepack: no extension at ${source}`);
    process.exit(1);
  }
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(source, staged, { recursive: true });
  const { version } = JSON.parse(
    fs.readFileSync(path.join(staged, "manifest.json"), "utf8"),
  );
  for (const doc of docs) fs.copyFileSync(doc.from, doc.to);
  console.log(`prepack: staged extension v${version} plus README and LICENSE`);
}
