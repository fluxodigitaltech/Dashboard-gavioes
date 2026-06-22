/**
 * Meta Marketing API Service
 * Used to fetch campaign data and insights
 */

// O token NÃO vive mais no front. Estas chamadas vão pro proxy do backend
// (/api/meta/*), que injeta o token (env de runtime) — sem expor no JS público
// e sem precisar de rebuild pra trocar. Ver server/index.mjs.

export interface AdAccount {
  id: string;
  name: string;
  account_id: string;
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  insights?: CampaignInsights;
}

export interface CampaignInsights {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
  cpc: number;
  ctr: number;
  cpp: number;
  conversions?: { action_type: string; value: string }[];
}

/**
 * Fetch all ad accounts associated with the token
 */
export async function fetchAdAccounts(): Promise<AdAccount[]> {
  try {
    const response = await fetch('/api/meta/adaccounts');
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Meta API Error: ${response.status}`);
    }
    const accounts = (data.data || []).filter((acc: AdAccount) =>
      acc.name.toLowerCase().includes('gavioes')
    );
    return accounts;
  } catch (error) {
    console.error('Error fetching ad accounts:', error);
    throw error;
  }
}

/**
 * Fetch campaigns for a specific ad account
 */
export async function fetchCampaigns(adAccountId: string, dateFrom?: string, dateTo?: string): Promise<MetaCampaign[]> {
  try {
    const response = await fetch(`/api/meta/campaigns?account=${encodeURIComponent(adAccountId)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Meta API Error: ${response.status}`);
    }

    const campaigns: MetaCampaign[] = data.data || [];

    const insights = await fetchCampaignsInsights(adAccountId, dateFrom, dateTo);

    return campaigns.map(campaign => {
      const raw = insights.find(i => i.campaign_id === campaign.id);
      if (!raw) return campaign;
      const leadActions = (raw.actions || []).filter(
        (a: MetaInsightAction) =>
          a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
          a.action_type === 'onsite_conversion.messaging_conversation_started_30d' ||
          a.action_type === 'messaging_conversation_started'
      );
      const leads = leadActions.reduce((sum: number, a: MetaInsightAction) => sum + Number(a.value || 0), 0);
      const computedInsights: CampaignInsights = {
        spend:       Number(raw.spend       ?? 0),
        impressions: Number(raw.impressions ?? 0),
        reach:       Number(raw.reach       ?? 0),
        clicks:      Number(raw.clicks      ?? 0),
        cpc:         Number(raw.cpc         ?? 0),
        ctr:         Number(raw.ctr         ?? 0),
        cpp:         0,
        leads,
      };
      return { ...campaign, insights: computedInsights };
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    throw error;
  }
}

interface MetaInsightAction {
  action_type: string;
  value: string | number;
}

interface MetaInsight {
  campaign_id: string;
  campaign_name?: string;
  spend?: string | number;
  impressions?: string | number;
  reach?: string | number;
  clicks?: string | number;
  cpc?: string | number;
  ctr?: string | number;
  actions?: MetaInsightAction[];
}

/**
 * Fetch insights for all campaigns in an ad account for the last 30 days
 */
async function fetchCampaignsInsights(adAccountId: string, dateFrom?: string, dateTo?: string): Promise<MetaInsight[]> {
  const dateParam = dateFrom && dateTo ? `&from=${dateFrom}&to=${dateTo}` : '';
  const response = await fetch(
    `/api/meta/insights?account=${encodeURIComponent(adAccountId)}${dateParam}`
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return data.data || [];
}

/**
 * Fetch total spend for the last 30 days to use in financial KPIs
 */
export async function fetchTotalAdSpend(adAccountId: string): Promise<number> {
  try {
    const response = await fetch(`/api/meta/spend?account=${encodeURIComponent(adAccountId)}`);

    if (!response.ok) return 0;

    const data = await response.json();
    const totalSpend = (data.data ?? []).reduce(
      (sum: number, item: { spend?: string | number }) => sum + parseFloat(String(item.spend ?? '0')),
      0,
    ) || 0;

    return totalSpend;
  } catch (error) {
    console.error('Error fetching total ad spend:', error);
    return 0;
  }
}
