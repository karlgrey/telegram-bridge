import { createServer } from 'node:http';

/** Lokaler Push-Endpoint: POST /notify {"text":"…", "question_id"?: "…", "timeout_min"?: n} mit Bearer-Token. */
export function startNotifyServer(opts: {
  port: number;
  token: string;
  send: (text: string, questionId?: string, timeoutMin?: number) => Promise<void>;
}): void {
  const server = createServer((req, res) => {
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
        const { text, question_id, timeout_min } = JSON.parse(body);
        if (typeof text !== 'string' || !text.trim()) throw new Error('text fehlt');
        if (question_id !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(String(question_id)))
          throw new Error('question_id ungültig (erlaubt: A-Za-z0-9-, max 64)');
        if (timeout_min !== undefined && (!Number.isInteger(timeout_min) || timeout_min < 1 || timeout_min > 600))
          throw new Error('timeout_min ungültig (Ganzzahl 1–600)');
        await opts.send(text, question_id, timeout_min);
        res.writeHead(200).end('ok');
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
    });
  });
  // Fehler abfangen (z. B. Port-Konflikt EADDRINUSE) — Daemon läuft ohne /notify weiter.
  server.on('error', (err) => console.error('notify-Server-Fehler (läuft ohne /notify weiter):', err.message));
  server.listen(opts.port, '127.0.0.1');
}
