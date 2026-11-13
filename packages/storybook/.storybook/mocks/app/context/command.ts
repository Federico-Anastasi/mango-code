export function useCommand() {
  return {
    options: [],
    register() {
      return () => undefined
    },
    trigger() {},
  }
}
