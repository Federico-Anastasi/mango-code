let files: Record<string, () => Promise<string>> | undefined
let loads: Record<SoundID, () => Promise<string>> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob("../../../ui/src/assets/audio/*.aac", { import: "default" }) as Record<
    string,
    () => Promise<string>
  >
  return files
}

const SOUND_IDS = [
  "alert-01",
  "alert-02",
  "alert-03",
  "alert-04",
  "alert-05",
  "alert-06",
  "alert-07",
  "alert-08",
  "alert-09",
  "alert-10",
  "bip-bop-01",
  "bip-bop-02",
  "bip-bop-03",
  "bip-bop-04",
  "bip-bop-05",
  "bip-bop-06",
  "bip-bop-07",
  "bip-bop-08",
  "bip-bop-09",
  "bip-bop-10",
  "staplebops-01",
  "staplebops-02",
  "staplebops-03",
  "staplebops-04",
  "staplebops-05",
  "staplebops-06",
  "staplebops-07",
  "nope-01",
  "nope-02",
  "nope-03",
  "nope-04",
  "nope-05",
  "nope-06",
  "nope-07",
  "nope-08",
  "nope-09",
  "nope-10",
  "nope-11",
  "nope-12",
  "yup-01",
  "yup-02",
  "yup-03",
  "yup-04",
  "yup-05",
  "yup-06",
] as const

type SoundID = (typeof SOUND_IDS)[number]

function getLoads() {
  if (loads) return loads
  loads = Object.fromEntries(
    Object.entries(getFiles()).flatMap(([path, load]) => {
      const file = path.split("/").at(-1)
      if (!file) return []
      return [[file.replace(/\.aac$/, ""), load] as const]
    }),
  ) as Record<SoundID, () => Promise<string>>
  return loads
}

const cache = new Map<SoundID, Promise<string | undefined>>()

export function soundSrc(id: string | undefined) {
  const loads = getLoads()
  if (!id || !(id in loads)) return Promise.resolve(undefined)
  const key = id as SoundID
  const hit = cache.get(key)
  if (hit) return hit
  const next = loads[key]().catch(() => undefined)
  cache.set(key, next)
  return next
}

export function playSound(src: string | undefined) {
  if (typeof Audio === "undefined") return
  if (!src) return
  const audio = new Audio(src)
  audio.play().catch(() => undefined)
  return () => {
    audio.pause()
    audio.currentTime = 0
  }
}

export function playSoundById(id: string | undefined) {
  return soundSrc(id).then((src) => playSound(src))
}
