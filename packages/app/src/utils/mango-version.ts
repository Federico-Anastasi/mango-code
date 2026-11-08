// Mango Code's version is the desktop app's (tauri.conf.json). package.json keeps opencode's, which the layout and
// release-highlights logic compare, so `platform.version` stays opencode's.
import tauri from "../../../../app/src-tauri/tauri.conf.json"

export const mangoVersion = tauri.version
