export type AgentRuntimeKind = 'external' | 'nuvem_reference'

export function resolveAgentRuntimeKind(
  selected: AgentRuntimeKind,
  externalSigner: string,
): AgentRuntimeKind {
  return selected === 'external' && externalSigner.trim() === ''
    ? 'nuvem_reference'
    : selected
}
