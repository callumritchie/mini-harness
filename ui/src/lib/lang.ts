const BY_EXTENSION: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  json: "json", md: "markdown", sh: "bash", zsh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  html: "xml", xml: "xml", css: "css", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", rb: "ruby", sql: "sql",
  txt: "plaintext",
};

/** A highlight language for a file path, or undefined for plain text. */
export function languageFor(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  if (name === "Dockerfile") return "dockerfile";
  if (name === "Makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return BY_EXTENSION[ext];
}

export function formatCost(usd: number | null, complete = true): string {
  if (usd === null) return "unknown";
  const s = usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  return complete ? s : `${s}+`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
