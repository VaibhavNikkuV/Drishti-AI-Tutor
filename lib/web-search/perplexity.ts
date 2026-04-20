/**
 * Perplexity Web Search Integration
 *
 * Uses raw REST API via proxyFetch for reliable proxy support.
 * Endpoint: POST https://api.perplexity.ai/chat/completions (model: sonar)
 * Docs: https://docs.perplexity.ai/api-reference/chat-completions-post
 *
 * Standard `pplx-*` keys grant access to chat/completions; the separate
 * `/search` product requires a different subscription, which is why this
 * adapter targets the universally-accessible Sonar chat endpoint.
 */

import { createLogger } from '@/lib/logger';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const log = createLogger('PerplexitySearch');

const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai';
const PERPLEXITY_MAX_QUERY_LENGTH = 400;
const PERPLEXITY_MODEL = 'sonar';

interface PerplexityChatResponse {
  id?: string;
  choices?: Array<{ message?: { role?: string; content?: string } }>;
  citations?: string[];
  search_results?: Array<{ title?: string; url: string; date?: string | null }>;
}

interface PerplexityValidationDetail {
  loc?: unknown[];
  msg?: string;
  type?: string;
}

interface PerplexityErrorResponse {
  detail?: PerplexityValidationDetail[] | string;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Search the web using Perplexity's Sonar chat/completions endpoint and
 * return structured results in the shared WebSearchResult shape.
 *
 * `maxResults` is accepted for dispatcher compatibility but ignored —
 * chat/completions does not expose a result-count knob; Perplexity controls
 * citation count server-side.
 */
export async function searchWithPerplexity(params: {
  query: string;
  apiKey: string;
  baseUrl?: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, apiKey, baseUrl } = params;

  const truncatedQuery = query.slice(0, PERPLEXITY_MAX_QUERY_LENGTH);
  const endpoint = `${baseUrl || PERPLEXITY_DEFAULT_BASE_URL}/chat/completions`;
  const start = Date.now();

  const res = await proxyFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [{ role: 'user', content: truncatedQuery }],
    }),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    log.error('Perplexity chat/completions failed', {
      status: res.status,
      bodyPreview: raw.slice(0, 500),
    });
    let message = raw || res.statusText;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PerplexityErrorResponse;
        if (Array.isArray(parsed.detail) && parsed.detail[0]?.msg) {
          message = parsed.detail[0].msg;
        } else if (typeof parsed.detail === 'string') {
          message = parsed.detail;
        }
      } catch {
        // fall back to raw text
      }
    }
    throw new Error(`Perplexity API error (${res.status}): ${message}`);
  }

  const data = (await res.json()) as PerplexityChatResponse;

  const answer = data.choices?.[0]?.message?.content ?? '';

  let sources: WebSearchSource[] = [];
  if (Array.isArray(data.search_results) && data.search_results.length > 0) {
    const total = data.search_results.length;
    sources = data.search_results.map((r, index) => ({
      title: r.title || safeHostname(r.url),
      url: r.url,
      content: '',
      score: (total - index) / total,
    }));
  } else if (Array.isArray(data.citations) && data.citations.length > 0) {
    const total = data.citations.length;
    sources = data.citations.map((url, index) => ({
      title: safeHostname(url),
      url,
      content: '',
      score: (total - index) / total,
    }));
  }

  return {
    answer,
    sources,
    query: truncatedQuery,
    responseTime: (Date.now() - start) / 1000,
  };
}
