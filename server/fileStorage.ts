import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.txt',
  '.json',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.xlsx',
]);

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export function getUploadsBaseDir(): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  const uploadsDir = path.resolve(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  return uploadsDir;
}

export function sanitizeOriginalFilename(name: string): string {
  const base = path.basename(name || 'document.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || 'document.txt';
}

export function savePortableFileToDisk(params: {
  tenantId: string;
  originalName: string;
  contentBuffer: Buffer;
}): {
  fileId: string;
  safeOriginalName: string;
  storedRelPath: string;
  byteSize: number;
  sha256: string;
} {
  if (params.contentBuffer.length === 0) {
    throw new Error('Uploaded file is empty');
  }
  if (params.contentBuffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds 5MB limit');
  }

  const safeTenant = params.tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeOriginalName = sanitizeOriginalFilename(params.originalName);
  const ext = path.extname(safeOriginalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file extension: ${ext || '(none)'}`);
  }

  const baseDir = getUploadsBaseDir();
  const tenantDir = path.resolve(baseDir, safeTenant);
  if (!tenantDir.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid tenant upload directory');
  }
  fs.mkdirSync(tenantDir, { recursive: true });

  const fileId = `fil-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const diskFilename = `${fileId}_${safeOriginalName}`;
  const fullPath = path.resolve(tenantDir, diskFilename);
  if (!fullPath.startsWith(tenantDir + path.sep)) {
    throw new Error('Path traversal check failed');
  }

  fs.writeFileSync(fullPath, params.contentBuffer);
  const sha256 = crypto.createHash('sha256').update(params.contentBuffer).digest('hex');

  return {
    fileId,
    safeOriginalName,
    storedRelPath: `${safeTenant}/${diskFilename}`,
    byteSize: params.contentBuffer.length,
    sha256,
  };
}

export function readPortableFileFromDisk(storedRelPath: string): Buffer {
  const baseDir = getUploadsBaseDir();
  const fullPath = path.resolve(baseDir, storedRelPath);
  if (!fullPath.startsWith(baseDir + path.sep)) {
    throw new Error('Path traversal rejected');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error('Stored file not found on disk');
  }
  return fs.readFileSync(fullPath);
}
