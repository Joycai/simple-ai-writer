/**
 * Resolve a possibly-relative resource path against a base directory.
 *
 * Normalizes `/` and `\` separators and collapses `.` / `..` segments so that
 * links written relative to a markdown file (e.g. `../ext_images/foo.png`) map
 * to a real absolute path. Inputs that are already absolute — drive-letter
 * (`C:/…`) or POSIX-root (`/…`) — are returned normalized without rebasing.
 */
export function resolveRelativePath(baseDir: string, rel: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const relN = norm(rel);

  const isAbsolute = /^[a-zA-Z]:\//.test(relN) || relN.startsWith("/");
  const combined = isAbsolute ? relN : `${norm(baseDir)}/${relN}`;

  const out: string[] = [];
  combined.split("/").forEach((seg, i) => {
    if (seg === "") {
      if (i === 0) out.push(""); // preserve a leading POSIX root
      return;
    }
    if (seg === ".") return;
    if (seg === "..") {
      const top = out[out.length - 1];
      if (out.length && top !== "" && top !== "..") out.pop();
      else out.push("..");
      return;
    }
    out.push(seg);
  });

  return out.join("/");
}
