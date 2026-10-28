/**
 * dsh-retrace — capability gates.
 *
 * Rollout is staged. 0.4.67 turns on boundary-time capture and the automatic
 * sweep: both are bounded (4 MB per file, deduplicated by content, retention
 * window plus grace) and neither writes to the workspace. Restore stays off
 * until a real session has produced enough captured history to exercise it,
 * because restore is the only path that writes user files.
 *
 * Gates are enforced on the host. Hiding a button in the client is a courtesy;
 * `assertCapability` and the `capability-disabled` error code are the contract.
 * Operators and tests can override a gate with
 * `DSH_RETRACE_CAPABILITIES='{"artifactGc":true}'` once the corresponding work
 * package lands.
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  /** recall / editAndResend / regenerate (marker append, no file writes). */
  contextEdit: true,
  /** rollback scope 'context' — needs a host-level surface restore. */
  contextRestore: false,
  /** boundary-time snapshot + git facts capture (read-only on the workspace). */
  artifactCapture: true,
  /** rollback scope 'artifacts' — git checkout / snapshot write-back. */
  artifactRestore: false,
  /** automatic refcount + object sweep (only objects nothing references). */
  artifactGc: true,
})

export const CAPABILITY_KEYS = Object.keys(DEFAULT_CAPABILITIES)

/**
 * Editor ops guarded by `contextEdit`. `fold` appends a marker just like
 * recall/edit; without the gate a read-only build (no verified writer contract)
 * still mutated the session log.
 */
const CONTEXT_EDIT_OPS = ['recall', 'editAndResend', 'regenerate', 'fold']

export function capabilityMessage(capability) {
  return `capability "${capability}" is disabled in this build`
}

export function capabilityError(capability) {
  const error = new Error(capabilityMessage(capability))
  error.code = 'capability-disabled'
  error.capability = capability
  return error
}

export function assertCapability(capabilities, capability) {
  if (capabilities?.[capability] !== true) throw capabilityError(capability)
}

/** Read the env override; malformed values fall back to the shipped defaults. */
export function capabilitiesFromEnv(env = globalThis.process?.env) {
  const raw = env?.DSH_RETRACE_CAPABILITIES
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Merge overrides over the shipped defaults; unknown keys are ignored. */
export function resolveCapabilities(overrides = {}) {
  const resolved = {}
  for (const key of CAPABILITY_KEYS) {
    const value = overrides?.[key]
    resolved[key] = typeof value === 'boolean' ? value : DEFAULT_CAPABILITIES[key]
  }
  return resolved
}

/** The capabilities a rollback scope depends on. */
export function capabilitiesForScope(scope) {
  switch (scope) {
    case 'context':
      return ['contextRestore']
    case 'artifacts':
      return ['artifactRestore']
    case 'both':
      return ['contextRestore', 'artifactRestore']
    default:
      return []
  }
}

/**
 * Wrap an editor api so gated ops answer with the standard failure envelope
 * instead of performing the write. Both transports use the same wrapper, so a
 * new transport cannot silently bypass a gate.
 */
export function gateEditorApi(api, capabilities) {
  const gated = { ...api }
  for (const op of CONTEXT_EDIT_OPS) {
    const inner = api?.[op]
    if (typeof inner !== 'function') continue
    gated[op] = async (args) => {
      if (capabilities?.contextEdit !== true) {
        return { ok: false, error: { code: 'capability-disabled', message: capabilityMessage('contextEdit') } }
      }
      return inner(args)
    }
  }
  return gated
}
