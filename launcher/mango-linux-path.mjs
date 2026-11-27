// A small model writes the paths of the computers it was trained on: `/home/user/site/index.html`, `/tmp/out.log`. On
// Windows such a path names nothing the model meant: taken as it is, it lands in a new folder at the root of the drive
// and the project stays empty. It is taken from the project folder instead. One rule for every tool of Mango Code that
// takes a path (the agent's file tools, Mango Harness 2's, the browser's), so a file one of them writes is where the
// others look for it.
import path from "node:path";

// The folders a Linux path starts with that are not part of what the model is naming: `/home/<user>`, `/tmp`, ...
const LINUX_ROOTS = new Set("home root tmp workspace workspaces testbed project app mnt var usr opt srv etc data output".split(" "));
// The folders at the root of a Windows drive that a path without a drive may really mean.
const WINDOWS_ROOTS = new Set(["users", "windows", "program files", "program files (x86)", "programdata"]);

const inside = (child, parent) => {
  const relative = path.win32.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
};

/**
 * Where a path that starts with one slash is on this computer, which runs Windows.
 * @param {string} project the project folder
 * @param {string} written the path as the model wrote it
 * @param {(name: string) => boolean} has whether the project folder holds a file or a folder with this name
 * @returns {{ path: string, moved: boolean } | undefined} `moved`: written for another computer and taken from the
 *   project folder; undefined for a path that does not start with one slash (relative, with a drive, a network one)
 */
export function fromLinux(project, written, has) {
  if (!/^[\\/](?![\\/])/.test(written)) return undefined;
  const parts = written.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const root = parts[0].toLowerCase();
  // A drive written as a folder: Git Bash `/c/Users`, WSL `/mnt/c/Users`, Cygwin `/cygdrive/c/Users`.
  const drive = /^[a-z]$/.test(root) ? 0 : ["mnt", "cygdrive"].includes(root) && /^[a-z]$/i.test(parts[1] ?? "") ? 1 : -1;
  if (drive >= 0) return { path: path.win32.join(`${parts[drive].toUpperCase()}:\\`, ...parts.slice(drive + 1)), moved: false };
  const plain = path.win32.resolve(project, written);
  if (inside(plain, project) || WINDOWS_ROOTS.has(root)) return { path: plain, moved: false };
  const named = parts.map((part) => part.toLowerCase()).lastIndexOf(path.win32.basename(project).toLowerCase());
  // `/data/orders.csv` in a project that has `data` names that folder, not a root of Linux.
  const skipped = named >= 0 ? named + 1 : has(parts[0]) ? 0 : root === "home" ? 2 : LINUX_ROOTS.has(root) ? 1 : 0;
  // `/home/report.pdf`: a file right under the home is the file, not a user's folder.
  const rest = skipped === 2 && parts.length === 2 && parts[1].includes(".") ? [parts[1]] : parts.slice(skipped);
  return { path: path.win32.join(project, ...rest), moved: true };
}
