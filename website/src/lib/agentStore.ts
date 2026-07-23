import type { Tables } from './database.types'
import { getSupabaseClient } from './supabase'

export type PublicAgentProfile = Tables<'agent_profiles'>
export type PublicAgentDecision = Tables<'agent_decisions'>

export type AgentDashboardRecord = PublicAgentProfile & { decisions: PublicAgentDecision[] }

export async function loadAgentDashboards(sponsor?: string): Promise<AgentDashboardRecord[]> {
  const client = getSupabaseClient()
  if (!client) return []
  let query = client.from('agent_profiles').select('*').order('updated_at', { ascending: false }).limit(24)
  if (sponsor) query = query.eq('sponsor_wallet', sponsor.toLowerCase())
  const { data: profiles, error } = await query
  if (error) throw error
  if (!profiles?.length) return []
  const ids = profiles.map((profile) => profile.agent_id)
  const { data: decisions, error: decisionError } = await client
    .from('agent_decisions')
    .select('*')
    .in('agent_id', ids)
    .order('occurred_at', { ascending: false })
    .limit(120)
  if (decisionError) throw decisionError
  return profiles.map((profile) => ({
    ...profile,
    decisions: (decisions ?? []).filter((decision) => decision.agent_id === profile.agent_id).slice(0, 8),
  }))
}
