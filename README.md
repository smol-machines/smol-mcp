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
| `create-machine` | local, cloud | Starts the machine and waits until commands run in it. Publishes ports and sizes the disk on both targets; `mounts` and `overlayGb` are local only. |
| `run-command` | local, cloud | Returns `{stdout, stderr, exitCode, truncated, timedOut}`. |
| `run-once` | local, cloud | Create, start, exec, delete. Deletes the machine even on timeout. |
| `read-file` | local, cloud | |
| `write-file` | local, cloud | Waits for readiness first, so the file is not written under a mount that later hides it. |
| `start-machine` | local, cloud | Starts a stopped machine and waits until commands run in it. |
| `stop-machine` | local, cloud | Start it again with `start-machine`; `create-machine` on an existing name is a conflict. |
| `delete-machine` | local, cloud | |
| `machine-logs` | local | The cloud API has an event log, not a console log. |
| `pull-image` | local | The cloud control plane pulls the image itself at create. |

A machine whose name starts with `mcp-` is ephemeral: the session that created
it records it and deletes it when that session ends, on either target. A name
you choose yourself persists. The local record is a file in the runtime
directory, so the next start can clean up after a crashed one; the cloud
record is in memory, and a process that dies with entries in it leaves them to
the control plane's own idle stop and TTL.

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
- **The token check runs before the path check**, so an unauthenticated
  request learns nothing, not even where the endpoint is.
- **DNS rebinding protection is on**, with the Host and Origin allow-lists
  below.
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
  stdio. A session cleans up only what it created, and the `smolvm serve` the
  sessions share is stopped by the last one to let go of it, not by whichever
  one started it.

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
| exec timeout ceiling | `SMOL_MCP_MAX_EXEC_TIMEOUT_SECS` | 900 s | The longest `timeoutSecs` a caller may ask for. A tool call holds a machine, and on cloud a bill, for as long as it runs. |
| output truncation | `SMOL_MCP_MAX_OUTPUT_BYTES` | 64 KiB per stream | A tool result is read by a model with a context budget; past this the tail stops carrying information. Truncation is reported, never silent. |
| readiness timeout | `SMOL_MCP_READY_TIMEOUT_SECS` | 120 s | Covers a cold image pull inside the guest. |
| run-once network (local) | `SMOL_MCP_RUN_ONCE_NETWORK` | `open` | See below. |
| ephemeral TTL | `SMOL_MCP_EPHEMERAL_TTL_SECS` | 3600 s | Sent as `ttlSeconds` where the API has one, so a killed server cannot leave a cloud machine billing forever. |
| ephemeral idle stop | `SMOL_MCP_EPHEMERAL_AUTO_STOP_SECS` | 900 s | Sent as `autoStopSeconds` with `ephemeral: true`, so an abandoned cloud machine stops and is deleted at the first quiet window instead of billing to the TTL. |
| machine prefix | `SMOL_MCP_MACHINE_PREFIX` | `mcp-` | The marker that makes a machine ephemeral. |
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
| e | The cloud connect bridge answers `allow: GET,HEAD`, so an MCP client cannot reach a guest through it; the machine's ingress URL carries POST. | Not a unit test: `test/unit/http-transport.test.ts` covers the transport, and the bridge's methods were probed by hand. |
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
every test, and stops the moment period spend passes its own ceiling. It
deletes what it makes in the test that makes it, and its `afterAll` asserts no
`mcp-` machine is left on the fleet.

## Verified

Both transports and both targets were run end to end before this tree was
published: the unit suite on a host with no hypervisor and no key, the local
integration suite against `smolvm` v1.14.3 on macOS on Apple Silicon, and the
cloud integration suite against the smol cloud API. A real MCP client over
stdio (`scripts/smoke.mjs`) listed the tools and ran a command on each target,
and the same client over Streamable HTTP (`scripts/smoke-http.mjs`) did the
same against a server hosted on a smol cloud machine, once with the agent
inside the machine speaking stdio and once outside it over the machine's
ingress URL. The two authentication gates were both provoked from another
host: a request with no server token and a request with the wrong one are each
a 401.


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
