import type { GuideArtifact, GuideTarget } from "../review-guidance-types.ts";
const svg = (name: string, attrs: Record<string, string | number> = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};
function arrow(root: SVGElement, from: number[], to: number[]) {
  root.append(svg("line", { x1: from[0], y1: from[1], x2: to[0], y2: to[1] }));
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const left = [to[0] - 10 * Math.cos(angle - 0.5), to[1] - 10 * Math.sin(angle - 0.5)];
  const right = [to[0] - 10 * Math.cos(angle + 0.5), to[1] - 10 * Math.sin(angle + 0.5)];
  root.append(svg("polyline", { points: `${left.join(",")} ${to.join(",")} ${right.join(",")}` }));
}
export function imageMarks(image: HTMLImageElement, artifacts: GuideArtifact[], id: string) {
  if (image.parentElement?.classList.contains("review-image-marked"))
    image.parentElement.replaceWith(image);
  const marks = artifacts.filter(
    (a) => !a.invalid && a.target.kind === "image" && a.target.image === id,
  );
  if (!marks.length) return;
  const target = marks[0].target as Extract<GuideTarget, { kind: "image" }>;
  const wrap = document.createElement("div");
  wrap.className = "review-image-marked";
  image.replaceWith(wrap);
  wrap.append(image);
  const root = svg("svg", {
    viewBox: `0 0 ${target.width} ${target.height}`,
    "aria-label": "Agent-generated screenshot annotations",
  });
  root.classList.add("review-drawing");
  for (const item of marks) {
    if (item.target.kind !== "image") continue;
    for (const mark of item.target.marks) {
      if (mark.kind === "stroke")
        root.append(svg("polyline", { points: mark.points.map((p) => p.join(",")).join(" ") }));
      else if (mark.kind === "arrow") arrow(root, mark.points[0], mark.points[1]);
      else {
        const text = svg("text", { x: mark.points[0][0], y: mark.points[0][1] });
        text.textContent = mark.text;
        root.append(text);
      }
    }
  }
  wrap.append(root);
}
function lines(value: string) {
  return Array.from(value.matchAll(/.{1,22}/gu), (match) => match[0]);
}
function label(root: SVGElement, value: string, x: number, y: number, centered = false) {
  const node = svg("text", { x, y, "text-anchor": centered ? "middle" : "start" });
  for (const [i, line] of lines(value).entries()) {
    const span = svg("tspan", { x, dy: i ? 18 : 0 });
    span.textContent = line;
    node.append(span);
  }
  root.append(node);
}
export function sequenceDiagram(target: Extract<GuideTarget, { kind: "diagram" }>) {
  const top = Math.max(...target.nodes.map((name) => lines(name).length)) * 18 + 32;
  const height = top + target.messages.reduce((sum, m) => sum + lines(m.text).length * 18 + 52, 0);
  const root = svg("svg", {
    viewBox: `0 0 ${target.nodes.length * 240} ${height}`,
    role: "img",
    "aria-label": "Agent-generated sequence diagram",
  });
  root.classList.add("review-sequence");
  root.style.minWidth = `${Math.max(600, target.nodes.length * 240)}px`;
  target.nodes.forEach((name, i) => {
    label(root, name, i * 240 + 120, 24, true);
    root.append(
      svg("line", {
        x1: i * 240 + 120,
        x2: i * 240 + 120,
        y1: top - 12,
        y2: height,
        "stroke-dasharray": "4 6",
      }),
    );
  });
  let y = top;
  for (const m of target.messages) {
    const x1 = 120 + m.from * 240,
      x2 = 120 + m.to * 240;
    label(root, m.text, Math.min(x1, x2) - 100, y + 18);
    y += lines(m.text).length * 18 + 28;
    if (m.from === m.to) {
      root.append(svg("polyline", { points: `${x1},${y} ${x1 + 60},${y} ${x1 + 60},${y + 16}` }));
      arrow(root, [x1 + 60, y + 16], [x1, y + 16]);
    } else arrow(root, [x1, y], [x2, y]);
    y += 24;
  }
  return root;
}
