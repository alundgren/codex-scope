import { test, expect } from "vite-plus/test";
import { callMetadata } from "../src/call-metadata.ts";
test("response bytes measure UTF-8 text or compact JSON while missing is unknown and empty is zero", () => {
  for (const [response, bytes] of [
    ["é", 2],
    ["", 0],
    [null, 4],
    [{ ok: true }, 11],
    [false, 5],
    [[1, 2], 5],
  ] as const) {
    expect(callMetadata(JSON.stringify({ tool_response: response })).responseBytes).toBe(bytes);
  }
  expect(callMetadata("{}").responseBytes).toBeNull();
  expect(callMetadata(JSON.stringify({ model: "a", tool_input: { cmd: "rg files" } }))).toEqual({
    model: "a",
    command: "rg files",
    responseBytes: null,
  });
});
