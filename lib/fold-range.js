/**
 * dsh-retrace — the fold range predicate, in one place.
 *
 * A fold covers a contiguous span of surface nodes `[start..end]`. Both
 * endpoints travel through three transports (HTTP JSON, the harness RPC
 * bridge, and direct `api.fold` calls), so each of them has to reject a
 * malformed range BEFORE anything derives a span or writes a marker.
 *
 * The checks must run on the RAW values. `Number()` is not usable here: it
 * maps `null`, `''` and `false` to a perfectly valid `0`, and `true` to `1`,
 * so a JSON body carrying the wrong types would silently fold the first node
 * of the conversation. Only a number that is already a safe integer passes.
 */

/** Whether `start..end` is a usable fold range (raw values, no coercion). */
export function isFoldRange(start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
}
