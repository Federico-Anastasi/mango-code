// mango-code: the app's provider of local models (agent-cfg `PROVIDER`): one model for each model of this PC's catalog.
// What the menus say about each one comes from `context/mango.tsx`.
export const MANGO_PROVIDER = "mango"
/** The external servers (agent-cfg `servers`): one provider each, `server-<n>`, named after the server's host. */
export const isServerProvider = (id: string) => id.startsWith("server-")
/** The models the app's menus offer: this PC's and the external servers'. */
export const offeredProvider = (id: string) => id === MANGO_PROVIDER || isServerProvider(id)
