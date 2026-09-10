// The smoke script's header choice. It is a script rather than library code,
// but this one decision decides whether the script can be pointed at the
// shape the README calls the supported one, so it is worth asserting.
import { describe, expect, it } from "vitest";
// @ts-expect-error the script is plain JavaScript with no type declarations
import { smokeHeaders } from "../../scripts/smoke-http.mjs";

describe("which header carries which token", () => {
  it("puts the server's own token in authorization for a server on another host", () => {
    // This used to decide on whether the URL was loopback, so every address
    // that was not loopback was treated as a cloud ingress and the script
    // refused to run without an account key. The README tells a reader to
    // point it at a LAN address, which is neither loopback nor an ingress.
    expect(smokeHeaders("server-token", undefined)).toEqual({
      authorization: "Bearer server-token",
      "x-smol-mcp-token": "server-token",
    });
    expect(smokeHeaders("server-token", "")).toEqual({
      authorization: "Bearer server-token",
      "x-smol-mcp-token": "server-token",
    });
  });

  it("gives authorization to the account key when the caller is going through an ingress", () => {
    // The ingress spends authorization on the account key before the request
    // reaches the guest, which is the whole reason the second header exists.
    expect(smokeHeaders("server-token", "account-key")).toEqual({
      authorization: "Bearer account-key",
      "x-smol-mcp-token": "server-token",
    });
  });
});
