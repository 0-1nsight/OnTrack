import { ClientDictionaryEntry } from './types';

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function splitListField(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;|,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses uploaded CSV/TSV, JSON client rosters, or plain-text folder lists
 * into normalized ClientDictionaryEntry records.
 */
export function parseClientImportContent(
  rawText: string,
  tenantId: string,
  source: 'csv' | 'file_upload' = 'csv'
): Omit<ClientDictionaryEntry, 'id' | 'updatedAtUtc'>[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  // 1. JSON array upload support
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.clients)
        ? parsed.clients
        : [];
      return list
        .filter((item: any) => item && (item.legalName || item.name || item.client))
        .map((item: any) => ({
          tenantId,
          legalName: String(item.legalName || item.name || item.client).trim(),
          aliases: Array.isArray(item.aliases)
            ? item.aliases.map(String)
            : splitListField(item.aliases),
          codes: Array.isArray(item.codes)
            ? item.codes.map(String)
            : splitListField(item.code || item.codes),
          folderPatterns: Array.isArray(item.folderPatterns)
            ? item.folderPatterns.map(String)
            : splitListField(item.folder || item.folderPatterns),
          knownDomains: Array.isArray(item.knownDomains)
            ? item.knownDomains.map(String)
            : splitListField(item.domain || item.knownDomains),
          restrictedUserIds: Array.isArray(item.restrictedUserIds)
            ? item.restrictedUserIds.map(String)
            : [],
          source,
        }));
    } catch {
      // fall through to line parser
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t')
    ? '\t'
    : firstLine.includes(',')
    ? ','
    : null;

  // 2. Plain text folder/client list upload (one client or path per line)
  if (!delimiter) {
    return lines.map((line) => {
      const cleanName = line.replace(/^.*[\\/]/, '').trim();
      const shortCode = cleanName
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 4);
      return {
        tenantId,
        legalName: cleanName,
        aliases: [cleanName.split(' ')[0]].filter(Boolean),
        codes: shortCode.length >= 2 ? [shortCode] : [],
        folderPatterns: [line.includes('/') || line.includes('\\') ? line : cleanName],
        knownDomains: [],
        restrictedUserIds: [],
        source,
      };
    });
  }

  // 3. CSV / TSV parser with flexible header mapping
  const headerCols = splitCsvLine(firstLine, delimiter).map((h) =>
    h.toLowerCase().replace(/[^a-z0-9]/g, '')
  );

  const hasHeader = headerCols.some((h) =>
    ['name', 'legalname', 'client', 'clientname', 'alias', 'aliases', 'code', 'codes'].includes(h)
  );

  const findCol = (candidates: string[], fallbackIdx: number) => {
    if (!hasHeader) return fallbackIdx;
    const idx = headerCols.findIndex((h) => candidates.includes(h));
    return idx >= 0 ? idx : -1;
  };

  const idxName = findCol(['legalname', 'clientname', 'client', 'name', 'company'], 0);
  const idxAlias = findCol(['aliases', 'alias', 'aka', 'shortname'], 1);
  const idxCode = findCol(['codes', 'code', 'clientcode', 'id'], 2);
  const idxFolder = findCol(['folders', 'folder', 'folderpatterns', 'path'], 3);
  const idxDomain = findCol(['domains', 'domain', 'knowndomains', 'website'], 4);
  const idxRestricted = findCol(['restricted', 'restrictedusers', 'restricteduserids'], 5);

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const entries: Omit<ClientDictionaryEntry, 'id' | 'updatedAtUtc'>[] = [];

  for (const line of dataLines) {
    const cols = splitCsvLine(line, delimiter);
    const legalName = idxName >= 0 ? (cols[idxName] || '').trim() : '';
    if (!legalName) continue;

    entries.push({
      tenantId,
      legalName,
      aliases: idxAlias >= 0 ? splitListField(cols[idxAlias]) : [],
      codes: idxCode >= 0 ? splitListField(cols[idxCode]) : [],
      folderPatterns: idxFolder >= 0 ? splitListField(cols[idxFolder]) : [],
      knownDomains: idxDomain >= 0 ? splitListField(cols[idxDomain]) : [],
      restrictedUserIds: idxRestricted >= 0 ? splitListField(cols[idxRestricted]) : [],
      source,
    });
  }

  return entries;
}
