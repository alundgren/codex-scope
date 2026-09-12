// Match the existing 160-character summary budget; original payloads stay intact.
const display = (value: string) => {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 160 ? clean.slice(0, 159) + "…" : clean;
};
export function eventContext(cwd: unknown, git: unknown): string | undefined {
  if (git && typeof git === "object" && !Array.isArray(git)) {
    const value = git as Record<string, unknown>;
    if (
      typeof value.repo === "string" &&
      value.repo.length > 0 &&
      Buffer.byteLength(value.repo) <= 512 &&
      (value.branch === null ||
        (typeof value.branch === "string" &&
          value.branch.length > 0 &&
          Buffer.byteLength(value.branch) <= 512)) &&
      typeof value.observed_at === "string" &&
      value.observed_at.length <= 40 &&
      Number.isFinite(Date.parse(value.observed_at))
    ) {
      const repo = display(value.repo);
      const branch = value.branch === null ? "branch unavailable" : display(value.branch as string);
      if (repo && branch) return display(`${repo} · ${branch}`);
    }
  }
  if (typeof cwd !== "string" || !cwd.startsWith("/") || Buffer.byteLength(cwd) > 4096)
    return undefined;
  const parts = cwd.split("/").filter(Boolean);
  const worktree = parts.indexOf(".t3");
  const label =
    worktree >= 0 && parts[worktree + 1] === "worktrees"
      ? parts.slice(worktree + 2, worktree + 4).join(" / ")
      : parts.at(-1);
  return label ? display(label) || undefined : undefined;
}
export function sessionLabel(id: string, context?: string): string {
  if (!context) return id || "Empty session ID";
  const suffix = id.length > 8 ? `…${id.slice(-8)}` : id || "Empty session ID";
  return `${context} · ${display(suffix)}`;
}
