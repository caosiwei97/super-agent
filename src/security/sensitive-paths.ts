import { basename, isAbsolute, relative, sep } from 'node:path'

/**
 * Classifies credential-bearing paths. Callers that accept symlinks must pass
 * the canonical realpath, not the user-supplied spelling.
 */
export function isSensitivePath(candidate: string, workspaceRoot?: string) {
  const scoped = workspaceRoot === undefined ? candidate : relative(workspaceRoot, candidate)
  const parts = scoped.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  const lower = parts.map((part) => part.toLowerCase())
  const name = basename(candidate).toLowerCase()

  if (name === '.env' || name.startsWith('.env.')) return true
  if (name === '.npmrc' || name === '.netrc' || name === '.git-credentials' || name === '.pypirc') {
    return true
  }
  if (name.endsWith('.pem') || name.endsWith('.key')) return true
  if (name.endsWith('.keychain') || name.endsWith('.keychain-db')) return true
  if (name.endsWith('.json') && /(?:^|[-_.])(service[-_]?account|credentials?)(?:[-_.]|$)/.test(name)) {
    return true
  }

  const ssh = lower.lastIndexOf('.ssh')
  if (ssh >= 0 && (ssh === lower.length - 1 || lower[ssh + 1].startsWith('id'))) return true

  const aws = lower.lastIndexOf('.aws')
  if (aws >= 0 && lower[aws + 1] === 'credentials') return true

  const gcloud = lower.lastIndexOf('gcloud')
  if (gcloud >= 0 && (
    gcloud === lower.length - 1
    || /^(?:application_default_credentials\.json|credentials\.db|access_tokens\.db)$/.test(lower[gcloud + 1] ?? '')
  )) return true

  const azure = lower.lastIndexOf('.azure')
  if (azure >= 0 && (
    azure === lower.length - 1
    || /^(?:accesstokens\.json|azureprofile\.json|msal_token_cache(?:\.json|\.bin)?)$/.test(lower[azure + 1] ?? '')
  )) return true

  const kube = lower.lastIndexOf('.kube')
  if (kube >= 0 && (kube === lower.length - 1 || lower[kube + 1] === 'config')) return true
  if (name.endsWith('.kubeconfig')) return true

  const library = lower.lastIndexOf('library')
  if (library >= 0 && lower[library + 1] === 'keychains') return true

  return false
}

/** Conservative counterpart for an explicit glob spelling. */
export function isSensitivePathPattern(pattern: string) {
  const normalized = pattern.replaceAll('\\', '/').toLowerCase()
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (name.startsWith('.env')) return true
  if (name.endsWith('.pem') || name.endsWith('.key')) return true
  if (['.npmrc', '.netrc', '.git-credentials', '.pypirc'].includes(name)) return true
  if ((name.includes('service-account') || name.includes('service_account') || name.includes('credentials'))
    && name.endsWith('.json')) return true
  return /(?:^|\/)\.ssh\/id/.test(normalized)
    || /(?:^|\/)\.aws\/credentials(?:$|\/)/.test(normalized)
    || normalized.includes('gcloud/')
    || normalized.includes('.azure/')
    || normalized.includes('.kube/config')
    || name.endsWith('.kubeconfig')
}

export function isPathWithin(root: string, candidate: string) {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}
