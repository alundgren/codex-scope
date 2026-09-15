/** Parsed conveniences never replace the original accepted hook text. */
export function callMetadata(text: string) {
  const value = JSON.parse(text) as Record<string, unknown>;
  const input = value.tool_input;
  const args =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const command = args?.command ?? args?.cmd;
  const response = value.tool_response;
  return {
    model: typeof value.model === "string" ? value.model : null,
    command: typeof command === "string" ? command : null,
    responseBytes:
      response === undefined
        ? null
        : Buffer.byteLength(typeof response === "string" ? response : JSON.stringify(response)),
  };
}
