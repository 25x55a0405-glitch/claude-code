import { ConnectionError } from '../../connections/providers.ts';
import { truncate } from '../../util.ts';
import { schema, str, num, type ToolDef } from './types.ts';

// Tools for connected apps. Each one names its connection, so it is only
// offered while that app is connected, and the policy engine knows which
// access setting applies.

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const GH = 'https://api.github.com';
const NOTION = 'https://api.notion.com/v1';
const GH_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const NOTION_HEADERS = { 'Notion-Version': '2022-06-28' };
const MAX = 12_000;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);

function rfc822(to: string, subject: string, body: string, cc?: string, inReplyTo?: string) {
  const lines = [`To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${header(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body];
  return b64url(lines.join('\r\n'));
}

interface EmailInput { to: string; subject: string; body: string; cc?: string; thread_id?: string }

const emailPreview = (i: EmailInput) => `Subject: ${i.subject}\n\n${i.body}`;
const emailEdit = (i: EmailInput, edited: string): EmailInput => {
  const m = /^Subject:\s*(.*)\n\n?([\s\S]*)$/.exec(edited);
  return m ? { ...i, subject: m[1].trim(), body: m[2] } : { ...i, body: edited };
};
const emailSchema = schema({
  to: str('Recipient email addresses, comma-separated'),
  subject: str('Subject line'),
  body: str('Plain-text body, written in the person’s style'),
  cc: str('Optional cc addresses'),
  thread_id: str('Gmail thread id when replying'),
}, ['to', 'subject', 'body']);

function decodeBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const part of payload.parts ?? []) {
    const text = decodeBody(part);
    if (text) return text;
  }
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ');
  return '';
}

const headerOf = (msg: any, name: string) => msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export const searchEmail: ToolDef<{ query: string; max?: number }> = {
  name: 'search_email',
  description: 'Search Gmail with Gmail search syntax (e.g. "is:unread newer_than:1d", "from:maya"). Returns id, thread, sender, subject, date and snippet.',
  input_schema: schema({ query: str('Gmail search query'), max: num('Max results, default 15') }, ['query']),
  effect: 'read',
  connection: 'gmail',
  label: (i) => `Searched email: ${i.query}`,
  async run(i, ctx) {
    const list = await ctx.providers.api('gmail', `${GMAIL}/messages?q=${encodeURIComponent(i.query)}&maxResults=${Math.min(i.max ?? 15, 50)}`);
    const ids: { id: string }[] = list.messages ?? [];
    if (!ids.length) return { content: 'No messages.', summary: `No email matched “${i.query}”` };
    const msgs = await Promise.all(ids.map((m) => ctx.providers.api('gmail', `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    const lines = msgs.map((m) => `- id:${m.id} thread:${m.threadId} from:${headerOf(m, 'From')} | ${headerOf(m, 'Subject')} | ${headerOf(m, 'Date')}\n  ${m.snippet}`);
    return { content: truncate(lines.join('\n'), MAX), summary: `Found ${msgs.length} email${msgs.length === 1 ? '' : 's'} for “${i.query}”` };
  },
};

export const readEmail: ToolDef<{ id: string }> = {
  name: 'read_email',
  description: 'Read one email in full by id.',
  input_schema: schema({ id: str('Message id from search_email') }, ['id']),
  effect: 'read',
  connection: 'gmail',
  label: () => 'Read an email',
  async run(i, ctx) {
    const m = await ctx.providers.api('gmail', `${GMAIL}/messages/${encodeURIComponent(i.id)}?format=full`);
    const text = `From: ${headerOf(m, 'From')}\nTo: ${headerOf(m, 'To')}\nSubject: ${headerOf(m, 'Subject')}\nDate: ${headerOf(m, 'Date')}\nMessage-ID: ${headerOf(m, 'Message-ID')}\nThread: ${m.threadId}\n\n${decodeBody(m.payload)}`;
    return { content: truncate(text, MAX), summary: `Read “${headerOf(m, 'Subject')}” from ${headerOf(m, 'From')}` };
  },
};

export const draftEmail: ToolDef<EmailInput> = {
  name: 'draft_email',
  description: 'Save an email as a Gmail draft without sending it.',
  input_schema: emailSchema,
  effect: 'write',
  connection: 'gmail',
  label: (i) => `Drafted email to ${i.to}`,
  approval: (i) => ({ action: 'Save draft', target: i.to, preview: emailPreview(i), risk: 'low' }),
  applyEdit: emailEdit,
  async run(i, ctx) {
    await ctx.providers.api('gmail', `${GMAIL}/drafts`, { method: 'POST', body: { message: { raw: rfc822(i.to, i.subject, i.body, i.cc), threadId: i.thread_id } } });
    return { content: 'Draft saved.', summary: `Drafted “${i.subject}” to ${i.to}` };
  },
};

export const sendEmail: ToolDef<EmailInput> = {
  name: 'send_email',
  description: 'Send an email from the person’s Gmail. This reaches other people, so it usually needs their OK first; the call waits for it.',
  input_schema: emailSchema,
  effect: 'send',
  connection: 'gmail',
  label: (i) => `Send email to ${i.to}`,
  approval: (i) => ({ action: 'Send email', target: i.to, preview: emailPreview(i), risk: 'medium' }),
  applyEdit: emailEdit,
  async run(i, ctx) {
    await ctx.providers.api('gmail', `${GMAIL}/messages/send`, { method: 'POST', body: { raw: rfc822(i.to, i.subject, i.body, i.cc), threadId: i.thread_id } });
    return { content: 'Sent.', summary: `Sent “${i.subject}” to ${i.to}` };
  },
};

export const archiveEmail: ToolDef<{ ids: string[] }> = {
  name: 'archive_email',
  description: 'Archive emails (remove from inbox; they stay searchable).',
  input_schema: schema({ ids: { type: 'array', items: { type: 'string' }, description: 'Message ids' } }, ['ids']),
  effect: 'write',
  connection: 'gmail',
  label: (i) => `Archived ${i.ids.length} email${i.ids.length === 1 ? '' : 's'}`,
  approval: (i) => ({ action: 'Archive email', target: `${i.ids.length} messages`, preview: i.ids.join('\n'), risk: 'low' }),
  async run(i, ctx) {
    await ctx.providers.api('gmail', `${GMAIL}/messages/batchModify`, { method: 'POST', body: { ids: i.ids, removeLabelIds: ['INBOX'] } });
    return 'Archived.';
  },
};

export const listEvents: ToolDef<{ days_ahead?: number; query?: string }> = {
  name: 'list_events',
  description: 'List calendar events from now through the next N days (default 7).',
  input_schema: schema({ days_ahead: num('Days to look ahead'), query: str('Optional text filter') }),
  effect: 'read',
  connection: 'calendar',
  label: () => 'Checked your calendar',
  async run(i, ctx) {
    const now = new Date();
    const until = new Date(now.getTime() + (i.days_ahead ?? 7) * 86_400_000);
    const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: until.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
    if (i.query) q.set('q', i.query);
    const res = await ctx.providers.api('calendar', `${CAL}/events?${q}`);
    const items: any[] = res.items ?? [];
    const lines = items.map((e) => `- ${e.start?.dateTime ?? e.start?.date} to ${e.end?.dateTime ?? e.end?.date}: ${e.summary ?? '(no title)'}${e.attendees ? ` with ${e.attendees.map((a: any) => a.email).join(', ')}` : ''}`);
    return { content: lines.join('\n') || 'No events.', summary: `Checked calendar: ${items.length} event${items.length === 1 ? '' : 's'} in the next ${i.days_ahead ?? 7} days` };
  },
};

interface EventInput { title: string; start: string; end: string; attendees?: string[]; description?: string }
export const createEvent: ToolDef<EventInput> = {
  name: 'create_event',
  description: 'Create a calendar event. With attendees, Google sends them invitations. Times are ISO 8601 with offset.',
  input_schema: schema({
    title: str('Event title'), start: str('Start, ISO 8601'), end: str('End, ISO 8601'),
    attendees: { type: 'array', items: { type: 'string' }, description: 'Guest emails' }, description: str('Optional notes'),
  }, ['title', 'start', 'end']),
  effect: 'send',
  effectFor: (i) => (i.attendees?.length ? 'send' : 'write'),
  connection: 'calendar',
  label: (i) => `Create event “${i.title}”`,
  approval: (i) => ({
    action: i.attendees?.length ? 'Send invite' : 'Add event',
    target: i.attendees?.join(', ') || 'Your calendar',
    preview: `${i.title}\n${i.start} to ${i.end}${i.description ? `\n\n${i.description}` : ''}`,
  }),
  async run(i, ctx) {
    const e = await ctx.providers.api('calendar', `${CAL}/events?sendUpdates=${i.attendees?.length ? 'all' : 'none'}`, {
      method: 'POST',
      body: { summary: i.title, description: i.description, start: { dateTime: i.start }, end: { dateTime: i.end }, attendees: i.attendees?.map((email) => ({ email })) },
    });
    return { content: `Created: ${e.htmlLink ?? e.id}`, summary: `Added “${i.title}” to your calendar` };
  },
};

export const searchDrive: ToolDef<{ query: string }> = {
  name: 'search_drive',
  description: 'Find documents in Google Drive by text.',
  input_schema: schema({ query: str('Words to search for') }, ['query']),
  effect: 'read',
  connection: 'drive',
  label: (i) => `Searched Drive for “${i.query}”`,
  async run(i, ctx) {
    const q = `fullText contains '${i.query.replace(/['\\]/g, '\\$&')}' and trashed = false`;
    const res = await ctx.providers.api('drive', `${DRIVE}/files?q=${encodeURIComponent(q)}&pageSize=15&fields=files(id,name,mimeType,modifiedTime,webViewLink)`);
    const files: any[] = res.files ?? [];
    return files.map((f) => `- id:${f.id} ${f.name} (${f.mimeType}, modified ${f.modifiedTime}) ${f.webViewLink}`).join('\n') || 'No files.';
  },
};

export const readDrive: ToolDef<{ id: string }> = {
  name: 'read_drive_file',
  description: 'Read the text of a Drive file by id (Google Docs are exported as plain text).',
  input_schema: schema({ id: str('File id from search_drive') }, ['id']),
  effect: 'read',
  connection: 'drive',
  label: () => 'Read a document',
  async run(i, ctx) {
    const meta = await ctx.providers.api('drive', `${DRIVE}/files/${encodeURIComponent(i.id)}?fields=name,mimeType`);
    const url = String(meta.mimeType).startsWith('application/vnd.google-apps')
      ? `${DRIVE}/files/${encodeURIComponent(i.id)}/export?mimeType=text/plain`
      : `${DRIVE}/files/${encodeURIComponent(i.id)}?alt=media`;
    const text: string = await ctx.providers.api('drive', url, { raw: true });
    return { content: truncate(text, MAX), summary: `Read “${meta.name}”` };
  },
};

export const githubSearch: ToolDef<{ preset?: string; query?: string }> = {
  name: 'github_search',
  description: 'Search GitHub issues and pull requests. Use a preset (my_open_prs, review_requests, assigned_issues) or a GitHub search query.',
  input_schema: schema({
    preset: str('Shortcut query', { enum: ['my_open_prs', 'review_requests', 'assigned_issues'] }),
    query: str('GitHub search query, e.g. "repo:owner/name is:issue is:open label:bug"'),
  }),
  effect: 'read',
  connection: 'github',
  label: (i) => `Checked GitHub: ${i.preset ?? i.query}`,
  async run(i, ctx) {
    const presets: Record<string, string> = {
      my_open_prs: 'is:pr is:open author:@me', review_requests: 'is:pr is:open review-requested:@me', assigned_issues: 'is:issue is:open assignee:@me',
    };
    const q = i.query ?? presets[i.preset ?? 'my_open_prs'];
    const res = await ctx.providers.api('github', `${GH}/search/issues?q=${encodeURIComponent(q)}&per_page=20&sort=updated`, { headers: GH_HEADERS });
    const items: any[] = res.items ?? [];
    const lines = items.map((it) => `- ${it.repository_url.replace(`${GH}/repos/`, '')}#${it.number} ${it.title} [${it.state}] updated ${it.updated_at} by ${it.user?.login} ${it.html_url}`);
    return { content: lines.join('\n') || 'Nothing found.', summary: `GitHub: ${items.length} result${items.length === 1 ? '' : 's'} for ${i.preset ?? q}` };
  },
};

export const githubRead: ToolDef<{ repo: string; number: number }> = {
  name: 'github_read',
  description: 'Read an issue or pull request with its recent comments.',
  input_schema: schema({ repo: str('owner/name'), number: { type: 'integer', description: 'Issue or PR number' } }, ['repo', 'number']),
  effect: 'read',
  connection: 'github',
  label: (i) => `Read ${i.repo}#${i.number}`,
  async run(i, ctx) {
    const issue = await ctx.providers.api('github', `${GH}/repos/${i.repo}/issues/${i.number}`, { headers: GH_HEADERS });
    const comments: any[] = await ctx.providers.api('github', `${GH}/repos/${i.repo}/issues/${i.number}/comments?per_page=20`, { headers: GH_HEADERS });
    const text = `${issue.title} [${issue.state}] by ${issue.user?.login}\n${issue.body ?? ''}\n\n${comments.map((c) => `${c.user?.login} (${c.created_at}): ${c.body}`).join('\n\n')}`;
    return truncate(text, MAX);
  },
};

export const githubNotifications: ToolDef<Record<string, never>> = {
  name: 'github_notifications',
  description: 'List unread GitHub notifications.',
  input_schema: schema({}),
  effect: 'read',
  connection: 'github',
  label: () => 'Checked GitHub notifications',
  async run(_i, ctx) {
    const items: any[] = await ctx.providers.api('github', `${GH}/notifications?per_page=30`, { headers: GH_HEADERS });
    return items.map((n) => `- ${n.repository?.full_name}: ${n.subject?.title} (${n.subject?.type}, ${n.reason}) ${n.updated_at}`).join('\n') || 'No unread notifications.';
  },
};

export const githubComment: ToolDef<{ repo: string; number: number; body: string }> = {
  name: 'github_comment',
  description: 'Post a comment on an issue or pull request as the person.',
  input_schema: schema({ repo: str('owner/name'), number: { type: 'integer', description: 'Issue or PR number' }, body: str('Markdown comment') }, ['repo', 'number', 'body']),
  effect: 'send',
  connection: 'github',
  label: (i) => `Comment on ${i.repo}#${i.number}`,
  approval: (i) => ({ action: 'Post comment', target: `${i.repo}#${i.number}`, preview: i.body }),
  applyEdit: (i, edited) => ({ ...i, body: edited }),
  async run(i, ctx) {
    const c = await ctx.providers.api('github', `${GH}/repos/${i.repo}/issues/${i.number}/comments`, { method: 'POST', body: { body: i.body }, headers: GH_HEADERS });
    return { content: `Posted: ${c.html_url}`, summary: `Commented on ${i.repo}#${i.number}` };
  },
};

const notionText = (rich: any[] = []) => rich.map((r) => r.plain_text ?? '').join('');

export const notionSearch: ToolDef<{ query: string }> = {
  name: 'notion_search',
  description: 'Search Notion pages and databases the person shared with Sky.',
  input_schema: schema({ query: str('Words to search for') }, ['query']),
  effect: 'read',
  connection: 'notion',
  label: (i) => `Searched Notion for “${i.query}”`,
  async run(i, ctx) {
    const res = await ctx.providers.api('notion', `${NOTION}/search`, { method: 'POST', body: { query: i.query, page_size: 15 }, headers: NOTION_HEADERS });
    const results: any[] = res.results ?? [];
    return results.map((r) => {
      const title = r.properties ? Object.values(r.properties).map((p: any) => (p.type === 'title' ? notionText(p.title) : '')).join('') : notionText(r.title);
      return `- id:${r.id} ${r.object} “${title || 'Untitled'}” ${r.url}`;
    }).join('\n') || 'Nothing found.';
  },
};

export const notionRead: ToolDef<{ page_id: string }> = {
  name: 'notion_read',
  description: 'Read the text of a Notion page.',
  input_schema: schema({ page_id: str('Page id') }, ['page_id']),
  effect: 'read',
  connection: 'notion',
  label: () => 'Read a Notion page',
  async run(i, ctx) {
    const res = await ctx.providers.api('notion', `${NOTION}/blocks/${encodeURIComponent(i.page_id)}/children?page_size=100`, { headers: NOTION_HEADERS });
    const text = (res.results ?? []).map((b: any) => notionText(b[b.type]?.rich_text)).filter(Boolean).join('\n');
    return truncate(text || '(empty page)', MAX);
  },
};

export const notionAppend: ToolDef<{ page_id: string; text: string }> = {
  name: 'notion_append',
  description: 'Append paragraphs to a Notion page.',
  input_schema: schema({ page_id: str('Page id'), text: str('Text to add; blank lines separate paragraphs') }, ['page_id', 'text']),
  effect: 'write',
  connection: 'notion',
  label: () => 'Updated a Notion page',
  approval: (i) => ({ action: 'Update Notion page', target: i.page_id, preview: i.text, risk: 'low' }),
  applyEdit: (i, edited) => ({ ...i, text: edited }),
  async run(i, ctx) {
    const children = i.text.split(/\n{2,}/).map((p) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 2000) } }] } }));
    await ctx.providers.api('notion', `${NOTION}/blocks/${encodeURIComponent(i.page_id)}/children`, { method: 'PATCH', body: { children }, headers: NOTION_HEADERS });
    return 'Appended.';
  },
};

export const slackPost: ToolDef<{ channel: string; text: string }> = {
  name: 'slack_post',
  description: 'Post a message to a Slack channel as the person.',
  input_schema: schema({ channel: str('Channel id or name, e.g. #general'), text: str('Message') }, ['channel', 'text']),
  effect: 'send',
  connection: 'slack',
  label: (i) => `Post to ${i.channel}`,
  approval: (i) => ({ action: 'Post to Slack', target: i.channel, preview: i.text }),
  applyEdit: (i, edited) => ({ ...i, text: edited }),
  async run(i, ctx) {
    const res = await ctx.providers.api('slack', 'https://slack.com/api/chat.postMessage', { method: 'POST', body: { channel: i.channel, text: i.text } });
    if (!res.ok) throw new ConnectionError(`Slack: ${res.error}`);
    return { content: 'Posted.', summary: `Posted to ${i.channel}` };
  },
};

export const appTools: ToolDef[] = [
  searchEmail, readEmail, draftEmail, sendEmail, archiveEmail, listEvents, createEvent, searchDrive, readDrive,
  githubSearch, githubRead, githubNotifications, githubComment, notionSearch, notionRead, notionAppend, slackPost,
];
