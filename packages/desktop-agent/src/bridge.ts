import crypto from 'node:crypto';
import type http from 'node:http';

export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (!a || !b) return false;
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function isAllowedBridgeOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  return /^(chrome-extension|moz-extension|safari-web-extension):\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(
    originHeader
  );
}

export interface BridgeHandlerDeps {
  getSecret: () => string;
  getConfigInfo: () => {
    excludedDomains: string[];
    idleThresholdSeconds: number;
    deviceId: string;
  };
  getHealthInfo: () => Record<string, unknown>;
  onBrowserEvent: (msg: Record<string, unknown>) => boolean;
}

export function createBridgeRequestHandler(
  deps: BridgeHandlerDeps
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const originHeader =
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedBridgeOrigin(originHeader)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden local bridge origin' }));
      return;
    }

    if (originHeader) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-OnTrack-Bridge-Secret, X-Requested-With'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && rawUrl === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          bridgeAuthRequired: true,
          ...deps.getHealthInfo(),
        })
      );
      return;
    }

    const headerSecretRaw = req.headers['x-ontrack-bridge-secret'];
    const providedSecret = Array.isArray(headerSecretRaw)
      ? headerSecretRaw[0] || ''
      : headerSecretRaw || '';

    if (!timingSafeEqualStrings(providedSecret, deps.getSecret())) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Unauthorized loopback bridge request: valid X-OnTrack-Bridge-Secret header is required.',
        })
      );
      return;
    }

    if (req.method === 'POST' && rawUrl === '/browser-event') {
      let body = '';
      let oversized = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          oversized = true;
        }
      });
      req.on('end', () => {
        if (oversized) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        try {
          const msg = JSON.parse(body || '{}') as Record<string, unknown>;
          const accepted = deps.onBrowserEvent(msg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accepted }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && rawUrl === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(deps.getConfigInfo()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}
