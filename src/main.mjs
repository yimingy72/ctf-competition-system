import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { ContestRun } from "./coordinator.mjs";
import { acquireRunLock } from "./run-lock.mjs";

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--help")) {
    console.log("Usage: node src/main.mjs --config /path/to/config.json\n"
      + "CTF_CONFIG_PATH may supply the same explicit configuration path.\n"
      + "Platform-hosted launches may instead inject SOLVER_MODEL_API_KEY, "
      + "SOLVER_MODEL_BASE_URL, SOLVER_MODEL_ID and SOLVER_MODEL_API.");
    return;
  }
  let configPath = env.CTF_CONFIG_PATH;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--config" && argv[index + 1]) configPath = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  const config = await loadConfig({ configPath, env });
  let run;
  let stopRequested = null;
  let lockLostError = null;
  const stopping = reason => {
    stopRequested ??= reason;
    if (!run) return;
    void run.stop(stopRequested).catch(error => console.error(error.message));
  };
  const release = await acquireRunLock(config.workDir, {
    onLost: error => {
      lockLostError ??= error;
      stopping("run_lock_lost");
    },
  });
  const onTerm = () => stopping("SIGTERM");
  const onInt = () => stopping("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  try {
    run = await ContestRun.create(config);
    if (lockLostError) throw lockLostError;
    if (stopRequested) void run.stop(stopRequested).catch(error => console.error(error.message));
    await run.start();
    const result = await run.finished;
    if (lockLostError) throw lockLostError;
    console.log(JSON.stringify({ status: "stopped", reason: result.reason, receipt: result.receipt ?? null }));
  } finally {
    try { await run?.stop("shutdown"); }
    finally {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      await release();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ status: "error", code: error.code ?? "operation_failed", message: error.message }));
    process.exitCode = 1;
  });
}
