import { beforeEach, describe, expect, it, vi } from 'vitest';

const { proxyFetchMock } = vi.hoisted(() => ({
  proxyFetchMock: vi.fn(),
}));

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

describe('searchWithPerplexity', () => {
  beforeEach(() => {
    vi.resetModules();
    proxyFetchMock.mockReset();
  });

  it('maps search_results into WebSearchResult with descending pseudo-score and an answer', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'synthesized answer' } }],
        search_results: [
          { title: 'T1', url: 'https://a.example.com/x' },
          { title: 'T2', url: 'https://b.example.com/y' },
          { title: 'T3', url: 'https://c.example.com/z' },
        ],
      }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    const result = await searchWithPerplexity({
      query: 'test query',
      apiKey: 'pplx-test',
    });

    expect(result.answer).toBe('synthesized answer');
    expect(result.query).toBe('test query');
    expect(typeof result.responseTime).toBe('number');
    expect(result.sources).toHaveLength(3);
    expect(result.sources[0]).toEqual({
      title: 'T1',
      url: 'https://a.example.com/x',
      content: '',
      score: 1,
    });
    expect(result.sources[1].score).toBeCloseTo(2 / 3);
    expect(result.sources[2].score).toBeCloseTo(1 / 3);

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.perplexity.ai/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer pplx-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('derives title from hostname when search_results title is missing', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: 'a' } }],
        search_results: [{ url: 'https://bare.example.com/path' }],
      }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    const result = await searchWithPerplexity({ query: 'q', apiKey: 'k' });
    expect(result.sources[0].title).toBe('bare.example.com');
  });

  it('falls back to citations when search_results is absent', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: 'synthesized' } }],
        citations: ['https://example.com/x', 'https://other.com/y'],
      }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    const result = await searchWithPerplexity({ query: 'q', apiKey: 'k' });
    expect(result.answer).toBe('synthesized');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toEqual({
      title: 'example.com',
      url: 'https://example.com/x',
      content: '',
      score: 1,
    });
    expect(result.sources[1].title).toBe('other.com');
    expect(result.sources[1].score).toBeCloseTo(1 / 2);
  });

  it('returns empty sources when neither search_results nor citations are present', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: 'just an answer' } }],
      }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    const result = await searchWithPerplexity({ query: 'q', apiKey: 'k' });
    expect(result.sources).toEqual([]);
    expect(result.answer).toBe('just an answer');
  });

  it('sends model=sonar and the truncated query without max_results', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    await searchWithPerplexity({ query: 'hello world', apiKey: 'k' });
    const [, init] = proxyFetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe('sonar');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello world' }]);
    expect(body).not.toHaveProperty('max_results');
    expect(body).not.toHaveProperty('query');
  });

  it('respects a custom baseUrl override', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    await searchWithPerplexity({
      query: 'q',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.com',
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://proxy.example.com/chat/completions',
      expect.any(Object),
    );
  });

  it('truncates very long queries', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    const longQuery = 'x'.repeat(600);
    const result = await searchWithPerplexity({ query: longQuery, apiKey: 'k' });
    expect(result.query.length).toBe(400);

    const [, init] = proxyFetchMock.mock.calls[0];
    expect(JSON.parse(init.body).messages[0].content.length).toBe(400);
  });

  it('surfaces detail[0].msg from a 422 validation error', async () => {
    const errorBody = {
      detail: [{ msg: 'field required', type: 'value_error.missing', loc: ['body', 'query'] }],
    };
    proxyFetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => JSON.stringify(errorBody),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    await expect(searchWithPerplexity({ query: 'q', apiKey: 'k' })).rejects.toThrow(
      /Perplexity API error \(422\): field required/,
    );
  });

  it('surfaces a string detail field unchanged', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ detail: 'Invalid API key' }),
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    await expect(searchWithPerplexity({ query: 'q', apiKey: 'bad' })).rejects.toThrow(
      /Perplexity API error \(401\): Invalid API key/,
    );
  });

  it('falls back to raw body text when the error is not JSON', async () => {
    proxyFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Upstream failure',
    });

    const { searchWithPerplexity } = await import('@/lib/web-search/perplexity');

    await expect(searchWithPerplexity({ query: 'q', apiKey: 'k' })).rejects.toThrow(
      /Perplexity API error \(500\): Upstream failure/,
    );
  });
});
