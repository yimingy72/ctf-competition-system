import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

test("CLI help exits successfully without configuration or model requests", () => {
  const result = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8", env: {}, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node src\/main\.mjs --config/);
  assert.match(result.stdout, /CTF_CONFIG_PATH/);
  assert.match(result.stdout, /SOLVER_MODEL_API_KEY/);
});

test("CLI missing explicit configuration exits with an actionable error", () => {
  const result = spawnSync(process.execPath, [entrypoint], { encoding: "utf8", env: {}, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const errorLine = result.stderr.trim().split(/\r?\n/)
    .filter((line) => line.startsWith('{"status":"error"'))
    .at(-1);
  assert.ok(errorLine, result.stderr);
  const error = JSON.parse(errorLine);
  assert.equal(error.status, "error");
  assert.equal(error.code, "operation_failed");
  assert.match(error.message, /Pass --config or set the hosted SOLVER_MODEL_\* environment variables/);
});
