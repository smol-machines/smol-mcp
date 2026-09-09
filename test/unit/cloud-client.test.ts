// Response parsing against a fake smol cloud on a loopback port. The bodies
// here carry the awkward parts of the real ones: a bare array from list, a
// plain-text error body, a 200 carrying a non-zero exitCode, and a 204 from a
// delete without includeUsage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { BackendError } from "../../src/backend.js";
import { CloudClient, CloudNotConfigured, DENY_CIDR, cloudView, findMicros, shellQuote, toCloudNetwork } from "../../src/cloud/client.js";

const ID = "mach-0123456789abcdef0123456789abcdef";
const machine = {
  id: ID,
  name: "mcp-once-abcd",
  source: { type: "smolmachine", reference: "registry.smolmachines.com/library/alpine:3.20", arch: "amd64" },
  state: "stopped",
  resources: { cpus: 1, memoryMb: 256, diskGb: null },
  network: { mode: "allowCidrs", cidrs: [] },
  env: {},
  ephemeral: false,
  createdAt: "2026-09-08T14:47:37Z",
  updatedAt: "2026-09-08T14:47:37Z",
};

let server: Server;
let client: CloudClient;
const seen: { method: string; url: string; auth: string; body: string }[] = [];
let flaky = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, auth: String(req.headers.authorization ?? ""), body });
      const send = (status: number, payload: string, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(payload);
      };
      if (url === "/v1/machines" && req.method === "GET") return send(200, JSON.stringify([machine]));
      if (url === "/v1/machines" && req.method === "POST") {
        if (body.includes("mcp-broken")) return send(500, "internal error", "text/plain");
        return send(201, JSON.stringify(machine));
      }
      if (url === `/v1/machines/${ID}` && req.method === "GET") return send(200, JSON.stringify(machine));
      if (url === `/v1/machines/${ID}` && req.method === "DELETE") return send(204, "");
      if (url === `/v1/machines/${ID}?includeUsage=true`) return send(200, JSON.stringify({ id: ID, usage: { uptimeSeconds: 166 }, cost: { baseMicros: 1800, totalMicros: 1879 } }));
      if (url === `/v1/machines/${ID}/start`) return send(202, "");
      if (url === `/v1/machines/${ID}/stop`) return send(200, "");
      if (url === `/v1/machines/${ID}/exec?output=text`) {
        const req_ = JSON.parse(body) as { command: string[]; stdin?: string };
        if (req_.command.join(" ").includes("base64 -d")) return send(200, JSON.stringify({ stdout: "", stderr: "", exitCode: 0, durationMs: 4, machineId: ID }));
        if (req_.command.join(" ").includes("base64 <")) return send(200, JSON.stringify({ stdout: "aGVsbG8=\n", stderr: "", exitCode: 0, durationMs: 4, machineId: ID }));
        // The trap: a guest command that exited 42 is still HTTP 200.
        return send(200, JSON.stringify({ stdout: "to-stdout\n", stderr: "to-stderr\n", exitCode: 42, durationMs: 73, machineId: ID }));
      }
      if (url === "/v1/machines/mach-gone") return send(404, "machine not found");
      if (url === "/v1/machines/mach-flaky") {
        flaky += 1;
        if (flaky <= 2) {
          res.writeHead(503, { "content-type": "text/plain", "x-request-id": "req-503", "retry-after": "0" });
          return res.end("busy");
        }
        return send(200, JSON.stringify({ ...machine, id: "mach-flaky" }));
      }
      if (url === "/v1/machines/mach-broken") {
        res.writeHead(500, { "content-type": "text/plain", "x-request-id": "req-abc123" });
        return res.end("internal error");
      }
      // Error bodies are JSON on 401 and plain text on everything else.
      if (url === "/v1/account") return send(401, JSON.stringify({ message: "invalid api key" }));
      send(422, "Failed to deserialize the JSON body into the target type: missing field `source`", "text/plain");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  client = new CloudClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "test-token");
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("CloudClient", () => {
  it("refuses to call anything without a token", async () => {
    await expect(new CloudClient("http://127.0.0.1:1", "").listMachines()).rejects.toBeInstanceOf(CloudNotConfigured);
  });

  it("sends a bearer token and parses a bare array from list", async () => {
    seen.length = 0;
    const list = await client.listMachines();
    expect(seen[0]?.auth).toBe("Bearer test-token");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(ID);
    expect(list[0]?.name).toBe("mcp-once-abcd");
  });

  it("sends source, resources and network in the shapes the API requires, never a flat image string", async () => {
    seen.length = 0;
    await client.createMachine({ name: "mcp-x", image: "alpine:3.20", cpus: 1, memoryMb: 256, network: { mode: "blocked" }, cmd: ["sleep", "1"], ttlSeconds: 600 });
    const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.source).toEqual({ type: "image", reference: "alpine:3.20" });
    expect(body.resources).toEqual({ cpus: 1, memoryMb: 256 });
    expect(body.network).toEqual({ mode: "allowCidrs", cidrs: [DENY_CIDR] });
    expect(body.ttlSeconds).toBe(600);
    expect(body).not.toHaveProperty("image");
    // No workload field exists here, and an unknown field is accepted and
    // silently dropped, so a stray cmd would look like it had been honoured.
    expect(body).not.toHaveProperty("cmd");
    expect(body).not.toHaveProperty("ports");
  });

  it("resolves a name to an id before calling a route that takes one", async () => {
    seen.length = 0;
    const m = await client.getMachine("mcp-once-abcd");
    expect(seen.map((s) => s.url)).toEqual(["/v1/machines", `/v1/machines/${ID}`]);
    expect(m.state).toBe("stopped");
    expect(m.image).toBe("registry.smolmachines.com/library/alpine:3.20");
  });

  it("reads exitCode from a 200 body (constraint b)", async () => {
    const r = await client.exec(ID, { command: ["sh", "-c", "exit 42"] });
    expect(r).toEqual({ exitCode: 42, stdout: "to-stdout\n", stderr: "to-stderr\n" });
  });

  it("sends the cloud spelling of the exec fields, not the local one", async () => {
    seen.length = 0;
    await client.exec(ID, { command: ["true"], workdir: "/w", timeoutSecs: 5, env: { A: "b" } });
    const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ command: ["true"], cwd: "/w", env: { A: "b" }, timeoutSeconds: 5 });
    expect(seen[0]?.url).toContain("output=text");
  });

  it("takes the settled bill from the delete, not from a mid-life usage read", async () => {
    expect(await client.deleteMachine(ID)).toEqual({ deleted: ID, usageMicros: 1879 });
    expect(seen.at(-1)?.url).toBe(`/v1/machines/${ID}?includeUsage=true`);
  });

  it("reads a machine back after a 202 start with an empty body", async () => {
    expect((await client.startMachine(ID)).id).toBe(ID);
  });

  it("reads a plain-text error body without throwing on it", async () => {
    const err = (await client.getMachine("mach-gone").catch((e: unknown) => e)) as BackendError;
    expect(err).toBeInstanceOf(BackendError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("machine not found");
  });

  it("finds the message in a JSON error body too, which is the 401 shape", async () => {
    const err = (await client.account().catch((e: unknown) => e)) as BackendError;
    expect(err.code).toBe("HTTP_401");
    expect(err.message).toContain("invalid api key");
  });

  it("round-trips a file through exec, since the files route takes no documented parameter", async () => {
    seen.length = 0;
    expect(await client.writeFile(ID, "/workspace/a b.txt", Buffer.from("hello"))).toEqual({ path: "/workspace/a b.txt", size: 5 });
    const sent = JSON.parse(seen[0]?.body ?? "{}") as { command: string[]; stdin: string };
    expect(sent.stdin).toBe(Buffer.from("hello").toString("base64"));
    expect(sent.command[2]).toContain("'/workspace/a b.txt'");
    expect((await client.readFile(ID, "/workspace/a b.txt")).toString()).toBe("hello");
  });

  it("retries a status the service says is temporary, and stops when it answers", async () => {
    flaky = 0;
    seen.length = 0;
    // The readiness poll used to be the only retry in the client, and it
    // retried a 429 at 1 Hz for two minutes because it could not tell a
    // temporary refusal from a permanent one.
    expect((await client.getMachine("mach-flaky")).id).toBe("mach-flaky");
    expect(seen.filter((s) => s.url === "/v1/machines/mach-flaky")).toHaveLength(3);
  });

  it("gives up after the retries and carries the request id the docs ask for", async () => {
    seen.length = 0;
    const err = (await client.getMachine("mach-broken").catch((e: unknown) => e)) as BackendError;
    expect(err.code).toBe("HTTP_500");
    // The id is what the service can look the failure up by, and an error
    // without it sends the reporter back for a second run.
    expect(err.message).toContain("x-request-id req-abc123");
    expect(seen.filter((s) => s.url === "/v1/machines/mach-broken")).toHaveLength(3);
  });

  it("does not retry a create or an exec, which may have taken effect already", async () => {
    seen.length = 0;
    // A create that answered 500 may well have created the machine, and an
    // exec may well have run the command; a second attempt bills twice.
    await expect(client.createMachine({ name: "mcp-broken", image: "alpine", cpus: 1, memoryMb: 256, network: { mode: "open" } })).rejects.toThrow();
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("refuses the two local-only tools by name", async () => {
    await expect(client.logs()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(client.pullImage()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

describe("cloud shape helpers", () => {
  it("spells a deny as an allow-list of an unroutable range, never as an empty one", () => {
    expect(toCloudNetwork({ mode: "open" })).toEqual({ mode: "open" });
    // An empty cidrs is a hard 400, so it cannot carry a deny.
    expect(toCloudNetwork({ mode: "blocked" })).toEqual({ mode: "allowCidrs", cidrs: [DENY_CIDR] });
    expect(toCloudNetwork({ mode: "allow", cidrs: [] })).toEqual({ mode: "allowCidrs", cidrs: [DENY_CIDR] });
    expect(toCloudNetwork({ mode: "allow", cidrs: ["1.1.1.1/32"], hosts: ["example.com"] })).toEqual({ mode: "allowCidrs", cidrs: ["1.1.1.1/32", "example.com"] });
  });

  it("turns an ISO createdAt into epoch seconds and falls back to the id for a nameless machine", () => {
    expect(cloudView({ ...machine, createdAt: "2026-09-08T14:47:37Z" }).createdAt).toBe(1788878857);
    expect(cloudView({ ...machine, name: null }).name).toBe(ID);
    expect(cloudView({ ...machine, createdAt: "not a date" }).createdAt).toBe(0);
  });

  it("finds totalMicros wherever the delete body nests it", () => {
    expect(findMicros('{"cost":{"totalMicros":7}}')).toBe(7);
    expect(findMicros('{"a":{"b":{"totalMicros":9}}}')).toBe(9);
    expect(findMicros("not json")).toBeUndefined();
    expect(findMicros("{}")).toBeUndefined();
  });

  it("quotes a path that would otherwise break out of the shell command", () => {
    expect(shellQuote("/a b/c")).toBe("'/a b/c'");
    expect(shellQuote("/a'; rm -rf /; '")).toBe(`'/a'\\''; rm -rf /; '\\'''`);
  });
});
