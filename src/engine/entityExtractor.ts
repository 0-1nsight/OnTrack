import {
  ActivityDictionaryEntry,
  ClientDictionaryEntry,
  ExtractedEntities,
  TrackingEventPayload,
} from './types';

const DOC_PATTERNS: { pattern: RegExp; docType: string }[] = [
  { pattern: /bank[\s_-]?statement|chequing|checking|savings\s+stmt/i, docType: 'Bank Statement' },
  { pattern: /reconcil|bank\s+rec/i, docType: 'Bank Reconciliation' },
  { pattern: /payroll|pay\s*stub|payslip|w-?2|p45|nis|paye/i, docType: 'Payroll Register' },
  { pattern: /invoice|inv[-_\s]?\d+|billing|accounts\s+receivable|a\/r/i, docType: 'Invoice / AR' },
  { pattern: /accounts\s+payable|a\/p|vendor\s+bill/i, docType: 'Vendor Bill / AP' },
  { pattern: /tax\s*return|1120|1040|gct|vat|corp\s*tax|cit\b/i, docType: 'Tax Return' },
  { pattern: /trial[\s_-]?balance|tb[-_\s]/i, docType: 'Trial Balance' },
  { pattern: /general[\s_-]?ledger|\bgl[-_\s]/i, docType: 'General Ledger' },
  { pattern: /journal[\s_-]?entry|\bje[-_\s]/i, docType: 'Journal Entry' },
  { pattern: /\.xlsx?$|excel|spreadsheet|workbook/i, docType: 'Working Papers (.xlsx)' },
  { pattern: /\.pdf$/i, docType: 'PDF Document' },
];

const PERIOD_PATTERNS: RegExp[] = [
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*[\s_-]+(20\d{2})\b/i,
  /\b(Q[1-4])[\s_-]*(20\d{2}|\d{2})\b/i,
  /\b(FY\s*20\d{2}|FY\s*\d{2})\b/i,
  /\b(20\d{2})[-_/](\d{2})\b/,
  /\b(Q[1-4])\b/i,
];

function normalizePeriod(raw: string): string {
  const clean = raw.replace(/[_-]+/g, ' ').trim();
  const ym = clean.match(/^(20\d{2})\s+(\d{2})$/);
  if (ym) {
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const mIdx = Math.max(0, Math.min(11, parseInt(ym[2], 10) - 1));
    return `${months[mIdx]} ${ym[1]}`;
  }
  return clean;
}

export function extractPeriod(text: string): string | null {
  for (const regex of PERIOD_PATTERNS) {
    const m = text.match(regex);
    if (m && m[0]) {
      return normalizePeriod(m[0]);
    }
  }
  return null;
}

export function extractDocType(text: string): string | null {
  for (const item of DOC_PATTERNS) {
    if (item.pattern.test(text)) {
      return item.docType;
    }
  }
  return null;
}

function tokenMatchScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n || n.length < 2) return 0;

  // Word-boundary exact token match is strongest
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryRegex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  if (boundaryRegex.test(h)) return 1.0;
  if (n.length >= 4 && h.includes(n)) return 0.78;
  return 0;
}

export function extractEntitiesFromPayload(
  payload: TrackingEventPayload,
  clients: ClientDictionaryEntry[],
  activityRules: ActivityDictionaryEntry[]
): ExtractedEntities {
  const title = payload.window_title || '';
  const path = payload.file_path || '';
  const url = payload.url || '';
  const domain = payload.domain || '';
  const app = payload.app || '';

  const combined = `${title} ${path} ${url} ${domain}`.trim();
  const signals: string[] = [];

  // 1. Client dictionary matching (weighted: path/url/domain > title)
  let bestClient: { entry: ClientDictionaryEntry; score: number; reason: string } | null = null;

  for (const client of clients) {
    let score = 0;
    let reason = '';

    // Known domains (strongest browser signal)
    for (const d of client.knownDomains) {
      if (domain.toLowerCase().includes(d.toLowerCase()) || url.toLowerCase().includes(d.toLowerCase())) {
        score = Math.max(score, 0.96);
        reason = `known domain '${d}' in URL`;
      }
    }

    // Folder patterns (strongest file signal)
    for (const fp of client.folderPatterns) {
      if (fp && path.toLowerCase().includes(fp.toLowerCase())) {
        score = Math.max(score, 0.94);
        reason = `folder pattern '${fp}' in file path`;
      }
    }

    // Client codes
    for (const code of client.codes) {
      const mPath = tokenMatchScore(path, code);
      const mTitle = tokenMatchScore(title, code);
      if (mPath > 0) {
        const s = 0.92 * mPath;
        if (s > score) {
          score = s;
          reason = `client code '${code}' in file path`;
        }
      }
      if (mTitle > 0) {
        const s = 0.88 * mTitle;
        if (s > score) {
          score = s;
          reason = `client code '${code}' in window title`;
        }
      }
    }

    // Legal name & aliases
    for (const term of [client.legalName, ...client.aliases]) {
      const mUrl = tokenMatchScore(`${url} ${path}`, term);
      const mTitle = tokenMatchScore(title, term);
      if (mUrl > 0) {
        const s = 0.92 * mUrl;
        if (s > score) {
          score = s;
          reason = `client alias '${term}' in URL/path`;
        }
      }
      if (mTitle > 0) {
        const s = 0.89 * mTitle;
        if (s > score) {
          score = s;
          reason = `client alias '${term}' in window title`;
        }
      }
    }

    if (score > 0 && (!bestClient || score > bestClient.score)) {
      bestClient = { entry: client, score, reason };
    }
  }

  if (bestClient) {
    signals.push(bestClient.reason);
  }

  // 2. Period extraction
  const period = extractPeriod(combined);
  if (period) {
    signals.push(`period '${period}' detected`);
  }

  // 3. Document type extraction
  const docType = extractDocType(combined);
  if (docType) {
    signals.push(`document type '${docType}'`);
  }

  // 4. Activity type from firm activity dictionary
  let activityType: string | null = null;
  let bestActWeight = 0;
  for (const rule of activityRules) {
    if (combined.toLowerCase().includes(rule.keyword.toLowerCase())) {
      if (rule.weight > bestActWeight) {
        bestActWeight = rule.weight;
        activityType = rule.activityType;
      }
    }
  }
  if (!activityType) {
    if (/quickbooks|xero/i.test(app) || /quickbooks|xero/i.test(title)) {
      activityType = 'Ledger / Bookkeeping';
    } else if (/excel/i.test(app)) {
      activityType = 'Workpaper Analysis';
    } else if (/zoom|teams|meet|slack/i.test(app)) {
      activityType = 'Client / Team Comms';
    }
  }
  if (activityType) {
    signals.push(`activity '${activityType}'`);
  }

  return {
    clientId: bestClient ? bestClient.entry.id : null,
    clientName: bestClient ? bestClient.entry.legalName : null,
    period,
    docType,
    activityType,
    signals,
  };
}
