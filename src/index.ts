import { Hono } from 'hono'

type Bindings = {
  MESSAGES: KVNamespace
}

type MessageRecord = {
  title: string
  body: string
  passcode: string
  createdAt: number
  expiresAt: number
}

type MessageMetadata = {
  title: string
  createdAt: number
  expiresAt: number
}

const KEY_PREFIX = 'msg:'
const TTL_SECONDS = 86400
const TITLE_MAX = 80
const BODY_MAX = 5000
const PASSCODE_MAX = 80

const app = new Hono<{ Bindings: Bindings }>()

/** ユーザー入力を HTML に埋め込む前に必ずこれでエスケープする。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 共通レイアウト。title は内部でエスケープするので生の文字列を渡す。body は組み立て済み HTML。 */
function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #222; background: #fafafa; }
  h1 { font-size: 1.4rem; }
  a { color: #0b5cad; }
  ul { padding-left: 1.2rem; }
  li { margin: 0.3rem 0; }
  form { display: flex; flex-direction: column; gap: 0.9rem; }
  label { display: flex; flex-direction: column; gap: 0.3rem; font-weight: bold; }
  input, textarea { font: inherit; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; background: #fff; }
  textarea { min-height: 9rem; resize: vertical; }
  button { font: inherit; padding: 0.5rem 1.1rem; background: #0b5cad; color: #fff; border: none; border-radius: 4px; cursor: pointer; align-self: flex-start; }
  .message-body { white-space: pre-wrap; word-break: break-word; background: #fff; padding: 1rem; border: 1px solid #e0e0e0; border-radius: 6px; }
  .nav { margin: 1.4rem 0; }
  .muted { color: #666; }
  .errors { color: #b00020; background: #fdecee; border: 1px solid #f5c2c7; border-radius: 6px; padding: 0.6rem 0.6rem 0.6rem 1.6rem; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

function isMessageRecord(value: unknown): value is MessageRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.title === 'string' &&
    typeof r.body === 'string' &&
    typeof r.passcode === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.expiresAt === 'number'
  )
}

/** KV から投稿を取得する。未存在・JSON不正・期限切れはすべて null を返す。 */
async function readRecord(env: Bindings, id: string): Promise<MessageRecord | null> {
  const raw = await env.MESSAGES.get(KEY_PREFIX + id)
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isMessageRecord(parsed)) return null
  if (parsed.expiresAt <= Date.now()) return null
  return parsed
}

function notFoundPage(): string {
  const body = `
<h1>404 - 見つかりません</h1>
<p class="muted">投稿が存在しないか、すでに期限切れです。</p>
<p class="nav"><a href="/">一覧へ戻る</a></p>`
  return page('見つかりません', body)
}

function forbiddenPage(id: string): string {
  const safeId = encodeURIComponent(id)
  const body = `
<h1>403 - あいことばが違います</h1>
<p class="muted">あいことばが一致しませんでした。</p>
<p class="nav"><a href="/messages/${safeId}">もう一度入力する</a> ・ <a href="/">一覧へ戻る</a></p>`
  return page('あいことばが違います', body)
}

/** 新規投稿フォーム。エラー時は入力値（あいことばを除く）を保持して再表示する。 */
function newFormPage(values: { title: string; body: string }, errors: string[]): string {
  const errorHtml =
    errors.length > 0
      ? `<ul class="errors">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
      : ''
  const body = `
<h1>新規投稿</h1>
${errorHtml}
<form method="post" action="/messages">
  <label>タイトル（最大${TITLE_MAX}文字）
    <input type="text" name="title" maxlength="${TITLE_MAX}" value="${escapeHtml(values.title)}" required>
  </label>
  <label>本文（最大${BODY_MAX}文字）
    <textarea name="body" maxlength="${BODY_MAX}" required>${escapeHtml(values.body)}</textarea>
  </label>
  <label>あいことば（最大${PASSCODE_MAX}文字）
    <input type="password" name="passcode" maxlength="${PASSCODE_MAX}" required>
  </label>
  <button type="submit">投稿する</button>
</form>
<p class="nav"><a href="/">一覧へ戻る</a></p>`
  return page('新規投稿', body)
}

function formString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// 1. 投稿一覧（タイトルのみ・期限切れは除外）
app.get('/', async (c) => {
  const { keys } = await c.env.MESSAGES.list<MessageMetadata>({ prefix: KEY_PREFIX })
  const now = Date.now()

  const visible = keys
    .filter((k) => {
      const expiresAt = k.metadata?.expiresAt
      return typeof expiresAt !== 'number' || expiresAt > now
    })
    .sort((a, b) => (b.metadata?.createdAt ?? 0) - (a.metadata?.createdAt ?? 0))

  const listHtml =
    visible.length > 0
      ? `<ul>${visible
          .map((k) => {
            const id = k.name.slice(KEY_PREFIX.length)
            const title = k.metadata?.title ?? '(無題)'
            return `<li><a href="/messages/${encodeURIComponent(id)}">${escapeHtml(title)}</a></li>`
          })
          .join('')}</ul>`
      : '<p class="muted">まだ投稿がありません。</p>'

  const body = `
<h1>伝言板</h1>
<p class="nav"><a href="/new">新しい伝言を書く</a></p>
${listHtml}`
  return c.html(page('伝言板', body))
})

// 2. 新規投稿フォーム
app.get('/new', (c) => {
  return c.html(newFormPage({ title: '', body: '' }, []))
})

// 3. 投稿の保存
app.post('/messages', async (c) => {
  const form = await c.req.formData()
  const title = formString(form.get('title')).trim()
  const body = formString(form.get('body'))
  const passcode = formString(form.get('passcode'))

  const errors: string[] = []
  if (title.length === 0) errors.push('タイトルを入力してください。')
  else if (title.length > TITLE_MAX) errors.push(`タイトルは${TITLE_MAX}文字以内で入力してください。`)

  if (body.trim().length === 0) errors.push('本文を入力してください。')
  else if (body.length > BODY_MAX) errors.push(`本文は${BODY_MAX}文字以内で入力してください。`)

  if (passcode.length === 0) errors.push('あいことばを入力してください。')
  else if (passcode.length > PASSCODE_MAX) errors.push(`あいことばは${PASSCODE_MAX}文字以内で入力してください。`)

  if (errors.length > 0) {
    return c.html(newFormPage({ title, body }, errors), 400)
  }

  const id = crypto.randomUUID()
  const createdAt = Date.now()
  const expiresAt = createdAt + TTL_SECONDS * 1000

  const record: MessageRecord = { title, body, passcode, createdAt, expiresAt }
  const metadata: MessageMetadata = { title, createdAt, expiresAt }

  await c.env.MESSAGES.put(KEY_PREFIX + id, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
    metadata,
  })

  return c.redirect(`/messages/${id}`, 303)
})

// 4. 投稿詳細（タイトル + あいことば入力フォームのみ。本文は出さない）
app.get('/messages/:id', async (c) => {
  const id = c.req.param('id')
  const record = await readRecord(c.env, id)
  if (record === null) return c.html(notFoundPage(), 404)

  const safeId = encodeURIComponent(id)
  const body = `
<h1>${escapeHtml(record.title)}</h1>
<p class="muted">本文を読むにはあいことばを入力してください。</p>
<form method="post" action="/messages/${safeId}/open">
  <label>あいことば
    <input type="password" name="passcode" maxlength="${PASSCODE_MAX}" required>
  </label>
  <button type="submit">本文を表示する</button>
</form>
<p class="nav"><a href="/">一覧へ戻る</a></p>`
  return c.html(page(record.title, body))
})

// 5. あいことば照合と本文表示
app.post('/messages/:id/open', async (c) => {
  const id = c.req.param('id')
  const record = await readRecord(c.env, id)
  if (record === null) return c.html(notFoundPage(), 404)

  const form = await c.req.formData()
  const passcode = formString(form.get('passcode'))

  if (passcode !== record.passcode) {
    return c.html(forbiddenPage(id), 403)
  }

  const safeId = encodeURIComponent(id)
  const body = `
<h1>${escapeHtml(record.title)}</h1>
<div class="message-body">${escapeHtml(record.body)}</div>
<p class="nav"><a href="/messages/${safeId}">戻る</a> ・ <a href="/">一覧へ</a></p>`
  return c.html(page(record.title, body))
})

app.notFound((c) => c.html(notFoundPage(), 404))

export default app
