// Forge entrypoint: the process the trial boots. It starts the forge server on an
// ephemeral port, announces that port to the trial environment, and then stays
// alive until the environment reports the trial is finished.
//
// The forge itself is app.ts; this file only owns the handshake with the env:
//   * MAKEFUN_ENV_URL must name the env origin. Without it there is nothing to
//     register with, so the process leaves with status 1 right away.
//   * The server listens on port 0 and the kernel picks a free one. Port 8080 is
//     the env's own listener and must never be bound here.
//   * POST /register carries {"port": N}. The env dials the address the request
//     came from plus N. A 409 only means a first registration already won.
//   * GET /done is polled until it answers {"done": true}. The env replies at
//     once while the suite runs, so this is a short poll, retried on failure.
//   * Once done, the server closes and the process leaves with status 0.

import { createApp as buildForgeServer } from "./app.ts";

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (ENV_ORIGIN === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is not set; there is no env to register with\n");
  process.exit(1);
}

/** Longest a single register or done request may run before it is dropped and retried. */
const REQUEST_BUDGET_MS = 30_000;
/** First pause between retries, and the ceiling it grows to. */
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Pause after `failures` failed attempts: exponential from BACKOFF_START_MS, capped. */
function backoffAfter(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

/**
 * Announce the bound port to the env and wait until it is accepted. A 200 is the
 * normal answer and a 409 means the first registration already won, which is not
 * this process's problem. A 400 or 405 is a contract error and ends the process;
 * anything else (a network error, a timeout, another status) is retried, because
 * the env may still be coming up.
 */
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let outcome: "accepted" | "refused" | "retry" = "retry";
    let refusal = "";
    try {
      const payload = JSON.stringify({ port });
      const response = await fetch(`${ENV_ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.status === 200 || response.status === 409) {
        outcome = "accepted";
      } else if (response.status === 400 || response.status === 405) {
        outcome = "refused";
        refusal = await response.text();
      }
    } catch {
      // No answer, or the request timed out: the env is not reachable yet.
    }
    if (outcome === "accepted") {
      return;
    }
    if (outcome === "refused") {
      throw new Error(`env refused registration: ${refusal}`);
    }
    await pause(backoffAfter(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return any earlier. */
async function awaitFinished(): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const response = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        finished = payload.done === true;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done.
    }
    if (finished) {
      return;
    }
    await pause(backoffAfter(failures));
    failures += 1;
  }
}

/** Boot the server, announce it, then wait for the env: the whole life of the process. */
async function boot(): Promise<void> {
  const server = buildForgeServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("the forge server did not bind an ephemeral TCP port"));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[forge] listening on ${port}\n`);

  await announce(port);
  process.stdout.write("[forge] registered with the trial env\n");

  await awaitFinished();
  server.close();
  process.stdout.write("[forge] trial done\n");
}

boot().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
