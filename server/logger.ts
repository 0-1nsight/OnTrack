export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'rawtoken',
  'sessionsecret',
  'totpsecret',
  'authorization',
  'cookie',
]);

function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactObject(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactObject(v, depth + 1);
    }
  }
  return out;
}

function writeLog(level: LogLevel, event: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test' && level === 'debug') return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'ontrack-server',
    event,
    ...(meta ? (redactObject(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, meta?: Record<string, unknown>) => writeLog('debug', event, meta),
  info: (event: string, meta?: Record<string, unknown>) => writeLog('info', event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => writeLog('warn', event, meta),
  error: (event: string, meta?: Record<string, unknown>) => writeLog('error', event, meta),
};
