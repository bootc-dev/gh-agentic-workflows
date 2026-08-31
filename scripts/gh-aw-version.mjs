import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SEMVER =
  "v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const VERSION_OUTPUT = new RegExp(`^gh aw version (${SEMVER})$`);

export function parseGhAwVersion(output) {
  const match = VERSION_OUTPUT.exec(output.replace(/\r?\n$/, ""));
  if (!match || match[5]?.split(".").some((identifier) => /^0[0-9]+$/.test(identifier))) {
    throw new Error(`could not determine the installed gh-aw version: ${output}`);
  }
  return match[1];
}

export function installedGhAwVersion(run = () => spawnSync("gh", ["aw", "version"], { encoding: "utf8" })) {
  const result = run();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh aw version exited with status ${result.status}`);
  return parseGhAwVersion(`${result.stdout}${result.stderr}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${installedGhAwVersion()}\n`);
}
