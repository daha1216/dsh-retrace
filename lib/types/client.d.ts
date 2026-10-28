/**
 * Client entry type stub. The client half is plain ESM importing React and
 * registering `slots`, `locale` and the `uiConversation` service.
 */
export const name: 'dsh-retrace'
export const inject: string[]
export function apply(ctx: unknown): void

/**
 * Swap the transport the client uses to reach the Host. The published client
 * defaults to the same-origin HTTP route; embedders (or a future generated
 * dynamic entry) can install a `host.call` wire before apply. The dynamic
 * entries themselves were removed in 0.4.66, so this is null in production
 * builds and every op goes through the HTTP route.
 */
export function __setMessageEditorWire(fn: ((op: string, payload: unknown) => Promise<unknown>) | null): void
