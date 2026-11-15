// mango-code: the engine that draws stays on after a picture of a conversation, holding its model in memory, so that the
// next picture starts sooner. It is put away when the user has left pictures: the box went back to «Text», the
// conversation was closed or left for another one or for the Home. Switching from one picture conversation to another
// is not leaving, so the app is asked a moment after the last view of pictures is gone. It is asked once and decides:
// an engine that stayed on stops, and one that is drawing stops when its picture is made.

export type PictureEngineDeps = {
  /** Asks the app to stop the engine that draws. */
  unload: () => Promise<void>
  /** Calls `run` after `ms`; the result cancels it. */
  later: (ms: number, run: () => void) => () => void
  /** How long the last view of pictures has been gone before the app is asked. */
  grace: number
}

export function createPictureEngine(deps: PictureEngineDeps) {
  let views = 0
  let cancel: (() => void) | undefined
  return {
    /** Pictures are on view (the box on «Picture»), or being asked for. The result ends it, once. */
    enter() {
      views++
      cancel?.()
      cancel = undefined
      let left = false
      return () => {
        if (left) return
        left = true
        views--
        if (views > 0) return
        cancel = deps.later(deps.grace, () => {
          cancel = undefined
          void deps
            .unload()
            .catch((cause: unknown) => console.error(`the image engine could not be put away: ${String(cause)}`))
        })
      }
    },
  }
}

export type PictureEngine = ReturnType<typeof createPictureEngine>
