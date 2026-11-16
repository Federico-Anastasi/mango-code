// mango-code: the engine that draws stays on after a picture of a conversation, holding its model in memory, so that the
// next picture starts sooner. It is put away when the user has left pictures: the box went back to «Text», the
// conversation was closed or left for another one or for the Home. Switching from one picture conversation to another
// is not leaving, so the app is asked a moment after the last view of pictures is gone. It is asked once and decides:
// an engine that stayed on stops, and one that is drawing stops when its picture is made.
// Showing pictures in this tab (the box on «Picture», or a picture being asked for) leaves a note that survives a
// reload, until the app has been asked to put the engine away: a page started again finds it and does it, unless
// pictures are on view again. A page that never showed pictures never asks, whoever turned the engine on.
// The page cannot say whether pictures are on view until it has read the app's state and the models that draw, and
// each box its messages: the wait does not start before that, however long it takes.

export type PictureEngineDeps = {
  /** Asks the app to stop the engine that draws. */
  unload: () => Promise<void>
  /** Calls `run` after `ms`; the result cancels it. */
  later: (ms: number, run: () => void) => () => void
  /** How long the last view of pictures has been gone before the app is asked. */
  grace: number
  /** Whether pictures were shown here, or in the page this one replaces, and the engine has not been put away since. */
  owed: { read: () => boolean; write: (owed: boolean) => void }
}

export function createPictureEngine(deps: PictureEngineDeps) {
  let views = 0
  // How many times pictures came into view: a put-away that was asked before the last one is not the end of the note.
  let entries = 0
  let cancel: (() => void) | undefined
  // The page does not know yet whether pictures are on view: the first read, and each box that has not said.
  let undecided = 0
  const putAway = () => {
    cancel?.()
    cancel = undefined
    if (views > 0 || undecided > 0 || !deps.owed.read()) return
    const asked = entries
    cancel = deps.later(deps.grace, () => {
      cancel = undefined
      void deps
        .unload()
        .then(() => {
          if (views === 0 && entries === asked) deps.owed.write(false)
        })
        .catch((cause: unknown) => console.error(`the image engine could not be put away: ${String(cause)}`))
    })
  }
  const hold = () => {
    undecided++
    cancel?.()
    cancel = undefined
    let done = false
    return () => {
      if (done) return
      done = true
      undecided--
      putAway()
    }
  }
  const firstRead = hold()
  return {
    /** Pictures are on view (the box on «Picture»), or being asked for. The result ends it, once. */
    enter() {
      views++
      entries++
      deps.owed.write(true)
      cancel?.()
      cancel = undefined
      let left = false
      return () => {
        if (left) return
        left = true
        views--
        putAway()
      }
    },
    /** A box is working out whether pictures are on view. The result says it is done, once; until then nothing is put away. */
    undecided: hold,
    /** The first read of the app's state and of the models that draw has come. Before it nothing is put away. */
    firstRead,
  }
}

export type PictureEngine = ReturnType<typeof createPictureEngine>
