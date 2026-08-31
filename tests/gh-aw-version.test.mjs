import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { installedGhAwVersion, parseGhAwVersion } from "../scripts/gh-aw-version.mjs";
import { setupGhAw } from "../scripts/setup-gh-aw.mjs";

const cases = [
  ["stdout stable", "gh aw version v0.86.2", "v0.86.2"],
  ["stderr prerelease", "gh aw version v1.2.3-rc.1", "v1.2.3-rc.1"],
  ["build metadata", "gh aw version v1.2.3-alpha.1+build.007", "v1.2.3-alpha.1+build.007"],
  ["numeric prerelease", "gh aw version v1.2.3-0", "v1.2.3-0"],
  ["leading major zero", "gh aw version v01.2.3", null],
  ["leading minor zero", "gh aw version v1.02.3", null],
  ["leading patch zero", "gh aw version v1.2.03", null],
  ["leading prerelease zero", "gh aw version v1.2.3-01", null],
  ["leading whitespace", " gh aw version v1.2.3", null],
  ["trailing whitespace", "gh aw version v1.2.3 ", null],
  ["incomplete", "gh aw version v1.2", null],
  ["unexpected output", "unexpected gh output", null],
];

test("parseGhAwVersion accepts only canonical gh-aw version output", () => {
  for (const [name, output, expected] of cases) {
    if (expected) assert.equal(parseGhAwVersion(output), expected, name);
    else assert.throws(() => parseGhAwVersion(output), undefined, name);
  }
});

test("installedGhAwVersion accepts either output stream", () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = { status: 0, stdout: "", stderr: "" };
    result[stream] = "gh aw version v0.86.2\n";
    assert.equal(installedGhAwVersion(() => result), "v0.86.2", stream);
  }
});

test("setupGhAw installs or retains the selected version", () => {
  const cases = [
    ["absent", null, ["v0.86.2"], [["install", "v0.86.2"]], "gh-aw v0.86.2 installed."],
    ["exact", "v0.86.2", ["v0.86.2"], [], "gh-aw v0.86.2 already installed."],
    ["older", "v0.86.1", ["v0.86.1", "v0.86.2"], [["remove"], ["install", "v0.86.2"]], "gh-aw v0.86.2 installed."],
    ["newer", "v0.87.10", ["v0.87.10", "v0.86.2"], [["remove"], ["install", "v0.86.2"]], "gh-aw v0.86.2 installed."],
  ];

  for (const [name, installed, versions, expectedCalls, expectedLog] of cases) {
    const calls = [];
    const logs = [];
    assert.equal(setupGhAw({
      readPin: () => "v0.86.2",
      extensionInstalled: () => installed !== null,
      install: (_command, args) => calls.push(["install", args.at(-1)]),
      remove: () => calls.push(["remove"]),
      version: () => versions.shift(),
      log: (message) => logs.push(message),
    }), "v0.86.2", name);
    assert.deepEqual(calls, expectedCalls, name);
    assert.deepEqual(logs, [expectedLog], name);
  }
});

test("setupGhAw propagates setup command failures and rejects a bad installation", () => {
  const cases = [
    ["extension lookup", () => { throw new Error("list failed"); }, () => "v0.86.2", () => {}, () => {}, /list failed/],
    ["installed version", () => true, () => { throw new Error("version failed"); }, () => {}, () => {}, /version failed/],
    ["removal", () => true, () => "v0.86.1", () => { throw new Error("remove failed"); }, () => {}, /remove failed/],
    ["installation", () => false, () => "v0.86.2", () => {}, () => { throw new Error("install failed"); }, /install failed/],
    ["post-install version", () => false, () => "v0.86.3", () => {}, () => {}, /installed gh-aw v0\.86\.3, expected v0\.86\.2/],
  ];

  for (const [name, extensionInstalled, version, remove, install, expected] of cases) {
    assert.throws(() => setupGhAw({
      readPin: () => "v0.86.2",
      extensionInstalled,
      version,
      remove,
      install,
      log: () => {},
    }), expected, name);
  }
});

function embeddedInstallScript(workflow) {
  const marker = "        shell: node {0}\n        run: |\n";
  const start = workflow.indexOf(marker);
  const end = workflow.indexOf("\n\n      - name: Update action-version pins", start);

  assert.notEqual(start, -1, "upgrade workflow has a Node install step");
  assert.notEqual(end, -1, "upgrade workflow has a following maintenance step");
  const script = workflow.slice(start + marker.length, end).split("\n");
  return script.map((line) => {
    if (line === "") return line;
    assert.ok(line.startsWith("          "), `embedded script indentation: ${line}`);
    return line.slice(10);
  }).join("\n");
}

function runEmbeddedInstall(workflow, output) {
  const directory = mkdtempSync(join(tmpdir(), "gh-aw-version-test-"));
  const ghPath = join(directory, "gh");
  const scriptPath = join(directory, "install");
  const callsPath = join(directory, "gh-calls.jsonl");

  writeFileSync(ghPath, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "aw" && args[1] === "version") process.stdout.write(process.env.GH_VERSION_OUTPUT);
`);
  chmodSync(ghPath, 0o755);
  writeFileSync(scriptPath, embeddedInstallScript(workflow));

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_AW_VERSION: "v0.86.2",
      GH_CALLS: callsPath,
      GH_VERSION_OUTPUT: output,
      PATH: `${directory}:${process.env.PATH}`,
    },
  });
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
  const pinPath = join(directory, ".github/aw/gh-aw-version");
  const pinExists = existsSync(pinPath);
  const pin = pinExists ? readFileSync(pinPath, "utf8") : null;
  rmSync(directory, { recursive: true, force: true });
  return { result, calls, pin, pinExists };
}

test("included upgrade workflow installs, verifies, and writes its synchronized pin", () => {
  const pin = readFileSync(".github/aw/gh-aw-version", "utf8").trim();
  const workflow = readFileSync(".github/workflows/upgrade.yml", "utf8");
  const pinLine = workflow.split("\n").find((line) => line.startsWith("  GH_AW_VERSION: "));

  assert.equal(pinLine, `  GH_AW_VERSION: ${pin}`);
  const { result, calls, pin: writtenPin } = runEmbeddedInstall(workflow, `gh aw version ${pin}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    ["extension", "install", "github/gh-aw", "--pin", pin, "--force"],
    ["aw", "version"],
  ]);
  assert.equal(writtenPin, `${pin}\n`);
});

test("included upgrade workflow stops before writing its pin on a version mismatch", () => {
  const workflow = readFileSync(".github/workflows/upgrade.yml", "utf8");
  const { result, calls, pin, pinExists } = runEmbeddedInstall(workflow, "gh aw version v0.86.3\n");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected gh aw version v0\.86\.2/);
  assert.deepEqual(calls, [
    ["extension", "install", "github/gh-aw", "--pin", "v0.86.2", "--force"],
    ["aw", "version"],
  ]);
  assert.equal(pin, null);
  assert.equal(pinExists, false);
});
