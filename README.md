# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/knownmyface/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/knownmyface/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge — a GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack protocol v2 + receive-pack v0), REST v3, GraphQL v4, and MCP, over a single in-memory store with cached advertisements, cached packs, and cached issue responses for the fast paths. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib`, and its own modules only, and the trial has no package manager and no internet.

`MAKEFUN_ENV_URL` names the env's origin (the trial harness sets it). Without it the process exits 1, as the starter's lifecycle requires. `MAKEFUN_SHOP_TOKEN` is the bearer token the forge enforces on REST, GraphQL, MCP, and git endpoints; `/healthz`, `GET /api/v3/`, and `GET /api/v3/meta` answer without it, as on api.github.com.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1d5x2a29&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
