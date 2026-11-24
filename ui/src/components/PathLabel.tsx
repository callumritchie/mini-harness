/** "a/b/c.json" → { dir: "a/b", base: "c.json" }. A trailing slash is ignored; a bare name has no dir. */
export function splitPath(path: string): { dir: string; base: string } {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? { dir: "", base: trimmed } : { dir: trimmed.slice(0, i), base: trimmed.slice(i + 1) };
}

/** A path shown file name first, folder after it and dimmed: in a deep project the folders are often the same for every file, so
 *  the end of the path is what tells files apart. The folder gives way first when space runs out; the full path is in the tooltip. */
export function PathLabel({ path, className = "" }: { path: string; className?: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span className={`pathlabel ${className}`} title={path}>
      <span className="pl-base">{base}</span>
      {dir && <><span className="sr-only">, in </span><span className="pl-dir">{dir}</span></>}
    </span>
  );
}
