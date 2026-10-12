// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockSupabase, insertedRuns, updatedAutomations, resetMockDb } = vi.hoisted(() => {
  const runs = []
  const updates = []

  const client = {
    from: (table) => {
      if (table === 'automations') {
        return {
          select: () => ({
            eq: () => ({
              lte: () => ({
                limit: async () => ({
                  data: [
                    {
                      id: 'auto-123',
                      name: 'Test Automation',
                      agent_name: 'Test Agent',
                      provider: 'gemini',
                      model: 'gemini-2.5-flash',
                      system_prompt: 'You are a test helper.',
                      inputs: { query: 'test input' },
                      schedule: 'daily',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
          update: (updateData) => ({
            eq: async (col, val) => {
              updates.push({ updateData, col, val })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'user_secrets') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  encrypted_key: Buffer.from('test-gemini-secret-key').toString('base64'),
                },
              }),
            }),
          }),
        }
      }
      if (table === 'automation_runs') {
        return {
          insert: async (record) => {
            runs.push(record)
            return { error: null }
          },
        }
      }
      return {}
    },
  }

  return {
    mockSupabase: client,
    insertedRuns: runs,
    updatedAutomations: updates,
    resetMockDb: () => {
      runs.length = 0
      updates.length = 0
    },
  }
})

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockSupabase,
}))

import handler, {
  buildCronRequest,
  parseCronResponse,
  SUPPORTED_CRON_PROVIDERS,
} from '../../api/cron/tick.js'

describe('SUPPORTED_CRON_PROVIDERS', () => {
  it('includes openai, anthropic, gemini, and openrouter', () => {
    expect(SUPPORTED_CRON_PROVIDERS).toEqual(
      expect.arrayContaining(['openai', 'anthropic', 'gemini', 'openrouter'])
    )
    expect(SUPPORTED_CRON_PROVIDERS).toHaveLength(4)
  })
})

describe('buildCronRequest', () => {
  const apiKey = 'test-secret-key-123'
  const systemPrompt = 'You are a helpful coding assistant.'
  const userMessage = 'Write a fibonacci function in JS.'

  it('builds openai request by default when provider is omitted', () => {
    const req = buildCronRequest(undefined, apiKey, undefined, systemPrompt, userMessage)
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    })
    expect(req.body.model).toBe('gpt-4o-mini')
    expect(req.body.max_tokens).toBe(4096)
    expect(req.body.messages).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ])
  })

  it('builds openai request with custom model', () => {
    const req = buildCronRequest('openai', apiKey, 'gpt-4o', systemPrompt, userMessage)
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers.Authorization).toBe(`Bearer ${apiKey}`)
    expect(req.body.model).toBe('gpt-4o')
    expect(req.body.messages[0].content).toBe(systemPrompt)
    expect(req.body.messages[1].content).toBe(userMessage)
  })

  it('builds anthropic request with required headers and payload shape', () => {
    const req = buildCronRequest('anthropic', apiKey, undefined, systemPrompt, userMessage)
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    })
    expect(req.body.model).toBe('claude-3-5-sonnet-20241022')
    expect(req.body.max_tokens).toBe(4096)
    expect(req.body.system).toBe(systemPrompt)
    expect(req.body.messages).toEqual([
      { role: 'user', content: userMessage },
    ])
  })

  it('builds anthropic request with custom model', () => {
    const req = buildCronRequest('anthropic', apiKey, 'claude-3-5-haiku-20241022', systemPrompt, userMessage)
    expect(req.body.model).toBe('claude-3-5-haiku-20241022')
  })

  it('builds gemini request with key in header and content parts', () => {
    const req = buildCronRequest('gemini', apiKey, undefined, systemPrompt, userMessage)
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    )
    expect(req.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    })
    expect(req.body).toEqual({
      contents: [
        {
          parts: [{ text: `${systemPrompt}\n\n${userMessage}` }],
        },
      ],
    })
  })

  it('builds gemini request with custom model and encoded path segment', () => {
    const req = buildCronRequest('gemini', apiKey, 'models/gemini-1.5-pro', systemPrompt, userMessage)
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/models%2Fgemini-1.5-pro:generateContent'
    )
    expect(req.headers['x-goog-api-key']).toBe(apiKey)
  })

  it('builds openrouter request with referer headers and openrouter default model', () => {
    const req = buildCronRequest('openrouter', apiKey, undefined, systemPrompt, userMessage)
    expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(req.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://iloveagents.ai',
      'X-Title': 'ILoveAgents',
    })
    expect(req.body.model).toBe('openai/gpt-4o-mini')
    expect(req.body.max_tokens).toBe(4096)
    expect(req.body.messages).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ])
  })

  it('builds openrouter request with custom model', () => {
    const req = buildCronRequest('openrouter', apiKey, 'anthropic/claude-3.5-sonnet', systemPrompt, userMessage)
    expect(req.body.model).toBe('anthropic/claude-3.5-sonnet')
  })

  it('handles case-insensitivity in provider names', () => {
    const reqAnthropic = buildCronRequest('Anthropic', apiKey, null, systemPrompt, userMessage)
    expect(reqAnthropic.url).toBe('https://api.anthropic.com/v1/messages')

    const reqGemini = buildCronRequest('GEMINI', apiKey, null, systemPrompt, userMessage)
    expect(reqGemini.url).toContain('generativelanguage.googleapis.com')

    const reqOpenRouter = buildCronRequest('OpenRouter', apiKey, null, systemPrompt, userMessage)
    expect(reqOpenRouter.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  it('applies default fallbacks for missing prompts and messages', () => {
    const req = buildCronRequest('openai', apiKey, null, null, null)
    expect(req.body.messages[0].content).toBe('You are an AI assistant.')
    expect(req.body.messages[1].content).toBe('Scheduled run')
  })
})

describe('parseCronResponse', () => {
  it('parses openai chat completions response', () => {
    const json = {
      choices: [{ message: { content: 'Here is the summary output.' } }],
    }
    expect(parseCronResponse('openai', json)).toBe('Here is the summary output.')
  })

  it('parses openrouter chat completions response', () => {
    const json = {
      choices: [{ message: { content: 'OpenRouter generated output.' } }],
    }
    expect(parseCronResponse('openrouter', json)).toBe('OpenRouter generated output.')
  })

  it('parses anthropic messages content blocks', () => {
    const json = {
      content: [{ type: 'text', text: 'Anthropic generated text.' }],
    }
    expect(parseCronResponse('anthropic', json)).toBe('Anthropic generated text.')
  })

  it('parses gemini candidates content parts', () => {
    const json = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Gemini generated insight.' }],
          },
        },
      ],
    }
    expect(parseCronResponse('gemini', json)).toBe('Gemini generated insight.')
  })

  it('handles case-insensitivity in provider names when parsing', () => {
    const antJson = { content: [{ text: 'Case test' }] }
    expect(parseCronResponse('ANTHROPIC', antJson)).toBe('Case test')

    const gemJson = { candidates: [{ content: { parts: [{ text: 'Gem test' }] } }] }
    expect(parseCronResponse('Gemini', gemJson)).toBe('Gem test')
  })

  it('returns fallback string when response payload is empty or malformed', () => {
    expect(parseCronResponse('openai', {})).toBe('No output generated')
    expect(parseCronResponse('anthropic', {})).toBe('No output generated')
    expect(parseCronResponse('gemini', {})).toBe('No output generated')
    expect(parseCronResponse('openrouter', {})).toBe('No output generated')
    expect(parseCronResponse('openai', null)).toBe('No output generated')
    expect(parseCronResponse('openai', undefined)).toBe('No output generated')
    expect(parseCronResponse('openai', { choices: [] })).toBe('No output generated')
  })
})

describe('handler authorization and serverless simulation', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.VITE_SUPABASE_URL
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.VITE_SUPABASE_ANON_KEY
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('rejects unauthorized requests when CRON_SECRET is configured', async () => {
    process.env.CRON_SECRET = 'super-secret'

    const req = {
      headers: { authorization: 'Bearer wrong-secret' },
    }
    let statusCode = null
    let responseBody = null
    const res = {
      status(code) {
        statusCode = code
        return {
          json(data) {
            responseBody = data
          },
        }
      },
    }

    await handler(req, res)

    expect(statusCode).toBe(401)
    expect(responseBody).toEqual({ error: 'Unauthorized: Invalid Cron Secret' })
  })

  it('returns serverless simulation response when Supabase is not configured', async () => {
    delete process.env.CRON_SECRET

    const req = { headers: {} }
    let statusCode = null
    let responseBody = null
    const res = {
      status(code) {
        statusCode = code
        return {
          json(data) {
            responseBody = data
          },
        }
      },
    }

    await handler(req, res)

    expect(statusCode).toBe(200)
    expect(responseBody.message).toContain('Serverless simulated mode')
    expect(responseBody.processedCount).toBe(0)
  })
})

describe('handler execution with configured Supabase', () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key'
    delete process.env.CRON_SECRET
    delete process.env.RESEND_API_KEY

    resetMockDb()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    global.fetch = originalFetch
    resetMockDb()
  })

  it('executes due gemini automation and inserts successful run with parsed output', async () => {
    let capturedUrl = null
    let capturedOptions = null

    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedUrl = url
      capturedOptions = options
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'Live generated output from Gemini' }],
              },
            },
          ],
        }),
      }
    })

    const req = { headers: {} }
    let resData = null
    const res = {
      status: vi.fn().mockReturnValue({
        json: vi.fn((d) => {
          resData = d
        }),
      }),
    }

    await handler(req, res)

    expect(capturedUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    )
    expect(capturedOptions.headers['x-goog-api-key']).toBe('test-gemini-secret-key')
    expect(insertedRuns).toHaveLength(1)
    expect(insertedRuns[0].status).toBe('success')
    expect(insertedRuns[0].output).toBe('Live generated output from Gemini')
    expect(insertedRuns[0].error).toBeNull()
    expect(resData.processedCount).toBe(1)
  })

  it('marks run as failed when provider returns non-2xx status code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'API key expired or invalid' } }),
    })

    const req = { headers: {} }
    let resData = null
    const res = {
      status: vi.fn().mockReturnValue({
        json: vi.fn((d) => {
          resData = d
        }),
      }),
    }

    await handler(req, res)

    expect(insertedRuns).toHaveLength(1)
    expect(insertedRuns[0].status).toBe('failed')
    expect(insertedRuns[0].error).toContain('gemini API error 401: API key expired or invalid')
    expect(resData.results[0].status).toBe('failed')
  })

  it('handles non-JSON error response from provider gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    const req = { headers: {} }
    let resData = null
    const res = {
      status: vi.fn().mockReturnValue({
        json: vi.fn((d) => {
          resData = d
        }),
      }),
    }

    await handler(req, res)

    expect(insertedRuns).toHaveLength(1)
    expect(insertedRuns[0].status).toBe('failed')
    expect(insertedRuns[0].error).toContain('gemini API error 500: Internal Server Error')
    expect(resData.results[0].status).toBe('failed')
  })
})

