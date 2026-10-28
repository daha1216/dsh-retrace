/**
 * dsh-retrace — request origin helpers (pure, no host imports).
 *
 * The plugin route is unauthenticated by design, so the only real boundary is
 * "did this request arrive on the loopback interface?". The Host header alone
 * is not a boundary: any local process can forge it, and a DNS-rebinding page
 * makes Host and Origin agree by construction. These helpers keep that check
 * unit-testable without importing the whole HTTP aggregation.
 */

/** True for IPv4/IPv6 loopback addresses (incl. IPv4-mapped IPv6). */
export function loopbackAddress(address) {
  if (typeof address !== 'string') return false
  let value = address.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value === '::1') return true
  // Some stacks render an IPv4-mapped peer in hex (`::ffff:7f00:1`); accept it
  // before the dotted form so a dual-stack peer never trips the loopback gate.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value)
  if (mapped) {
    const hi = Number.parseInt(mapped[1], 16)
    const lo = Number.parseInt(mapped[2], 16)
    return loopbackAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (value.startsWith('::ffff:')) return loopbackAddress(value.slice('::ffff:'.length))
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part))
}

/** Host header → hostname (no port); '' when unparseable. */
export function hostNameOf(host) {
  if (typeof host !== 'string' || host.length === 0) return ''
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Loopback request gate. `remoteAllowed` mirrors DSH_RETRACE_ALLOW_REMOTE:
 * an explicit opt-in for tunnels/LAN keeps the old "any host" behaviour.
 * Otherwise both the socket peer and the Host header must be loopback, so a
 * forged Host from another interface (or a rebound DNS name) is rejected.
 */
export function isLoopbackRequest(req, { remoteAllowed = false } = {}) {
  if (remoteAllowed) return true
  if (!loopbackAddress(req?.socket?.remoteAddress)) return false
  const name = hostNameOf(req?.headers?.host)
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]'
}

/**
 * Drop a caller-supplied `span` from an editor request. The span decides which
 * surface range a marker replaces; when the client supplies it the server-side
 * rollback-share preflight (which only counts `sourceEventSeqs.length`) can be
 * bypassed by sending a short array with a wide start/end. The server always
 * recomputes the span from the session log instead.
 */
export function withoutClientSpan(args) {
  if (!args || typeof args !== 'object' || !('span' in args)) return args
  const { span: _ignored, ...rest } = args
  return rest
}
