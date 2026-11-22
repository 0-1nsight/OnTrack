import { PrivacyRule, TrackingEvent, TrackingEventPayload } from './types';

/**
 * Privacy-first invariant (PRIV-2):
 * Forbidden content fields must NEVER be accepted, stored, or transmitted.
 */
export const FORBIDDEN_METADATA_KEYS = [
  'screenshot',
  'screenshots',
  'image_base64',
  'keystroke',
  'keystrokes',
  'key_log',
  'clipboard',
  'clipboard_text',
  'document_content',
  'file_content',
  'page_content',
  'body_html',
  'dom_text',
  'raw_text',
  'gps',
  'latitude',
  'longitude',
] as const;

export function hasForbiddenPayloadFields(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (
        (FORBIDDEN_METADATA_KEYS as readonly string[]).includes(normalized) &&
        value !== undefined &&
        value !== null
      ) {
        return key;
      }
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return null;
}

export function stripForbiddenFields(payload: TrackingEventPayload): TrackingEventPayload {
  const clone: Record<string, unknown> = { ...payload };
  for (const key of Object.keys(clone)) {
    if ((FORBIDDEN_METADATA_KEYS as readonly string[]).includes(key.toLowerCase())) {
      delete clone[key];
    }
  }
  return clone as TrackingEventPayload;
}

function wildcardMatch(target: string, pattern: string): boolean {
  const cleanTarget = target.toLowerCase();
  const cleanPattern = pattern.trim().toLowerCase();
  if (!cleanPattern) return false;
  if (!cleanPattern.includes('*')) {
    return cleanTarget.includes(cleanPattern);
  }
  const escaped = cleanPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(escaped, 'i');
  return regex.test(cleanTarget);
}

export interface PrivacyFilterResult {
  allowed: boolean;
  dropReason?: string;
  sanitizedEvent?: TrackingEvent;
}

/**
 * On-Device Privacy Filter (Stage 3):
 * Runs BEFORE local persistence or network sync.
 * Drops incognito/private browser activity and any matched app, domain, or path exclusions.
 */
export function sanitizeAndFilterEvent(
  event: TrackingEvent,
  rules: PrivacyRule[]
): PrivacyFilterResult {
  // Check forbidden fields
  const forbidden = hasForbiddenPayloadFields(event.payload);
  if (forbidden) {
    return {
      allowed: false,
      dropReason: `Rejected forbidden metadata field "${forbidden}" (PRIV-2)`,
    };
  }

  // Always drop private/incognito browser windows on device (PRIV-1)
  if (event.payload.incognito === true) {
    return {
      allowed: false,
      dropReason: 'Private/Incognito browser window dropped on device (PRIV-1)',
    };
  }

  const app = event.payload.app || '';
  const title = event.payload.window_title || '';
  const url = event.payload.url || '';
  const domain = event.payload.domain || '';
  const filePath = event.payload.file_path || '';

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.kind === 'app') {
      if (wildcardMatch(app, rule.pattern) || wildcardMatch(title, rule.pattern)) {
        return {
          allowed: false,
          dropReason: `Excluded app "${rule.pattern}" (${rule.reason})`,
        };
      }
    } else if (rule.kind === 'domain') {
      if (
        wildcardMatch(url, rule.pattern) ||
        wildcardMatch(domain, rule.pattern) ||
        wildcardMatch(title, rule.pattern)
      ) {
        return {
          allowed: false,
          dropReason: `Excluded domain "${rule.pattern}" (${rule.reason})`,
        };
      }
    } else if (rule.kind === 'path') {
      if (wildcardMatch(filePath, rule.pattern)) {
        return {
          allowed: false,
          dropReason: `Excluded path "${rule.pattern}" (${rule.reason})`,
        };
      }
    }
  }

  return {
    allowed: true,
    sanitizedEvent: {
      ...event,
      payload: stripForbiddenFields(event.payload),
    },
  };
}
