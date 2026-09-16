type JsonKind = "plain" | "key" | "string" | "number" | "boolean" | "null";
type JsonPart = { text: string; kind: JsonKind };

export const JSON_VIEW_LIMITS = { characters: 262144, parts: 4096 };

export function formatJson(text: string): { parts: JsonPart[]; limited: boolean } {
  const plain = (limited: boolean) => ({ parts: [{ text, kind: "plain" as const }], limited });
  if (text.length > JSON_VIEW_LIMITS.characters) return plain(true);
  try {
    JSON.parse(text);
  } catch {
    return plain(false);
  }

  // Keep the captured number literals, duplicate keys and string escapes intact.
  const tokens = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;
  const parts: JsonPart[] = [];
  let characters = 0,
    depth = 0,
    previous = "";
  function append(value: string, kind: JsonKind) {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += value;
    else parts.push({ text: value, kind });
    characters += value.length;
  }
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const token = match[0];
    const closing = token === "}" || token === "]";
    if (closing) depth--;
    const newline = closing
      ? previous !== (token === "}" ? "{" : "[")
      : previous === "{" || previous === "[" || previous === ",";
    const spaces = newline ? depth * 2 : previous === ":" ? 1 : 0;
    if (
      characters + token.length + spaces + Number(newline) > JSON_VIEW_LIMITS.characters ||
      parts.length + 2 > JSON_VIEW_LIMITS.parts
    )
      return plain(true);
    if (newline) append("\n" + " ".repeat(spaces), "plain");
    else if (spaces) append(" ", "plain");

    let kind: JsonKind = "plain";
    if (token.startsWith('"')) {
      let next = tokens.lastIndex;
      while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
      kind = text[next] === ":" ? "key" : "string";
    } else if (token === "true" || token === "false") kind = "boolean";
    else if (token === "null") kind = "null";
    else if (/[-\d]/.test(token[0])) kind = "number";
    append(token, kind);
    if (token === "{" || token === "[") depth++;
    previous = token;
  }
  return { parts, limited: false };
}

export function renderJson(target: HTMLElement, text: string) {
  const result = formatJson(text);
  const fragment = document.createDocumentFragment();
  for (const part of result.parts) {
    if (part.kind === "plain") fragment.append(document.createTextNode(part.text));
    else {
      const span = document.createElement("span");
      span.className = `json-${part.kind}`;
      span.textContent = part.text;
      fragment.append(span);
    }
  }
  target.replaceChildren(fragment);
  return result.limited;
}
