import { ServerConnection } from "@/context/server"
import type { Platform } from "@/context/platform"

/** `bridge`: the web UI runs in the Mango Code desktop app and has its native picker. */
export function directoryPickerKind(platform: Platform["platform"], server: ServerConnection.Any, bridge = false) {
  if ((platform === "desktop" || bridge) && ServerConnection.local(server)) return "native" as const
  return "server" as const
}
