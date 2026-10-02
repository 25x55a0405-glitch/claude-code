// Starts the real Sky server for the browser tests: fresh in-memory database,
// scripted brain, the built web app at /, and a fake Gmail so approvals can be
// exercised end to end. Prints the URL on stdout once it is listening.
import { resolve } from 'node:path';
import { fakeConnection, startServer } from '../../server/test/helpers.ts';

const s = await startServer({ webDist: resolve(import.meta.dirname, '../../web/dist'), tickMs: 1000, ...(process.env.QA_PASSWORD ? { password: process.env.QA_PASSWORD } : {}) });
const sent = fakeConnection(s, 'gmail', (url) => ({ body: url.endsWith('/profile') ? { emailAddress: 'd@example.com' } : { id: 'sent_1' } }));
// Lets the tests see what would have gone out, without a real mailbox.
s.app.server.prependListener('request', (req, res) => {
  if (req.url === '/__qa/gmail-sends') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(sent.filter((c) => c.url.endsWith('/send'))));
  }
});
s.app.runtime.start();
console.log(s.base.replace(/\/api\/v1$/, ''));
