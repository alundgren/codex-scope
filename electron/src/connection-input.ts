export function validToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length <= 256 &&
    /^[A-Za-z0-9._~+/-]{1,256}={0,2}$/.test(token)
  );
}
export function connectionInput(endpoint: string, token: string) {
  if (endpoint.length > 4096 || token.length > 256)
    throw new Error("Connection settings are too long.");
  endpoint = endpoint.trim();
  if (!endpoint.includes("?")) return { endpoint, token };
  const url = new URL(endpoint);
  const keys = [...url.searchParams.keys()];
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/" ||
    keys.length !== 1 ||
    keys[0] !== "token" ||
    /%(?![0-9a-f]{2})/i.test(url.search)
  )
    throw new Error("Paste an origin URL or a pairing URL with one token parameter.");
  const secret = url.searchParams.get("token");
  if (!validToken(secret)) throw new Error("The pairing URL has an invalid token.");
  // Keep the supplied origin spelling for the strict origin validator.
  return { endpoint: endpoint.slice(0, endpoint.indexOf("?")), token: secret };
}
