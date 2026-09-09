// Response parsing against a fake local API on a Unix socket, so the parser
// sees real HTTP bytes and the socket transport is exercised.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalClient, parseSseData } from "../../src/local/client.js";
import { BackendError } from "../../src/backend.js";

let server: Server;
let client: LocalClient;
const seen: { method: string; url: string; body: string }[] = [];

beforeAll(async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "smol-mcp-t-")), "api.sock");
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const send = (status: number, payload: string, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(payload);
      };
      const url = req.url ?? "";
      if (url === "/health") return send(200, JSON.stringify({ status: "ok", version: "1.14.3", machines: { total: 0, running: 0 }, uptime_seconds: 1 }));
      if (url === "/api/v1/machines" && req.method === "GET") return send(200, JSON.stringify({ machines: [{ name: "a", state: "running", cpus: 2, memoryMb: 2048, network: true, pid: 7, createdAt: 1, extraField: "ignored" }] }));
      if (url === "/api/v1/machines" && req.method === "POST") return send(200, JSON.stringify({ name: "b", state: "created", cpus: 1, memoryMb: 1024, network: false, createdAt: 2, mounts: [], ports: [] }));
      if (url === "/api/v1/machines/missing") return send(404, JSON.stringify({ error: "machine 'missing' not found", code: "NOT_FOUND" }));
      if (url === "/api/v1/machines/a/exec") return send(200, JSON.stringify({ exitCode: 3, stdout: "out\n", stderr: "err\n", stdoutB64: "b3V0Cg==", stderrB64: "ZXJyCg==" }));
      if (url === "/api/v1/machines/a/files/%2Froot%2Fa.txt" && req.method === "PUT") return send(200, JSON.stringify({ path: "/root/a.txt", size: body.length }));
      if (url === "/api/v1/machines/a/files/%2Froot%2Fa.txt" && req.method === "GET") return send(200, "PAYLOAD", "application/octet-stream");
      if (url === "/api/v1/machines/a/files/%2Froot%2Fnope.txt") return send(500, JSON.stringify({ error: "agent operation failed: read file: failed to read /root/nope.txt", code: "INTERNAL_ERROR" }));
      if (url.startsWith("/api/v1/machines/a/logs")) return send(200, 'data: {"level":"INFO"}\n\ndata: second\n\n', "text/event-stream");
      if (url === "/api/v1/machines/a/images/pull") return send(200, JSON.stringify({ image: { reference: "docker.io/library/busybox:latest", digest: "sha256:e0e8", size: 4170758, architecture: "arm64", os: "linux", layerCount: 1 } }));
      if (url === "/api/v1/machines/a" && req.method === "DELETE") return send(200, JSON.stringify({ deleted: "a" }));
      if (url === "/api/v1/machines/weird") return send(200, "<html>not json</html>", "text/html");
      send(404, JSON.stringify({ error: "no route", code: "NOT_FOUND" }));
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  client = new LocalClient(`unix://${sock}`);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("LocalClient parsing", () => {
  it("reads the version from /health, not from the spec", async () => {
    expect((await client.health()).version).toBe("1.14.3");
  });

  it("parses the machine list and keeps only the fields it needs", async () => {
    const list = await client.listMachines();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("a");
    expect(list[0]?.pid).toBe(7);
  });

  it("sends the schema's field names on create: network and memoryMb, never net or memory (constraint d)", async () => {
    seen.length = 0;
    await client.createMachine({ name: "b", image: "alpine", cpus: 1, memoryMb: 1024, network: { mode: "blocked" }, cmd: ["sleep", "1"] });
    const body = JSON.parse(seen[0]?.body ?? "{}");
    expect(body).toEqual({ name: "b", image: "alpine", cpus: 1, memoryMb: 1024, network: false, cmd: ["sleep", "1"] });
    expect(body).not.toHaveProperty("net");
    expect(body).not.toHaveProperty("memory");
  });

  it("publishes a port on the same host number by default, and carries mounts and both disk sizes", async () => {
    seen.length = 0;
    await client.createMachine({
      name: "b",
      image: "alpine",
      cpus: 1,
      memoryMb: 1024,
      network: { mode: "open" },
      ports: [{ guest: 8080 }, { guest: 80, host: 8081 }],
      mounts: [{ source: "/host/code", target: "/workspace", readonly: true }],
      storageGb: 40,
      overlayGb: 5,
    });
    const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    // The spec requires both halves of a mapping, so a caller who names only
    // the guest port gets the same number on the host rather than a 400.
    expect(body.ports).toEqual([{ host: 8080, guest: 8080 }, { host: 8081, guest: 80 }]);
    expect(body.mounts).toEqual([{ source: "/host/code", target: "/workspace", readonly: true }]);
    expect(body.storageGb).toBe(40);
    expect(body.overlayGb).toBe(5);
  });

  it("sends no ports, mounts or disk fields when the caller named none", async () => {
    seen.length = 0;
    await client.createMachine({ name: "b", image: "alpine", cpus: 1, memoryMb: 1024, network: { mode: "open" }, ports: [], mounts: [] });
    const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    for (const key of ["ports", "mounts", "storageGb", "overlayGb"]) expect(body, key).not.toHaveProperty(key);
  });

  it("carries an egress allow-list in allowedHosts, which the API enforces on the in-guest pull", async () => {
    seen.length = 0;
    await client.createMachine({ name: "b", image: "alpine", cpus: 1, memoryMb: 1024, network: { mode: "allow", hosts: ["registry-1.docker.io"], cidrs: [] } });
    const body = JSON.parse(seen[0]?.body ?? "{}");
    expect(body.allowedHosts).toEqual(["registry-1.docker.io"]);
    expect(body.network).toBe(false);
    expect(body).not.toHaveProperty("allowedCidrs");
  });

  it("turns an env map into the schema's name/value list", async () => {
    seen.length = 0;
    await client.exec("a", { command: ["true"], env: { FOO: "bar" }, workdir: "/w", timeoutSecs: 5 });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ command: ["true"], timeoutSecs: 5, workdir: "/w", env: [{ name: "FOO", value: "bar" }] });
  });

  it("turns an error body into a BackendError with the API's code", async () => {
    await expect(client.getMachine("missing")).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("machine 'missing' not found") });
  });

  it("reads exitCode from a 200 body", async () => {
    const r = await client.exec("a", { command: ["sh", "-c", "exit 3"] });
    expect(r).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("URL-encodes the absolute path in the files route and round-trips bytes", async () => {
    seen.length = 0;
    const up = await client.writeFile("a", "/root/a.txt", Buffer.from("PAYLOAD"));
    expect(up).toEqual({ path: "/root/a.txt", size: 7 });
    expect(seen[0]?.url).toBe("/api/v1/machines/a/files/%2Froot%2Fa.txt");
    expect((await client.readFile("a", "/root/a.txt")).toString()).toBe("PAYLOAD");
  });

  it("surfaces a missing file as INTERNAL_ERROR, which is what the API returns", async () => {
    await expect(client.readFile("a", "/root/nope.txt")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("parses SSE log lines and asks for tail without follow", async () => {
    seen.length = 0;
    expect(await client.logs("a", 5)).toEqual(['{"level":"INFO"}', "second"]);
    expect(seen[0]?.url).toBe("/api/v1/machines/a/logs?tail=5&follow=false");
  });

  it("parses the pull response", async () => {
    const img = await client.pullImage("a", "busybox");
    expect(img.reference).toBe("docker.io/library/busybox:latest");
    expect(img.layerCount).toBe(1);
  });

  it("parses delete", async () => {
    expect(await client.deleteMachine("a")).toEqual({ deleted: "a" });
  });

  it("reports a non-JSON 200 as BAD_RESPONSE", async () => {
    const err = await client.getMachine("weird").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).code).toBe("BAD_RESPONSE");
  });
});

describe("parseSseData", () => {
  it("keeps data lines only and strips the single leading space", () => {
    expect(parseSseData("event: stdout\ndata: line1\n\ndata:  two spaces\n\n: comment\n")).toEqual(["line1", " two spaces"]);
  });
});
