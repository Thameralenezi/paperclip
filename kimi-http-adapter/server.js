import express from 'express'
import OpenAI from 'openai'

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? 'http://localhost:3100'
const PAPERCLIP_AGENT_API_KEY = process.env.PAPERCLIP_AGENT_API_KEY ?? ''
const PORT = parseInt(process.env.PORT ?? '4000', 10)

const kimi = new OpenAI({
  apiKey: process.env.MOONSHOT_API_KEY,
  baseURL: 'https://api.moonshot.cn/v1',
})

const app = express()
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post('/invoke', async (req, res) => {
  const { agentId, runId, context } = req.body ?? {}

  if (!runId || !agentId) {
    res.status(400).json({ error: 'Missing runId or agentId' })
    return
  }

  // Extract task text: prefer structured markdown, then wake comment, then issue description
  const task =
    context?.paperclipTaskMarkdown ??
    context?.paperclipWakeComment?.body ??
    context?.paperclipIssue?.description ??
    '(no task provided)'

  const issueId = context?.paperclipIssue?.id ?? null

  let kimiResult = ''
  let usage = { prompt_tokens: 0, completion_tokens: 0 }

  try {
    const response = await kimi.chat.completions.create({
      model: 'kimi-k2',
      messages: [
        { role: 'system', content: 'You are a senior software engineer. Respond with clear, actionable output.' },
        { role: 'user', content: task },
      ],
    })
    kimiResult = response.choices[0]?.message?.content ?? ''
    usage = response.usage ?? usage
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[kimi-adapter] Kimi API error for run ${runId}:`, msg)
    // Post the error back as a comment so it's visible in Paperclip
    if (issueId) {
      await postComment(issueId, `**Kimi error (run ${runId}):**\n\`\`\`\n${msg}\n\`\`\``)
    }
    // Still return 200 — Paperclip already dispatched the run; error is surfaced via comment
    res.json({ status: 'error', runId })
    return
  }

  // Post result as an issue comment so it appears in the Paperclip board
  if (issueId) {
    const costUsd =
      usage.prompt_tokens * 0.0000006 +
      usage.completion_tokens * 0.0000025

    const body =
      `${kimiResult}\n\n` +
      `---\n` +
      `*model: kimi-k2 · in: ${usage.prompt_tokens} · out: ${usage.completion_tokens} · cost: $${costUsd.toFixed(4)}*`

    await postComment(issueId, body)
  }

  console.log(`[kimi-adapter] run ${runId} completed — in:${usage.prompt_tokens} out:${usage.completion_tokens}`)
  res.json({ status: 'ok', runId })
})

async function postComment(issueId, body) {
  if (!PAPERCLIP_AGENT_API_KEY) return

  try {
    const r = await fetch(`${PAPERCLIP_URL}/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAPERCLIP_AGENT_API_KEY}`,
      },
      body: JSON.stringify({ body }),
    })
    if (!r.ok) {
      console.warn(`[kimi-adapter] comment post failed: ${r.status}`)
    }
  } catch (err) {
    console.warn('[kimi-adapter] comment post error:', err instanceof Error ? err.message : err)
  }
}

app.listen(PORT, () => {
  console.log(`[kimi-adapter] listening on :${PORT}`)
})
