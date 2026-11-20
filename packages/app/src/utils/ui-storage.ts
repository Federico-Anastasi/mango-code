// Where the interface keeps what it remembers. In a normal browser, and on the phone, that is the browser's own
// `localStorage`. Inside the Mango Code window the app keeps it on disk (`ui-state.ts` installs the store), so that it does
// not depend on the port the page is served from.

export type UiStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">

let backing: UiStorage | undefined

/** From now on the interface keeps its state in `storage`; `undefined` goes back to the browser's. */
export function useUiStorage(storage: UiStorage | undefined) {
  backing = storage
}

const current = (): UiStorage => backing ?? localStorage

export const uiStorage: UiStorage = {
  get length() {
    return current().length
  },
  key: (index) => current().key(index),
  getItem: (key) => current().getItem(key),
  setItem: (key, value) => current().setItem(key, value),
  removeItem: (key) => current().removeItem(key),
}
