/**
 * Paths that typically trigger macOS TCC prompts (Documents / Desktop /
 * Downloads / iCloud). Used to avoid touching them until the user opts in.
 */
export function isLikelyMacProtectedPath(path: string): boolean {
  const n = path.replace(/\\/g, "/");
  if (!n) return false;
  return (
    /\/Documents(\/|$)/i.test(n) ||
    /\/Desktop(\/|$)/i.test(n) ||
    /\/Downloads(\/|$)/i.test(n) ||
    /\/Library\/Mobile Documents\//i.test(n) ||
    /\/iCloud~?Drive(\/|$)/i.test(n) ||
    /\/com~apple~CloudDocs(\/|$)/i.test(n)
  );
}
