# smol-mcp

An MCP server for [smol machines](https://smolmachines.com): it gives an AI
agent a virtual machine to work in. The agent creates a machine from an OCI
image, runs commands in it, reads and writes files, branches it, tails its log
and deletes it, all through the tools its client already knows how to call.

**Who it is for.** Anyone running an agent that should not run commands on the
laptop it is running on. The machine is a real microVM, not a container on
your host, and every command a tool executes goes through the machine API into
a guest; this server spawns exactly one host process, `smolvm serve`, and only
when a local tool is called.

Built on the official TypeScript SDK (`@modelcontextprotocol/sdk`, pinned
exactly), with two transports, stdio and Streamable HTTP.

## The two targets, and the three modes

Machines come from one of two fleets:

- **`local`** is `smolvm serve` on the host this server runs on, reached over
  a Unix socket. It needs `smolvm` and a hypervisor. Nothing is billed.
- **`cloud`** is the smol cloud REST API at `$SMOL_CLOUD_URL`, with
  `Authorization: Bearer $SMOL_CLOUD_TOKEN`. Machines run in the service, and
  they cost money for as long as they exist.

**Which of them a process serves is decided once, at startup**, from
`SMOL_MCP_TARGETS` or, when that is unset, from whether a cloud token is
configured:

| Mode | When | What the tools look like |
|---|---|---|
| `local` | no cloud token, or `SMOL_MCP_TARGETS=local` | No `target` argument anywhere. Every call goes to the local fleet. |
| `cloud` | `SMOL_MCP_TARGETS=cloud` | No `target` argument anywhere. Every call goes to the cloud fleet. |
| `both` | a cloud token is configured, or `SMOL_MCP_TARGETS=both` | `target` is required on every tool, with no default. |

There is no default in `both` mode on purpose: a machine on one fleet is
invisible on the other and the two bill differently, so a defaulted argument
sends work to the wrong fleet silently. **A client that supports elicitation is
asked once**, on its first tool call, which fleet the session is for; an answer
of `local` or `cloud` narrows the session and removes the argument from every
tool, which the server reports as a `tools/listChanged`. A client without
elicitation, or one that declines, keeps the required argument.

The server also carries an `instructions` string naming the fleets this
process reaches and what each cannot do, and a `smol://targets` resource with
the same facts as JSON, including whether a served fleet is usable on this
host at all.

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
| `create-machine` | local, cloud | Starts the machine and waits until commands run in it. `ports` and `storageGb` on both targets, `mounts` and `overlayGb` local only, `branchable` to make it a branch source. |
| `run-command` | local, cloud | Returns `{stdout, stderr, exitCode, truncated, timedOut, overflow, startedMachine}`. Output past the budget keeps its head and its tail, and the whole stream is written into the machine at the path `overflow` names. |
| `run-once` | local, cloud | Create, start, exec, delete. Deletes the machine even on timeout. |
| `read-file` | local, cloud | Takes `offset` and `length`; reports the whole file's `size`, the `bytes` returned and whether it reached `eof`. |
| `write-file` | local, cloud | Waits for readiness first, so the file is not written under a mount that later hides it. |
| `start-machine` | local, cloud | Starts a stopped machine and waits until commands run in it. |
| `branch-machine` | local, cloud | Copies a running branchable machine into a new child, memory and disks included. Local needs Linux or macOS, not Windows. |
| `stop-machine` | local, cloud | Start it again with `start-machine`; `create-machine` on an existing name is a conflict. |
| `delete-machine` | local, cloud | |
| `machine-logs` | local, cloud | Local is the guest console. Cloud is the machine's event log from the control plane: what happened to the machine, not what ran in it. |
| `pull-image` | local | The cloud control plane pulls the image itself at create. |

Branching copies a running machine, memory and all, so a child starts from
exactly where its parent was. The source has to be made a branch source when
it is created (`branchable: true` on `create-machine`), and neither target can
turn that on for a machine that already exists. The two ask for it in
different places, which the server handles: locally it is a query parameter on
the start, on cloud a field on the create. **`branch-machine` on the local
target needs Linux or macOS**; `smolvm serve` on Windows does not support it.

On cloud, a command, a read or a write in a stopped machine starts it and
leaves it running. `startedMachine` in the result says when that happened;
`stop-machine` stops it again.

Following a log is a resource subscription: read
`smol://machine/{target}/{name}/logs`, subscribe to it, and the server tells
you when there is more. `machine-logs` with the cursor from the last call
returns what has arrived since.

A machine whose name starts with `mcp-` is ephemeral: the session that created
it records it and deletes it when that session ends, on either target. A name
you choose yourself persists. The local record is a file in the runtime
directory, so the next start can clean up after a crashed one; the cloud
record is in memory, and a process that dies with entries in it leaves them to
the control plane's own idle stop and TTL.

## Install and run

The package is `smol-mcp` on npm, with two bins: `smol-mcp` (stdio) and
`smol-mcp-http` (Streamable HTTP). A client can run it without installing
anything:

```bash
npx -y smol-mcp
```

or install it once, globally or into a project:

```bash
npm install -g smol-mcp
```

From source, for working on it:

```bash
git clone https://github.com/smol-machines/smol-mcp
cd smol-mcp
npm install
npm run build
```

`smolvm` is only needed for the local target, and the serve is started on the
first local call rather than at connect, so a client that only ever names
`cloud` never launches a hypervisor.

## Connecting a client

The stdio transport is the default: the client runs `smol-mcp` and speaks
MCP on its stdin and stdout. The blocks below use `npx -y smol-mcp`, which
fetches the package on first use; with a global install the command is
`smol-mcp` and there are no arguments, and from a source checkout it is `node`
with the absolute path to `dist/cli.js`.

**Claude Code (`.mcp.json`), Claude Desktop (`claude_desktop_config.json`) and
Cursor (`.cursor/mcp.json`)** all take the same shape:

```json
{
  "mcpServers": {
    "smol": {
      "command": "npx",
      "args": ["-y", "smol-mcp"],
      "env": { "SMOL_CLOUD_TOKEN": "..." }
    }
  }
}
```

**OpenCode (`opencode.json`)** uses its own key names:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "smol": {
      "type": "local",
      "command": ["npx", "-y", "smol-mcp"],
      "enabled": true,
      "environment": { "SMOL_CLOUD_TOKEN": "..." }
    }
  }
}
```

The top-level key is `mcp` rather than `mcpServers`, a local server is
`type: "local"`, the command and its arguments are one array, and the
environment is `environment` rather than `env`.

Drop `SMOL_CLOUD_TOKEN` and the server serves the local fleet only. Keep it
and it serves both, and asks once which one the session is for; see the target
modes below.

**What has been driven end to end is the MCP SDK's own `Client`**, over both
transports, by the two scripts in `scripts/`, **and OpenCode 1.18.30**, which
ran the worked example below over stdio and a machine on another host over
HTTP, from the `opencode.json` printed above with no changes. The other three
configurations are read from each client's documentation and not driven.

## Two computers: the agent here, the machines there

The supported shape for an agent on computer A driving machines on computer B
is to run this server **on B**, the machine that has `smolvm`, and connect to
it over the HTTP transport. The local machine API has no authentication of its
own and stays on a Unix socket on B; what crosses the network is this server's
own authenticated endpoint.

The same thirteen tools are served over the official SDK's Streamable HTTP
transport by a second bin. stdio is the default and is untouched by it: no
port, no token, no listener.

On B:

```bash
SMOL_MCP_AUTH_TOKEN=$(openssl rand -hex 16) \
  npx -y --package smol-mcp smol-mcp-http --host 0.0.0.0 --port 8080 --path /mcp
```

On A, one entry:

```json
{
  "mcpServers": {
    "smol": {
      "type": "http",
      "url": "http://b.local:8080/mcp",
      "headers": { "Authorization": "Bearer <the token you generated>" }
    }
  }
}
```

- **It refuses to start without `SMOL_MCP_AUTH_TOKEN`**, and every request
  needs it. These tools create and run virtual machines, so a listener without
  a token is a remote shell.
- **The token check runs before the path check**, so an unauthenticated
  request learns nothing, not even where the endpoint is.
- **DNS rebinding protection is on**, with the Host and Origin allow-lists
  below.
- The token is read from `authorization: Bearer ...` **or**
  `x-smol-mcp-token`. The second header is there for a deployment that puts
  something else in `authorization` before the request reaches this server.
- The bind is `127.0.0.1` by default. Publishing the port is a decision to
  make in the open, not the consequence of a default, and off loopback you
  should also set `SMOL_MCP_HTTP_ALLOWED_HOSTS` to the name A dials.
- An idle session is closed and its ephemeral machines deleted; a session with
  a tool call still running is never closed, however long the call takes.
- This is plain HTTP. Over anything but a network you trust, put it behind TLS.
- Replies are plain JSON rather than an SSE frame per response
  (`enableJsonResponse`), because the reply travels through a proxy whose
  buffering is not ours and no tool here streams.
- Each session gets its own server instance, and ending the session (an HTTP
  DELETE) deletes that session's ephemeral machines, the way stdin EOF does on
  stdio. A session cleans up only what it created, and the `smolvm serve` the
  sessions share is stopped by the last one to let go of it, not by whichever
  one started it.

### Hosting it in a smol machine

Two shapes, both run end to end; see Verified.

**Agent inside the machine.** `npm install smol-mcp` in the guest (or `npm pack`
here and upload the tarball through `POST /v1/machines/{id}/exec` with the
base64 on stdin, which is how it was first proven), and speak stdio to
`smol-mcp` there. The account key goes
in the machine's create-time `env` and is in the guest process environment.
The local target is unavailable inside a guest and says so on the first call.

**Agent outside the machine.** Publish port 8080 at create, run
`smol-mcp-http` on `0.0.0.0`, and connect with the SDK's
`StreamableHTTPClientTransport` to `https://<name>-<hash>.apps.smolmachines.com/mcp`,
the ingress URL the machine record's `url` field carries once it is ready.
`get-machine` and `list-machines` report that field, as `url`; it is null on
the local target and until something listens on the published port.
This shape needs open egress anyway, to reach the smol cloud API.

## A worked example

An agent borrowing a machine to check out a repository, run its tests, read
the result and take a generated file away. Five calls, on the local target,
run exactly as shown against `smolvm` 1.14.5 and pasted back verbatim.

**1. A machine.** `network: "open"` because the image is pulled from a
registry and that pull happens inside the guest; see the egress section below.

```
$ create-machine {"target":"local","name":"mcp-walkthrough","image":"python:3.12-alpine","cpus":2,"memoryMb":1024,"network":"open"}   [3.1s]
{
  "machine": { "id": "mcp-walkthrough", "name": "mcp-walkthrough", "state": "running",
               "cpus": 2, "memoryMb": 1024, "network": "open", "pid": 36349 },
  "ephemeral": true,
  "ready": true
}
```

`ready: true` means a command has already run in it, so the next call does not
have to wait for the guest.

**2. Check out the work.**

```
$ run-command {"target":"local","name":"mcp-walkthrough","command":"apk add --no-cache git >/dev/null && pip install --quiet pytz && git clone --depth 1 --quiet https://github.com/dbader/schedule /workspace/schedule && echo cloned","timeoutSecs":120}   [3.3s]
{
  "stdout": "cloned\n",
  "stderr": "WARNING: Running pip as the 'root' user can result in broken permissions ...",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "overflow": [],
  "startedMachine": false
}
```

`exitCode` comes from the guest: a failing command is a result, not a tool
error, so the agent reads the code rather than catching an exception.

**3. Run the tests, keeping a report in the machine.**

```
$ run-command {"target":"local","name":"mcp-walkthrough","command":"cd /workspace/schedule && python -m unittest test_schedule 2>&1 | tee /workspace/report.txt | tail -3","timeoutSecs":120}   [0.2s]
{
  "stdout": "Ran 81 tests in 0.020s\n\nOK\n",
  "stderr": "",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "overflow": [],
  "startedMachine": false
}
```

**4. Take the generated file.**

```
$ read-file {"target":"local","name":"mcp-walkthrough","path":"/workspace/report.txt"}   [0.0s]
{
  "path": "/workspace/report.txt",
  "content": ".....................................................................\n---------------------------------------------------------------\nRan 81 tests in 0.020s\n\nOK\n",
  "encoding": "utf8",
  "size": 180,
  "offset": 0,
  "bytes": 180,
  "eof": true,
  "startedMachine": false
}
```

`size` is the whole file and `bytes` is what this call returned, so `eof: true`
says there is nothing after it. A bigger file comes back in pages: pass
`offset` and `length` and read until `eof`.

**5. Give it back.**

```
$ delete-machine {"target":"local","name":"mcp-walkthrough"}   [0.1s]
{ "deleted": "mcp-walkthrough" }
```

The delete is not strictly needed. The name carries the `mcp-` prefix, so the
machine is ephemeral and the session would have deleted it at exit anyway.
The whole sequence took 6.7 seconds.

## Defaults, and why each one is what it is

Settable by env var, or by a JSON config file at
`$XDG_CONFIG_HOME/smol-mcp/config.json` (or `$SMOL_MCP_CONFIG`). Precedence is
env over file over default. An unknown key in the config file is an error
rather than a silent no-op, because the local API's own habit of accepting and
dropping unknown fields is exactly the failure this avoids.

| Setting | Env | Default | Why |
|---|---|---|---|
| minimum smolvm | `SMOL_MCP_MIN_SMOLVM` | 1.14.0 | Checked against `/health` on the first local call. An older serve rejects unknown fields on the exec body, so `run-command` with `stdin` fails there. Empty turns the check off. |
| memory | `SMOL_MCP_MEMORY_MB` | 2048 MiB | Enough for an interpreter and a build; small enough to boot several at once. |
| cpus | `SMOL_MCP_CPUS` | 2 | One core leaves nothing for the guest agent while a command runs. |
| exec timeout | `SMOL_MCP_EXEC_TIMEOUT_SECS` | 120 s | Long enough for a package install, short enough that a hung command does not hold a tool call open. |
| exec timeout ceiling | `SMOL_MCP_MAX_EXEC_TIMEOUT_SECS` | 900 s | The longest `timeoutSecs` a caller may ask for. A tool call holds a machine, and on cloud a bill, for as long as it runs. |
| output truncation | `SMOL_MCP_MAX_OUTPUT_BYTES` | 64 KiB per stream | A tool result is read by a model with a context budget. Past this the result keeps the head and the tail, says how many bytes fell between them, and writes the whole stream into the machine so it can be read back. Truncation is reported, never silent. |
| readiness timeout | `SMOL_MCP_READY_TIMEOUT_SECS` | 120 s | Covers a cold image pull inside the guest. |
| egress default | `SMOL_MCP_NETWORK_DEFAULT` | `blocked` | `create-machine` when the call names no policy. See below. |
| run-once egress | `SMOL_MCP_RUN_ONCE_NETWORK` | `blocked` | The same, for `run-once`. See below. |
| ephemeral TTL | `SMOL_MCP_EPHEMERAL_TTL_SECS` | 3600 s | Sent as `ttlSeconds` where the API has one, so a killed server cannot leave a cloud machine billing forever. |
| ephemeral idle stop | `SMOL_MCP_EPHEMERAL_AUTO_STOP_SECS` | 900 s | Sent as `autoStopSeconds`, so an abandoned cloud machine stops paying for cpu and memory at the first quiet window instead of running to its TTL. |
| machine prefix | `SMOL_MCP_MACHINE_PREFIX` | `mcp-` | The marker that makes a machine ephemeral. |
| log tail | `SMOL_MCP_LOGS_TAIL` | 100 lines | What `machine-logs` returns when no cursor is given. |
| log poll | `SMOL_MCP_LOGS_POLL_SECS` | 2 s | How often a subscribed log resource is checked for new lines. Neither log route pushes, so following is a poll. |
| HTTP bind | `SMOL_MCP_HTTP_HOST` | `127.0.0.1` | HTTP transport only. Publishing the listener is a decision, not a default. |
| HTTP port | `SMOL_MCP_HTTP_PORT` | 8080 | HTTP transport only. What a smol machine publishes by default. |
| HTTP path | `SMOL_MCP_HTTP_PATH` | `/mcp` | HTTP transport only. Everything else on the listener is a 404. |
| HTTP token | `SMOL_MCP_AUTH_TOKEN` | none | HTTP transport only, and required: it refuses to start without one. |
| HTTP idle session | `SMOL_MCP_HTTP_SESSION_IDLE_SECS` | 1800 s | A session with no request in flight and none for this long is closed, and its ephemeral machines with it. A running tool call keeps its session alive however long it takes. |
| HTTP Host allow-list | `SMOL_MCP_HTTP_ALLOWED_HOSTS` | the loopback names of the bound port | Comma separated. Off loopback the name is not knowable here, so name it or the Host check does nothing and the startup log says so. |
| HTTP Origin allow-list | `SMOL_MCP_HTTP_ALLOWED_ORIGINS` | none | Comma separated. Empty means no browser origin is expected; a request carrying one is refused only when this names some other value. |

### Security defaults, stated as reasons

- **The local API has no authentication.** Anything that can reach it can
  create a VM on this host. So the server listens on a Unix socket in its own
  runtime directory (mode 0700) by default, and refuses outright to start a
  serve on a non-loopback address.
- **Nothing runs on the host outside a VM.** Every command a tool executes
  goes through the machine API into a guest. The server spawns exactly one
  host process, `smolvm serve`, and only when a local tool is called.
- **The token is read from the environment or the config file, and never
  written anywhere.** It is not logged, not echoed in an error, `.env` is in
  `.gitignore`, and the `smolvm serve` child is spawned with a minimal
  environment that carries neither token.
- **`run-once` on cloud denies egress by default**, and never publishes a port.
  See the network section.
- **The HTTP transport authenticates every request and refuses to start
  without a token.** Not a warning, not a default token: the process exits.

### Egress is off unless the call asks for it

The intent is that a machine an agent asked for cannot reach the internet
because nobody said otherwise. `create-machine` and `run-once` both default to
no egress, on both targets. `SMOL_MCP_NETWORK_DEFAULT` and
`SMOL_MCP_RUN_ONCE_NETWORK` move that default for an operator who wants it
open; the tool arguments `network`, `allowHosts` and `allowCidrs` move it per
call.

**The local trap, and it is why the default has to be opt-out per create.** An
image is pulled from a registry *inside the guest*, so a machine with no
egress cannot start from one. The API refuses it at create time:

```
image 'alpine' must be pulled from a registry, but this machine has no
network, so the pull can never succeed. Add --net (or publish a port with -p,
or set an egress policy with --allow-cidr/--allow-host). To keep the machine
network-isolated, supply the image locally instead: `docker save alpine |
smolvm machine create --image - ...`
```

This server passes that message through and adds one line naming the argument
that grants the exception for that create. An egress allow-list is accepted
and is honoured on the pull, which sounds like the better answer and is a
trap: the blob CDN host is not knowable in advance. Allow-listing docker.io's
documented hosts produced

```
dial tcp: lookup production.cloudfront.docker.com ...: no such host
```

because the CDN name is neither `docker.io` nor any of the hosts the docs
name. So a registry image on the local target realistically needs
`network: "open"` for the create that pulls it.

**Which means the blocked default is a default, not a guarantee.** The
server's instructions tell the agent exactly that: pass `network: "open"` for
a registry image on local. An agent following them will open egress on its own
whenever it wants an image it does not have. If you need isolation you cannot
talk an agent out of, supply the image locally (`docker save ... | smolvm
machine create --image -`) so nothing has to be pulled, or give an allow-list
that names what the workload may reach. The default stops a machine reaching
the internet by accident; it does not stop an agent asking.

**Cloud.** The control plane pulls the image, so the guest never needs the
registry and a blocked machine starts normally. One API fact shapes how the
deny is spelled: `{"mode": "allowCidrs", "cidrs": []}` is refused with
`HTTP 400 allowCidrs network mode requires at least one CIDR or host`. So the
deny goes out as an allow-list of `192.0.2.0/24`, RFC 5737 TEST-NET-1,
reserved for documentation and routed nowhere. A cloud machine that publishes
a port cannot also block egress, and `create-machine` refuses that
combination rather than sending it.

## What this server does not expose

Both APIs are larger than this tool vocabulary. Everything below is a
deliberate omission with a reason, and `src/parity.ts` carries the same list
as data: the parity check reports each skipped route with its reason and
reports anything in neither list as `unknown`, so a capability added in a
release shows up as a decision to make rather than an omission nobody noticed.

**The tools are hand written and not generated from either spec**, because
three published entries do not describe the running service: the cloud
snapshot route is documented as a 200 and answers 501, the cloud export entry
carries no request body at all, and the local spec has no checkpoint route
while the product has the feature. The published cloud OpenAPI also lists
neither the fork route nor the checkpoint routes, and both exist and answer.

### Local, against `smolvm serve openapi` on v1.14.5

| Not exposed | Why |
|---|---|
| export | Needs a `pushToken` that the spec itself describes as minted by the control plane, so a local user cannot produce one. |
| checkpoint | Absent from the local spec entirely. It also restores only on the same OS and architecture, and macOS restore with host mounts has an open defect. |
| branch release | Releases a held fork-pool slot; this server has no pool vocabulary. |
| sync | Synchronises staged mounts without stopping the machine; mounts here are a create-time argument. |
| resize | Expand only, and no tool asks for a machine to grow after it exists. |
| `exec/stream` | Exec results are returned whole, not streamed. |
| fork pools, rollout executors | Fleet and batch surfaces rather than agent ones. |

**Volumes on the local target are the `mounts` argument** on `create-machine`,
which attaches a host directory. There is no separate volume object.

### Cloud

| Not exposed | Why |
|---|---|
| export | The spec entry has no request body and nothing anywhere tests it, so there is no shape to code against. |
| snapshot | Documented as a 200 and answers 501, telling the caller to export instead. Never call it. |
| volumes | Not built on the service. |
| checkpoints | All four routes exist. On 2026-09-09, capture answered 502 three times with a libkrun permission error in the node's checkpoint staging directory, and delete answered 502 on storage cleanup. No tool ships until the service side works. |
| fork batch, lineage | Batch branching and branch ancestry, which this vocabulary does not express. |
| sessions | A session keeps a working directory and environment across execs; `run-command` is one shot. |
| code | A code-oriented surface with no counterpart on the local target. |
| connect | The authenticated bridge answers `GET` and `HEAD` only, so no MCP client can speak through it. Use the machine's ingress URL. |

Exec results are returned whole on both targets. Output past the budget keeps
its head and its tail and the whole stream is written back into the machine,
which the result names; nothing streams a command as it runs.

## Constraints this server is built around

Each one has a test.

| | Constraint | Covered by |
|---|---|---|
| a | A local file upload must wait until the workload container is running, or it lands in the agent's namespace and is hidden once the container mounts over the path. | `test/unit/machines.test.ts` asserts the upload call comes after a successful exec; `test/integration/local.test.ts` and `cloud.test.ts` assert the guest reads its own bytes back. |
| b | `run-command` reads `{stdout, stderr, exitCode}` from the body, never from the HTTP status: both APIs answer 200 for a command that exited non-zero. | `test/unit/client.test.ts`, `test/unit/cloud-client.test.ts`, and a real `exit 42` in both integration suites. |
| c | Local parity is stated by the paths this server calls, not by `serve openapi`'s `info.version`, which is hardcoded at `0.5.2` on a v1.14.5 binary. | `src/parity.ts`, asserted in `test/integration/local.test.ts` including the assertion that `info.version` is *not* the version. |
| d | The local create field is `network`, not `net`, and `memoryMb`, not `memory`. | `test/unit/client.test.ts` asserts the exact request body; `test/unit/tools.test.ts` asserts the CLI spellings are stripped by the schema. |
| e | The cloud connect bridge answers `allow: GET,HEAD`, so an MCP client cannot reach a guest through it; the machine's ingress URL carries POST. | Not a unit test: `test/unit/http-transport.test.ts` covers the transport, and the bridge's methods were probed by hand. |
| f | A server hosted behind an ingress cannot assume `authorization` is free for a token of its own. | `test/unit/http-transport.test.ts` initializes a session with another credential in `authorization` and the server token in `x-smol-mcp-token`. |
| g | `branchable` is asked for in a different place on each target, and neither can turn it on for a machine that already exists. | `test/unit/client.test.ts` asserts the start query, `test/unit/cloud-client.test.ts` asserts the create field and that the start carries no query; both refusals are asserted by message. |
| h | A cloud machine created `ephemeral` is deleted before it can be started, because it is created stopped. | `test/unit/cloud-client.test.ts` asserts the create body carries `ttlSeconds` and `autoStopSeconds` and no `ephemeral`. |

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
key can still run `npm test`. Those three commands are also the whole CI gate,
for the same reason: booting a machine needs a hypervisor and the cloud suite
needs an account to bill, and neither belongs on a pull request.

```bash
# local: needs smolvm on PATH or in SMOLVM
SMOL_MCP_IT=1 npm run test:integration

# cloud: additionally needs SMOL_CLOUD_TOKEN and SMOL_CLOUD_URL
SMOL_MCP_IT=1 npm run test:cloud
```

The cloud suite reads `GET /v1/account` before it creates anything and after
every test, and stops the moment period spend passes its own ceiling. It
deletes what it makes in the test that makes it, and its `afterAll` asserts no
`mcp-` machine is left on the fleet.

## Verified

What was actually run, on what, rather than what should work. Everything below
is from one round on 2026-09-09 and 2026-09-10, on the tree this section ships
with.

**Three hosts.** A Mac on Apple Silicon (node 25.9.0), a Windows 11 laptop
(build 10.0.26200.0, node 24.19.0), and Ubuntu 24.04 aarch64 in a Lima VM with
`/dev/kvm` (node 20.19.5). `smolvm` **1.14.5** on all three, from the
darwin-arm64, windows-x86_64 and linux-arm64 release archives.

**Keyless, on any host.** `npm run lint`, `npm run typecheck` and
`npm run test:unit`: 11 files, 173 tests passing, 14 skipped. Identical counts
on macOS and on Linux, and within half a second on the clock. Those three are
also the whole CI gate, because the integration suites need a hypervisor and an
account and neither belongs on a pull request.

**Local, on real machines.** `SMOL_MCP_IT=1 npm run test:integration` from an
isolated `HOME`: 10 passing, the cloud file skipped, on macOS in 23 s and on
Linux under Lima in 167 s, the same tests either way. `scripts/smoke.mjs local`
listed all thirteen tools and ran a command on both. The worked example above
is a real run, pasted back, and a model driving a real MCP client ran the same
five calls unaided. The branch flow was run end to end on macOS: a machine
created `branchable`, a file written into it, `branch-machine` into a child in
0.4 s against 2.7 s for a create, the child reading the parent's file, and a
non-branchable source refused with the API's own message.

**Windows.** The local target works there: this server starts `smolvm serve`
on loopback TCP, boots Linux microVMs and runs commands, files and logs in
them, driven both from a client on the same box and from another computer.
`branch-machine` is refused there with the reason, because a machine started
branchable on that platform has no control socket to branch from.

**Two computers over wifi, both directions.** The Windows laptop serving and
the Mac driving it, then the Mac serving and the laptop driving it. On the
same runs: a request with no token and a request with a wrong token both
refused with the same 401, including on a path that is not the endpoint, so
the endpoint is not revealed to an unauthenticated caller; a `Host` outside the
allow-list refused with 403; a session idle past
`SMOL_MCP_HTTP_SESSION_IDLE_SECS` closed and its machine deleted, while a
session holding a 70 s call through the same limit returned its output and
stayed usable; and `netstat` on the serving host showed `smolvm` bound to
loopback only, with the MCP port the single listener on the LAN address.

**A real client, driven headless.** OpenCode **1.18.30**, configured exactly as
the `opencode.json` above, ran the worked example over stdio and a
create-plus-run-plus-delete against the Windows laptop over HTTP with the
bearer header. Both were tool calls a model chose from the schemas, not
scripted requests.

**The package.** `npm pack` gives an 87781 byte tarball carrying `dist`,
`LICENSE`, `README.md` and `package.json` and nothing from `src` or `test`.
Installed into a clean directory on macOS and on Windows, both bins in
`node_modules/.bin` serve all thirteen tools and boot a real machine.

**Cloud, against the live API.** `SMOL_MCP_IT=1 npm run test:cloud`: 4 passing,
26 micros of spend, nothing left on the fleet. Driven through this server over
stdio with `SMOL_MCP_TARGETS=cloud`: a create with a published port and open
egress, the blocked-plus-port combination refused before anything was sent,
`write-file` and `read-file` through the documented files route,
`branch-machine` into a child that read the parent's file, and `machine-logs`
from the events route with the cursor coming back empty on the second call.
The hosted shape above was rebuilt and driven: this server installed into a
cloud machine through its own `write-file`, serving on a published port, with
a client on the Mac creating, running a command in and deleting a second
machine through the ingress URL. Every machine was deleted and
`GET /v1/machines` was empty afterwards; the whole cloud half cost 449 micros.

**Not verified.** Claude Code, Claude Desktop and Cursor were not driven: their
configurations above are read from each client's documentation, and the three
`claude` runs attempted here never reached the server because that CLI had no
usable login on the host. The browser `Origin` gate was exercised only with
`SMOL_MCP_HTTP_ALLOWED_ORIGINS` empty, where a request carrying an origin is
accepted, which is what that setting means and not a test of refusing. Cloud
checkpoints failed on the service side and no tool ships for them; see what
this server does not expose.

## How this relates to the smolmachines SDK

If you are writing a Node or Python application rather than connecting an
agent, use the embedded `smolmachines` SDK instead. It runs the local engine
in process, does not need `smolvm serve`, and reaches smol cloud through the
same Machine API. This server exists for the other case: a client that already
speaks MCP and wants tools rather than a library. Its local target rides on
`smolvm serve` because that API is the one an out-of-process server can talk
to on every platform the CLI supports.

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
- **The cloud files route takes the path as a suffix**, with no leading slash:
  `PUT /v1/machines/{id}/files/workspace/app.py`, and the same for `GET`. The
  published schema lists the route with only `{id}`, so a deployment that
  predates the suffix answers 404 and `read-file` and `write-file` fall back to
  exec with base64. The fallback meets the exec response cap, so a read it cut
  is refused rather than returned short.
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
