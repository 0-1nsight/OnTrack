/**
 * Document adapters (capture stage, runtime-agnostic).
 *
 * ManicTime-style "documents" tracking, kept metadata-only: each adapter reads
 * the foreground app name and window title and returns structured context
 * (document name, kind, optional section). Titles that may contain message
 * content (email subjects) are redacted, with only configured client codes kept.
 */

export type DocumentKind =
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'pdf'
  | 'accounting_file'
  | 'email'
  | 'calendar'
  | 'chat';

export interface DocumentContext {
  adapter: string;
  kind: DocumentKind;
  /** File or company name, never file contents. Null when the title may carry message content. */
  documentName: string | null;
  extension: string | null;
  /** Screen or module inside the app (e.g. a QuickBooks window name). */
  section: string | null;
  /** When true the raw window title must be replaced by `redactedTitle` before it is queued. */
  suppressTitle: boolean;
  redactedTitle: string | null;
  /** Client codes found in titles that are otherwise redacted. */
  clientHints: string[];
}

export interface DocumentAdapterOptions {
  /** Patterns that identify client codes (e.g. ACME-1042). Matches are the only text kept from redacted titles. */
  clientCodePatterns?: RegExp[];
}

export interface DocumentAdapter {
  id: string;
  matches(app: string, title: string): boolean;
  resolve(app: string, title: string, options: DocumentAdapterOptions): DocumentContext | null;
}

const DEFAULT_CLIENT_CODE = /\b[A-Z]{2,6}-\d{3,6}\b/g;

function extensionOf(name: string): string | null {
  const m = name.match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : null;
}

/** Removes status chips Office puts in titles, in any order. */
function stripOfficeNoise(name: string): string {
  let out = name;
  const noise = [
    /\s*[-–—]\s*Saved to this PC$/i,
    /\s*[-–—]\s*Saved$/i,
    /\s*[-–—]\s*Saving\.{0,3}$/i,
    /\s*[-–—]\s*AutoSaved$/i,
    /\s*[-–—]\s*Protected View$/i,
    /\s*[-–—]\s*Read-?Only$/i,
    /\s*\[(Read-?Only|Compatibility Mode|Group|Protected View|Repaired)\]/gi,
    /\s*[-–—]\s*Compatibility Mode$/i,
    /\s*[-–—]\s*Excel$/i,
    /\s*[-–—]\s*Word$/i,
    /\s*[-–—]\s*PowerPoint$/i,
    /\s*[-–—]\s*Edited$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of noise) {
      const next = out.replace(re, '');
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out.trim();
}

function base(partial: Partial<DocumentContext> & Pick<DocumentContext, 'adapter' | 'kind'>): DocumentContext {
  return {
    documentName: null,
    extension: null,
    section: null,
    suppressTitle: false,
    redactedTitle: null,
    clientHints: [],
    ...partial,
  };
}

function officeAdapter(
  id: string,
  kind: DocumentKind,
  appPattern: RegExp,
  titleSuffix: RegExp
): DocumentAdapter {
  return {
    id,
    matches: (app, title) => appPattern.test(app) || titleSuffix.test(title),
    resolve: (_app, title) => {
      const name = stripOfficeNoise(title);
      // Start screens and empty windows carry no document.
      if (!name || /^(excel|word|powerpoint|microsoft (excel|word|powerpoint))$/i.test(name)) {
        return null;
      }
      return base({ adapter: id, kind, documentName: name, extension: extensionOf(name) });
    },
  };
}

const pdfAdapter: DocumentAdapter = {
  id: 'pdf',
  matches: (app, title) =>
    /acrobat|foxit|sumatra|pdf expert|preview/i.test(app) || /\.pdf\b/i.test(title),
  resolve: (_app, title) => {
    const cleaned = title
      .replace(/\s*[-–—]\s*(Adobe Acrobat.*|Acrobat Reader.*|Foxit.*|SumatraPDF.*|PDF Expert.*)$/i, '')
      .replace(/\s*[-–—]\s*Page \d+ of \d+$/i, '')
      .replace(/\s*[-–—]\s*Edited$/i, '')
      .trim();
    if (!cleaned) return null;
    return base({
      adapter: 'pdf',
      kind: 'pdf',
      documentName: cleaned,
      extension: extensionOf(cleaned) ?? 'pdf',
    });
  },
};

const quickbooksAdapter: DocumentAdapter = {
  id: 'quickbooks',
  matches: (app, title) => /quickbooks|qbw32|qbdt/i.test(app) || /QuickBooks/i.test(title),
  resolve: (_app, title) => {
    // Desktop formats seen in the wild:
    //   "QuickBooks Desktop Pro 2024 - Acme Inc - [Create Invoices]"
    //   "Acme Inc - QuickBooks Desktop Enterprise 24.0"
    const bracket = title.match(/\[([^\]]+)\]/);
    const parts = title
      .replace(/\s*[-–—]?\s*\[[^\]]+\]/g, '')
      .split(/\s[-–—]\s/)
      .map((p) => p.replace(/^[-–—\s]+|[-–—\s]+$/g, ''))
      .filter(Boolean);
    const company = parts.find((p) => !/quickbooks/i.test(p)) ?? null;
    if (!company && !bracket) return null;
    return base({
      adapter: 'quickbooks',
      kind: 'accounting_file',
      documentName: company,
      extension: 'qbw',
      section: bracket ? bracket[1].trim() : null,
    });
  },
};

function collectClientHints(title: string, options: DocumentAdapterOptions): string[] {
  const patterns = options.clientCodePatterns?.length ? options.clientCodePatterns : [DEFAULT_CLIENT_CODE];
  const found = new Set<string>();
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    for (const m of title.matchAll(re)) {
      if (m[0]) found.add(m[0]);
    }
  }
  return [...found];
}

const outlookAdapter: DocumentAdapter = {
  id: 'outlook',
  matches: (app, title) => /outlook/i.test(app) || /\bOutlook\b/.test(title),
  resolve: (_app, title, options) => {
    const isCalendar = /calendar|meeting|appointment/i.test(title) && !/^(re|fw|fwd):/i.test(title);
    const kind: DocumentKind = isCalendar ? 'calendar' : 'email';
    const hints = collectClientHints(title, options);
    const label = kind === 'calendar' ? 'Outlook – Calendar' : 'Outlook – Mail';
    return base({
      adapter: 'outlook',
      kind,
      suppressTitle: true,
      redactedTitle: hints.length ? `${label} [${hints.join(', ')}]` : label,
      clientHints: hints,
    });
  },
};

const chatAdapter: DocumentAdapter = {
  id: 'chat',
  matches: (app) => /slack|teams|whatsapp|discord|telegram|signal/i.test(app),
  resolve: (app, title, options) => {
    // Chat titles name a channel or contact, which can be personal; keep only client codes.
    const hints = collectClientHints(title, options);
    const label = `${app} – Chat`;
    return base({
      adapter: 'chat',
      kind: 'chat',
      suppressTitle: true,
      redactedTitle: hints.length ? `${label} [${hints.join(', ')}]` : label,
      clientHints: hints,
    });
  },
};

export const DEFAULT_DOCUMENT_ADAPTERS: DocumentAdapter[] = [
  quickbooksAdapter,
  outlookAdapter,
  officeAdapter('excel', 'spreadsheet', /excel/i, /\s[-–—]\s*Excel$/i),
  officeAdapter('word', 'document', /winword|microsoft word|^word$/i, /\s[-–—]\s*Word$/i),
  officeAdapter('powerpoint', 'presentation', /powerpnt|powerpoint/i, /\s[-–—]\s*PowerPoint$/i),
  pdfAdapter,
  chatAdapter,
];

/**
 * Resolves document context for a foreground window. The first adapter that
 * matches and returns a context wins; adapters that match but find nothing fall through.
 */
export function resolveDocumentContext(
  app: string,
  windowTitle: string,
  options: DocumentAdapterOptions = {},
  adapters: DocumentAdapter[] = DEFAULT_DOCUMENT_ADAPTERS
): DocumentContext | null {
  for (const adapter of adapters) {
    if (!adapter.matches(app, windowTitle)) continue;
    const ctx = adapter.resolve(app, windowTitle, options);
    if (ctx) return ctx;
  }
  return null;
}

export interface PayloadPatch {
  window_title: string;
  file_path: string | null;
  document_kind: DocumentKind | null;
  document_name: string | null;
  document_section: string | null;
}

/**
 * Applies a document context to a raw sample. The returned title is safe to queue:
 * redacted when the adapter says the original may contain message content.
 */
export function applyDocumentContext(
  app: string,
  windowTitle: string,
  existingFilePath: string | null,
  options: DocumentAdapterOptions = {}
): PayloadPatch {
  const ctx = resolveDocumentContext(app, windowTitle, options);
  if (!ctx) {
    return {
      window_title: windowTitle,
      file_path: existingFilePath,
      document_kind: null,
      document_name: null,
      document_section: null,
    };
  }
  return {
    window_title: ctx.suppressTitle && ctx.redactedTitle ? ctx.redactedTitle : windowTitle,
    file_path: ctx.documentName && ctx.extension ? ctx.documentName : existingFilePath,
    document_kind: ctx.kind,
    document_name: ctx.documentName,
    document_section: ctx.section,
  };
}
