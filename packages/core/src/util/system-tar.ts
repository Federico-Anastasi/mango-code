import path from "path"

// The tar that ships with Windows (bsdtar) reads zip; PowerShell's Expand-Archive is not an option, as it fails with
// exit code 0 when the agent was started from a PowerShell 7 terminal. It is called by absolute path because a GNU tar
// from Git earlier on PATH does not read zip.
export function systemTar() {
  if (process.platform !== "win32") return "tar"
  if (!process.env.SystemRoot) throw new Error("SystemRoot is not set, so the system tar cannot be located")
  return path.join(process.env.SystemRoot, "System32", "tar.exe")
}
