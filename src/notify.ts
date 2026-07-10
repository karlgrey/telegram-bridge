import { createServer } from 'node:http';

/** Lokaler Push-Endpoint: POST /notify {"text":"…"} mit Bearer-Token. */
export function startNotifyServer(opts: {
  port: number;
  token: string;
  send: (text: string) => Promise<void>;
}): void {
  createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (typeof text !== 'string' || !text.trim()) throw new Error('text fehlt');
        await opts.send(text);
        res.writeHead(200).end('ok');
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
    });
  }).listen(opts.port, '127.0.0.1');
}
