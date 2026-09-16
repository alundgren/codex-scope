import { expect, test } from "vite-plus/test";
import { formatJson, JSON_VIEW_LIMITS } from "../src/ui/json.ts";

test("indents JSON objects and arrays and distinguishes keys from escaped string values", () => {
  const value = {
    command: 'printf "hello"\nnext line',
    options: { enabled: true, attempts: 3, timeout: null },
    results: [false, -2.5e10, {}, []],
  };
  const result = formatJson(JSON.stringify(value));
  expect(result.limited).toBe(false);
  expect(result.parts.map((part) => part.text).join("")).toBe(JSON.stringify(value, null, 2));
  expect(result.parts.filter((part) => part.kind === "key").map((part) => part.text)).toEqual([
    '"command"',
    '"options"',
    '"enabled"',
    '"attempts"',
    '"timeout"',
    '"results"',
  ]);
  expect(new Set(result.parts.map((part) => part.kind))).toEqual(
    new Set(["plain", "key", "string", "number", "boolean", "null"]),
  );
});

test("preserves number literals, repeated keys, key order and string escapes", () => {
  const result = formatJson(
    '{"2":9007199254740993,"1":-0,"same":1e+03,"same":"\\u0061", "\\\"key": "</span><script>text</script>"}',
  );
  expect(result.parts.map((part) => part.text).join("")).toBe(
    '{\n  "2": 9007199254740993,\n  "1": -0,\n  "same": 1e+03,\n  "same": "\\u0061",\n  "\\\"key": "</span><script>text</script>"\n}',
  );
});

test("leaves non-JSON responses and incomplete JSON untouched", () => {
  for (const text of ["", "line one\nline two", '{"unfinished":', '<script>alert("text")</script>'])
    expect(formatJson(text)).toEqual({ parts: [{ kind: "plain", text }], limited: false });
});

test("bounds indentation and token allocation without truncating complete text", () => {
  for (const text of [
    "[".repeat(30000) + "0" + "]".repeat(30000),
    "[" + "0,".repeat(20000) + "0]",
    " ".repeat(JSON_VIEW_LIMITS.characters + 1),
  ])
    expect(formatJson(text)).toEqual({ parts: [{ kind: "plain", text }], limited: true });
});

test("formats large strings within the accepted payload limit", () => {
  const value = { response: "long text ".repeat(6000) };
  const result = formatJson(JSON.stringify(value));
  expect(result.limited).toBe(false);
  expect(result.parts.map((part) => part.text).join("")).toBe(JSON.stringify(value, null, 2));
  expect(result.parts.length).toBeLessThan(JSON_VIEW_LIMITS.parts);
});
