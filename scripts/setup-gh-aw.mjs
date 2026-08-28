import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installedGhAwVersion, parseGhAwVersion } from "./gh-aw-version.mjs";

const PIN_PATH = ".github/aw/gh-aw-version";

export function setupGhAw({
  readPin = () => readFileSync(PIN_PATH, "utf8").trim(),
  install = execFileSync,
  remove = execFileSync,
  extensionInstalled = () => execFileSync("gh", ["extension", "list"], { encoding: "utf8" })
    .split("\n")
    .some((line) => line.split(/\s+/).includes("github/gh-aw")),
  version = installedGhAwVersion,
  log = console.log,
} = {}) {
  const wanted = readPin();

  parseGhAwVersion(`gh aw version ${wanted}`);
  const installed = extensionInstalled() ? version() : null;
  if (installed === wanted) {
    log(`gh-aw ${wanted} already installed.`);
    return wanted;
  }

  if (installed !== null) remove("gh", ["extension", "remove", "gh-aw"], {
    stdio: "inherit",
  });
  install("gh", ["extension", "install", "github/gh-aw", "--pin", wanted], {
    stdio: "inherit",
  });

  const verified = version();
  if (verified !== wanted) {
    throw new Error(`installed gh-aw ${verified}, expected ${wanted}`);
  }
  log(`gh-aw ${wanted} installed.`);
  return wanted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupGhAw();
}
