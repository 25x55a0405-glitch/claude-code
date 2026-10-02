// A tiny MCP server for the tests: one read-only tool, one that changes things, one that fails.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const notes = [];
const server = new McpServer({ name: 'notes', version: '1.0.0' });
server.registerTool('lookup', {
  description: 'Look up notes containing a word',
  inputSchema: { word: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ word }) => ({
  content: [{ type: 'text', text: `token ${process.env.NOTES_TOKEN === 'tok-123456' ? 'ok' : 'missing'}; ${notes.filter((n) => n.includes(word)).length} note(s) with ${word}` }],
}));
server.registerTool('add_note', {
  description: 'Save a note',
  inputSchema: { text: z.string() },
}, async ({ text }) => {
  notes.push(text);
  return { content: [{ type: 'text', text: `Saved note ${notes.length}` }] };
});
server.registerTool('boom', { description: 'Always fails', inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'It broke' }] }));
await server.connect(new StdioServerTransport());
