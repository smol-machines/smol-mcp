# smol-mcp

An MCP server over smol machines, on the official TypeScript SDK
(`@modelcontextprotocol/sdk`, pinned exactly), stdio transport, one tool
vocabulary for two targets.

Every tool takes a `target` argument:

- `local` talks to `smolvm serve`'s HTTP API on this host. The server starts
  the serve itself and stops it on exit, or uses one that is already listening
  and leaves it running.
- `cloud` talks to the smol cloud REST API at `$SMOL_CLOUD_URL` with
  `Authorization: Bearer $SMOL_CLOUD_TOKEN`.

The two APIs agree about almost nothing. A machine is a name locally and a
`mach-...` id on cloud; the image is a string locally and a tagged `source`
object on cloud; env is a list of `{name, value}` locally and a map on cloud;
exec takes `workdir`/`timeoutSecs` locally and `cwd`/`timeoutSeconds` on
cloud; list returns `{machines: [...]}` locally and a bare array on cloud.
All of that is normalised in the two clients, so a tool call has the same
shape whichever target answers it.

## Tools

| Tool | Targets | Notes |
|---|---|---|
| `list-machines` | local, cloud | |
| `get-machine` | local, cloud | Cloud resolves a name to an id with one extra list call. |
| `create-machine` | local, cloud | Starts the machine and waits until commands run in it. |
| `run-command` | local, cloud | Returns `{stdout, stderr, exitCode, truncated, timedOut}`. |
| `run-once` | local, cloud | Create, start, exec, delete. Deletes the machine even on timeout. |
| `read-file` | local, cloud | |
| `write-file` | local, cloud | Waits for readiness first, so the file is not written under a mount that later hides it. |
| `stop-machine` | local, cloud | |
| `delete-machine` | local, cloud | |
| `machine-logs` | local | The cloud API has an event log, not a console log. |
| `pull-image` | local | The cloud control plane pulls the image itself at create. |

A machine whose name starts with `mcp-` is ephemeral: this server records it
and deletes it when the client's stdin closes. A name you choose yourself
persists.

## Install and run

```bash
npm install
npm run build
node dist/cli.js          # speaks MCP on stdin/stdout
```

As an MCP server entry:

```json
{
  "mcpServers": {
    "smol": {
      "command": "node",
      "args": ["/abs/path/to/smol-mcp/dist/cli.js"],
      "env": { "SMOL_CLOUD_TOKEN": "..." }
    }
  }
}
```

`smolvm` is only needed for the local target. The serve is started on the
first local call, not at connect, so a client that only ever names `cloud`
never launches a hypervisor.

## Running the server somewhere else

The same eleven tools are served over the official SDK's Streamable HTTP
transport by a second bin. stdio is the default and is untouched by it: no
port, no token, no listener.

```bash
SMOL_MCP_AUTH_TOKEN=$(openssl rand -hex 16) \
  node dist/http-cli.js --host 0.0.0.0 --port 8080 --path /mcp
```

- **It refuses to start without `SMOL_MCP_AUTH_TOKEN`**, and every request
  needs it. These tools create and run virtual machines, so a listener without
  a token is a remote shell.
- The token is read from `authorization: Bearer ...` **or**
  `x-smol-mcp-token`. The second header is there for a deployment that puts
  something else in `authorization` before the request reaches this server.
- The bind is `127.0.0.1` by default. Publishing the port is a decision to
  make in the open, not the consequence of a default.
- Replies are plain JSON rather than an SSE frame per response
  (`enableJsonResponse`), because the reply travels through a proxy whose
  buffering is not ours and no tool here streams.
- Each session gets its own server instance, and ending the session (an HTTP
  DELETE) deletes that session's ephemeral machines, the way stdin EOF does on
  stdio. **The local target's ephemeral state file is shared between sessions**,
  so run the HTTP transport for the cloud target; that is the case it is for.

### Hosting it in a smol machine

Two shapes, both run end to end; see Verified.

**Agent inside the machine.** `npm pack` on this host, upload the tarball
through `POST /v1/machines/{id}/exec` with the base64 on stdin, `npm install`
it in the guest, and speak stdio to `dist/cli.js` there. The account key goes
in the machine's create-time `env` and is in the guest process environment.
The local target is unavailable inside a guest and says so on the first call.

**Agent outside the machine.** Publish port 8080 at create, run
`dist/http-cli.js` on `0.0.0.0`, and connect with the SDK's
`StreamableHTTPClientTransport` to `https://<name>-<hash>.apps.smolmachines.com/mcp`,
the ingress URL the machine record's `url` field carries once it is ready.
This shape needs open egress anyway, to reach the smol cloud API.

## Defaults, and why each one is what it is

Settable by env var, or by a JSON config file at
`$XDG_CONFIG_HOME/smol-mcp/config.json` (or `$SMOL_MCP_CONFIG`). Precedence is
env over file over default. An unknown key in the config file is an error
rather than a silent no-op, because the local API's own habit of accepting and
dropping unknown fields is exactly the failure this avoids.

| Setting | Env | Default | Why |
|---|---|---|---|
| memory | `SMOL_MCP_MEMORY_MB` | 2048 MiB | Enough for an interpreter and a build; small enough to boot several at once. |
| cpus | `SMOL_MCP_CPUS` | 2 | One core leaves nothing for the guest agent while a command runs. |
| exec timeout | `SMOL_MCP_EXEC_TIMEOUT_SECS` | 120 s | Long enough for a package install, short enough that a hung command does not hold a tool call open. |
| output truncation | `SMOL_MCP_MAX_OUTPUT_BYTES` | 64 KiB per stream | A tool result is read by a model with a context budget; past this the tail stops carrying information. Truncation is reported, never silent. |
| readiness timeout | `SMOL_MCP_READY_TIMEOUT_SECS` | 120 s | Covers a cold image pull inside the guest. |
| run-once network (local) | `SMOL_MCP_RUN_ONCE_NETWORK` | `open` | See below. |
| ephemeral TTL | `SMOL_MCP_EPHEMERAL_TTL_SECS` | 3600 s | Sent as `ttlSeconds` where the API has one, so a killed server cannot leave a cloud machine billing forever. |
| machine prefix | `SMOL_MCP_MACHINE_PREFIX` | `mcp-` | The marker that makes a machine ephemeral. |
| HTTP bind | `SMOL_MCP_HTTP_HOST` | `127.0.0.1` | HTTP transport only. Publishing the listener is a decision, not a default. |
| HTTP port | `SMOL_MCP_HTTP_PORT` | 8080 | HTTP transport only. What a smol machine publishes by default. |
| HTTP path | `SMOL_MCP_HTTP_PATH` | `/mcp` | HTTP transport only. Everything else on the listener is a 404. |
| HTTP token | `SMOL_MCP_AUTH_TOKEN` | none | HTTP transport only, and required: it refuses to start without one. |

### Security defaults, stated as reasons

- **The local API has no authentication.** Anything that can reach it can
  create a VM on this host. So the server listens on a Unix socket in its own
  runtime directory (mode 0700) by default, and refuses outright to start a
  serve on a non-loopback address.
- **Nothing runs on the host outside a VM.** Every command a tool executes
  goes through the machine API into a guest. The server spawns exactly one
  host process, `smolvm serve`, and only when a local tool is called.
- **The token is read from the environment and never written anywhere.** It is
  not logged, not echoed in an error, and `.env` is in `.gitignore`.
- **`run-once` on cloud denies egress by default**, and never publishes a port.
  See the network section.
- **The HTTP transport authenticates every request and refuses to start
  without a token.** Not a warning, not a default token: the process exits.

### The run-once network default is not the same on both targets

The design intent is no egress for a throwaway command. Cloud can do that;
local cannot, and the reason is worth stating rather than hiding.

**Local.** The image is pulled from a registry *inside the guest*, so a
machine with no egress can never start. The API says so at create time:

```
image 'alpine' must be pulled from a registry, but this machine has no
network, so the pull can never succeed. Add --net (or publish a port with -p,
or set an egress policy with --allow-cidr/--allow-host). To keep the machine
network-isolated, supply the image locally instead: `docker save alpine |
smolvm machine create --image - ...`
```

An egress allow-list is accepted and is genuinely enforced, including on the
pull. That sounds like the answer, and it is a trap: the blob CDN host is not
knowable in advance. Allow-listing docker.io's documented hosts produced

```
dial tcp: lookup production.cloudfront.docker.com ...: no such host
```

because the CDN name is neither `docker.io` nor any of the hosts the docs
name. So the shipped local default is `open`, and `allowHosts`/`allowCidrs`
are exposed on `create-machine` and `run-once` for a caller who knows which
hosts their image and workload need.

**Cloud.** The control plane pulls the image, so the guest never needs the
registry, and `run-once` denies egress with no configuration. One API fact
shapes how the deny is spelled: `{"mode": "allowCidrs", "cidrs": []}` is
refused with `HTTP 400 allowCidrs network mode requires at least one CIDR or
host`.

So the deny is an allow-list of `192.0.2.0/24`, RFC 5737 TEST-NET-1, reserved
for documentation and routed nowhere, and the integration test asserts it from
inside the guest on the byte count rather than on an exit code.

## Constraints this server is built around

Each one has a test.

| | Constraint | Covered by |
|---|---|---|
| a | A local file upload must wait until the workload container is running, or it lands in the agent's namespace and is hidden once the container mounts over the path. | `test/unit/machines.test.ts` asserts the upload call comes after a successful exec; `test/integration/local.test.ts` and `cloud.test.ts` assert the guest reads its own bytes back. |
| b | `run-command` reads `{stdout, stderr, exitCode}` from the body, never from the HTTP status: both APIs answer 200 for a command that exited non-zero. | `test/unit/client.test.ts`, `test/unit/cloud-client.test.ts`, and a real `exit 42` in both integration suites. |
| c | Local parity is stated by the paths this server calls, not by `serve openapi`'s `info.version`, which is hardcoded at `0.5.2` on a v1.14.3 binary. | `src/parity.ts`, asserted in `test/integration/local.test.ts` including the assertion that `info.version` is *not* the version. |
| d | The local create field is `network`, not `net`, and `memoryMb`, not `memory`. | `test/unit/client.test.ts` asserts the exact request body; `test/unit/tools.test.ts` asserts the CLI spellings are stripped by the schema. |
| e | The cloud connect bridge answers `allow: GET,HEAD`, so an MCP client cannot reach a guest through it; the machine's ingress URL carries POST. | Not a unit test: `test/unit/http-transport.test.ts` covers the transport, and the Verified section records the probe. |
| f | A server hosted behind an ingress cannot assume `authorization` is free for a token of its own. | `test/unit/http-transport.test.ts` initializes a session with another credential in `authorization` and the server token in `x-smol-mcp-token`. |

Two more, from the same source:

- `run-once` uses the plain path only: create, start, exec, delete. Never
  `--oci-cache`, never `init` (broken by smol-machines/smolvm#1192 and #1193).
- The settled cloud bill comes from `DELETE /v1/machines/{id}?includeUsage=true`.
  A mid-life `/usage` read is a documented lower bound.

## Tests

```bash
npm run lint         # eslint, plus a check that no em or en dash is tracked
npm run typecheck    # src and test
npm run test:unit    # no smolvm, no network, no key
```

Integration is opt-in, so a clean clone on a host with no hypervisor and no
key can still run `npm test`.

```bash
# local: needs smolvm on PATH or in SMOLVM
SMOL_MCP_IT=1 npm run test:integration

# cloud: additionally needs SMOL_CLOUD_TOKEN and SMOL_CLOUD_URL
SMOL_MCP_IT=1 npm run test:cloud
```

The cloud suite reads `GET /v1/account` before it creates anything and after
every test, and fails the moment period spend passes USD 1.00. It deletes what
it makes in the test that makes it, and its `afterAll` asserts no `mcp-`
machine is left on the fleet.

## Verified

Run on 2026-09-08 against smolvm **v1.14.3** (isolated install, `HOME` not the
real one) on macOS 26.6.2 Apple Silicon, and against smol cloud at
`https://api.smolmachines.com`.

The whole suite was run twice from a clean state. Both runs: **8 files, 69
tests, all passed** (56 unit, 7 local integration, 2 stdio EOF, 4 cloud). The
second run started with no serve listening, an empty ephemeral-state file,
`smolvm machine list` reporting `No machines found`, and `GET /v1/machines`
returning `[]`; it ended the same way, and its own `afterAll` reported
`leaked=0`.

Cloud spend was read from `GET /v1/account` before and after each run.
`periodCost.totalMicros` moved by a two-figure number of micros across both
runs, well under the suite's own 1000000 micro ceiling, and `amountDueMicros`
stayed 0. A lifecycle machine's settled bill comes back from
`DELETE ...?includeUsage=true`.

A real MCP client over stdio, `node scripts/smoke.mjs both`:

```
$ tools/list
list-machines get-machine create-machine run-command run-once read-file write-file stop-machine delete-machine machine-logs pull-image

smol-mcp: started smolvm serve 1.14.3 (pid 14305) at unix:///tmp/.../api.sock
$ tools/call list-machines {"target":"local"}   [0.5s]
{
  "machines": []
}

$ tools/call run-once {"target":"local","image":"alpine","command":"echo hello","cpus":1,"memoryMb":2048}   [2.8s]
{
  "stdout": "hello\n",
  "stderr": "",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "machine": "mcp-once-c3678b7d"
}

$ tools/call list-machines {"target":"cloud"}   [0.2s]
{
  "machines": []
}

$ tools/call run-once {"target":"cloud","image":"alpine:3.20","command":"echo hello","cpus":1,"memoryMb":256}   [2.6s]
{
  "stdout": "hello\n",
  "stderr": "",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "machine": "mcp-once-0c949d8d"
}

smol-mcp: stdin EOF, cleaning up
```

### Hosted in a smol machine: the agent inside it

`mcp-host-a`, `node:22-alpine`, 1 cpu, 256 MiB (the smallest the plan bills
for), `network.mode: "open"`, no published port, `ttlSeconds: 3600` as a
backstop. The account key was passed in the create-time `env` and nothing was
written to a file in the guest. The guest reported `node v22.23.2`,
`Linux 6.12.95 x86_64`, 1 cpu, 264 MiB of RAM, a 19.7 G `/workspace` and a
132 M `/tmp`.

`npm pack` produced a 43929 byte tarball; it went in through
`POST /v1/machines/{id}/exec` with 58572 base64 characters on stdin
(`base64 -d > /opt/mcp/smol-mcp-0.1.0.tgz`, 0.4 s), and the sha256 inside the
guest matched the one on this host. `npm install ./smol-mcp-0.1.0.tgz` added
95 packages in 11 s, 28.1 M of `node_modules`, on one core and 256 MiB.

Then, inside the guest, `node scripts/smoke.mjs guest`:

```
$ tools/list
list-machines get-machine create-machine run-command run-once read-file write-file stop-machine delete-machine machine-logs pull-image

$ tools/call list-machines {"target":"local"}   [0.0s]
ERROR LOCAL_UNAVAILABLE: the local target is unavailable on this host: this host has no /dev/kvm, so it cannot start a virtual machine; a smol machine guest has neither, so use target "cloud" from inside one

$ tools/call list-machines {"target":"cloud"}   [0.2s]
{
  "machines": [
    {
      "id": "mach-0123456789abcdef0123456789abcdef",
      "name": "mcp-host-a",
      "state": "started",
      "cpus": 1,
      "memoryMb": 256,
      "network": "open",
      "createdAt": 1788890678,
      "image": "node:22-alpine",
      "pid": null
    }
  ]
}

$ tools/call run-once {"target":"cloud","image":"alpine:3.20","command":"echo hello","cpus":1,"memoryMb":256}   [2.4s]
{
  "stdout": "hello\n",
  "stderr": "",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "machine": "mcp-once-663eaef8"
}

smol-mcp: stdin EOF, cleaning up
```

The local refusal is instant (0.0 s) and names the reason. The machine it
created from inside itself was deleted by `run-once` before the call returned,
and `DELETE ...?includeUsage=true` returned its settled uptime and cost.

### Hosted in a smol machine: the agent outside it

`mcp-host-b`, same image and size, `"ports": [{"port": 8080}]`,
`network.mode: "open"`, `ttlSeconds: 3600`. Started with
`node dist/http-cli.js --host 0.0.0.0 --port 8080`, `SMOL_MCP_AUTH_TOKEN` from
the create-time env:

```
smol-mcp: listening for MCP over HTTP on http://0.0.0.0:8080/mcp
smol-mcp: http session 0e81a1cc-a105-4256-b9ff-56513e2ae565 opened (1 open)
```

Once something listened, the record reported `ready: true` and allocated
`url: https://mcp-host-b-0123456789ab.apps.smolmachines.com`. From this Mac,
`node scripts/smoke-http.mjs https://mcp-host-b-0123456789ab.apps.smolmachines.com/mcp`:

```
$ connect https://mcp-host-b-0123456789ab.apps.smolmachines.com/mcp   [0.7s]
session 0e81a1cc-a105-4256-b9ff-56513e2ae565

$ tools/list
list-machines get-machine create-machine run-command run-once read-file write-file stop-machine delete-machine machine-logs pull-image

$ tools/call list-machines {"target":"cloud"}   [0.4s]
{
  "machines": [
    {
      "id": "mach-fedcba9876543210fedcba9876543210",
      "name": "mcp-host-b",
      "state": "started",
      "cpus": 1,
      "memoryMb": 256,
      "network": "open",
      "createdAt": 1788890992,
      "image": "node:22-alpine",
      "pid": null
    }
  ]
}

$ tools/call run-once {"target":"cloud","image":"alpine:3.20","command":"echo hello","cpus":1,"memoryMb":256}   [2.7s]
{
  "stdout": "hello\n",
  "stderr": "",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "machine": "mcp-once-192ed9dc"
}

smol-mcp: session terminated
```

Both gates were provoked, from this Mac, against the same URL:

```
account key, no server token     -> 401 {"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized: ..."}}
account key, wrong server token  -> 401 (same)
server token, no account key     -> 401 Unauthorized: a smolmachines login is required to reach this app
```

The first two are this server; the third is the ingress, which never reaches
it.

Neither shape can be reached through the documented connect bridge. With a
server listening on the published port,
`GET /v1/machines/{id}/connect/8080/mcp` is a 200 that arrives in the guest as
`GET /mcp`, but `POST` to the same URL is **405 with `allow: GET,HEAD`**, and
so is `DELETE`. MCP needs POST, so the ingress URL is the route.

Both shapes together cost a four-figure number of micros, `amountDueMicros`
stayed 0, and `GET /v1/machines` returned `[]` afterwards.

## Traps

- **Only one `smolvm serve` can run per host**: it binds `127.0.0.1:10081` for
  the guest rollout ingress. If a start fails with `Address already in use`,
  set `SMOL_LOCAL_URL` to the running serve's listen address; this server will
  then use it and leave it running.
- **`smolvm` is a wrapper script that `exec`s `smolvm-bin`**, so
  `pkill -f "smolvm serve"` does not match a running serve. Look for
  `smolvm-bin`, or for whatever holds port 10081.
- **A failed local start leaves the machine behind** in `created` state. It has
  to be deleted; `run-once` does that on every path.
- **On the cloud API, a 400 does not mean the body was not JSON.** An empty
  `cidrs` is a 400 with a valid JSON body, so status alone does not separate a
  parse failure from a validation one.
- **The cloud files route takes no parameter any published schema names**, and
  a `?path=` guess answers 404 with an empty body. `read-file` and `write-file`
  on cloud go through exec with base64 instead, which is binary-safe and uses
  the same auto-starting path as every other cloud call.
- **The connect bridge is GET and HEAD only.** `POST` to
  `/v1/machines/{id}/connect/{port}/...` is 405 with `allow: GET,HEAD`, so no
  MCP client can speak through it. Use the ingress URL in the machine
  record's `url`. A trailing slash on the bridge (`connect/8080/`) is a 404
  whatever the method, which is a different failure from the 405.
- **The ingress needs the account key.** Without `authorization: Bearer
  <key>` it answers 401, so a server behind an ingress cannot use
  `authorization` for a token of its own. That is what `x-smol-mcp-token` is
  for.
- **`url` and `ready` are both `null`/`false` until something listens on the
  published port.** Start the server first, then wait on readiness, or the
  wait can never end. `ports[].hostPort` is allocated long before either.
- **`npm pack` refuses to overwrite an existing tarball** in
  `--pack-destination`, and it writes to `~/.npm/_cacache` even for a pack.
  In a sandbox that denies either, the failure is an npm error in the middle
  of a pipeline; delete the old tarball and pass `--cache`.
