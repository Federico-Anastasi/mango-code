import path from "path"
import { mkdir } from "fs/promises"
import { systemTar } from "@opencode-ai/core/util/system-tar"
import * as Process from "./process"

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    await mkdir(destDir, { recursive: true })
    await Process.run([systemTar(), "-xf", path.resolve(zipPath), "-C", path.resolve(destDir)])
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}

export * as Archive from "./archive"
