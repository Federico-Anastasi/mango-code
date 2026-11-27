/** Where a path that starts with one slash is on this computer, which runs Windows (`mango-linux-path.mjs`). */
export function fromLinux(
  project: string,
  written: string,
  has: (name: string) => boolean,
): { path: string; moved: boolean } | undefined
