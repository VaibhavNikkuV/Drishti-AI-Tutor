/**
 * Web Search API
 *
 * POST /api/web-search
 * Simple JSON request/response. Dispatches to the selected web-search provider.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { searchWeb, formatSearchResultsAsContext } from '@/lib/web-search';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { resolveWebSearchApiKey, resolveWebSearchBaseUrl } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { AICallFn } from '@/lib/generation/pipeline-types';

const log = createLogger('WebSearch');

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      apiKey: clientApiKey,
      providerId,
    } = body as {
      query?: string;
      pdfText?: string;
      apiKey?: string;
      providerId?: WebSearchProviderId;
    };
    query = requestQuery;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    if (!providerId || !WEB_SEARCH_PROVIDERS[providerId]) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `providerId is required and must be one of: ${Object.keys(WEB_SEARCH_PROVIDERS).join(', ')}`,
      );
    }

    const providerName = WEB_SEARCH_PROVIDERS[providerId].name;

    const apiKey = resolveWebSearchApiKey(providerId, clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        `${providerName} API key is not configured. Set it in Settings → Web Search or set the provider env var.`,
      );
    }
    const baseUrl = resolveWebSearchBaseUrl(providerId);

    // Clamp rewrite input at the route boundary; framework body limits still apply to total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    let aiCall: AICallFn | undefined;
    try {
      const { model: languageModel } = await resolveModelFromHeaders(req);
      aiCall = async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: languageModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
        );
        return result.text;
      };
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      providerId,
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    const result = await searchWeb(providerId, { query: searchQuery.query, apiKey, baseUrl });
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
