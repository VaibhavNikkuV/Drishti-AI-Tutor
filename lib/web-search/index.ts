/**
 * Web Search Dispatcher
 *
 * Unified entry point that routes to the correct provider adapter based on the
 * selected `WebSearchProviderId`. Keep adapter-specific logic out of callers
 * so that adding a new provider requires only a new adapter + a new case here.
 */

import type { WebSearchResult } from '@/lib/types/web-search';
import type { WebSearchProviderId } from './types';
import { searchWithTavily } from './tavily';
import { searchWithPerplexity } from './perplexity';

export { formatSearchResultsAsContext } from './tavily';
export { searchWithTavily } from './tavily';
export { searchWithPerplexity } from './perplexity';

export interface SearchWebParams {
  query: string;
  apiKey: string;
  baseUrl?: string;
  maxResults?: number;
}

export async function searchWeb(
  providerId: WebSearchProviderId,
  params: SearchWebParams,
): Promise<WebSearchResult> {
  switch (providerId) {
    case 'tavily':
      return searchWithTavily(params);
    case 'perplexity':
      return searchWithPerplexity(params);
    default: {
      const _exhaustive: never = providerId;
      throw new Error(`Unsupported web search provider: ${String(_exhaustive)}`);
    }
  }
}
