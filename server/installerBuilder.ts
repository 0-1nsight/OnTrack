import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { appConfig } from './config.ts';
import { HttpError } from './errors.ts';

const execFileAsync = promisify(execFile);
const OVERLAY_MAGIC = Buffer.from('OTBNDL01', 'ascii');

function addDirToZip(zip: JSZip, dir: string, prefix: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDirToZip(zip, full, rel);
    } else {
      zip.file(rel, fs.readFileSync(full));
    }
  }
}

export function findWindowsCscExe(): string | null {
  if (process.platform !== 'win32') return null;
  const windir = process.env.WINDIR || 'C:\\Windows';
  for (const dir of ['Framework64', 'Framework']) {
    const candidate = path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function ensureWindowsTemplateExe(): Promise<string | null> {
  const installerRoot = path.resolve(appConfig.projectRoot, 'packages', 'installer');
  const distTemplate = path.resolve(installerRoot, 'dist', 'OnTrackSetupTemplate.exe');
  if (fs.existsSync(distTemplate)) {
    return distTemplate;
  }

  const csc = findWindowsCscExe();
  const csSource = path.resolve(installerRoot, 'windows', 'OnTrackSetup.cs');
  if (!csc || !fs.existsSync(csSource)) {
    return null;
  }

  const srcBytes = fs.readFileSync(csSource);
  const hash = crypto.createHash('sha256').update(srcBytes).digest('hex').slice(0, 12);
  const cacheDir = path.resolve(appConfig.dataDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachedExe = path.resolve(cacheDir, `OnTrackSetupTemplate-${hash}.exe`);
  if (fs.existsSync(cachedExe)) {
    return cachedExe;
  }

  await execFileAsync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      '/r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll',
      `/out:${cachedExe}`,
      csSource,
    ],
    { timeout: 60_000 }
  );

  return fs.existsSync(cachedExe) ? cachedExe : null;
}

export async function getInstallerCapabilities(): Promise<{
  windowsExeReady: boolean;
  windowsFilename: string;
  unixFilename: string;
  platform: string;
}> {
  const templateExe = await ensureWindowsTemplateExe().catch(() => null);
  const windowsExeReady = Boolean(templateExe);
  return {
    windowsExeReady,
    windowsFilename: windowsExeReady ? 'OnTrack-Setup.exe' : 'OnTrack-Setup-Windows.zip',
    unixFilename: 'ontrack-collector-unix.zip',
    platform: process.platform,
  };
}

export async function buildUnifiedBundleZip(params: {
  tenantId: string;
  userId: string;
  serverUrl: string;
  bridgeSecret: string;
}): Promise<Buffer> {
  const packagesRoot = path.resolve(appConfig.projectRoot, 'packages');
  const agentDir = path.resolve(packagesRoot, 'desktop-agent');
  const extDir = path.resolve(packagesRoot, 'browser-extension');

  if (!agentDir.startsWith(packagesRoot + path.sep) || !fs.existsSync(agentDir)) {
    throw new HttpError(404, 'PACKAGE_NOT_FOUND', 'Desktop agent source directory not found.');
  }
  if (!extDir.startsWith(packagesRoot + path.sep) || !fs.existsSync(extDir)) {
    throw new HttpError(404, 'PACKAGE_NOT_FOUND', 'Browser extension source directory not found.');
  }

  const zip = new JSZip();
  addDirToZip(zip, agentDir, 'desktop-agent');
  addDirToZip(zip, extDir, 'browser-extension');

  zip.file(
    'install-meta.json',
    JSON.stringify(
      {
        serverUrl: params.serverUrl,
        tenantId: params.tenantId,
        userId: params.userId,
        bridgePort: 47621,
        bridgeSecret: params.bridgeSecret,
        heartbeatSeconds: 12,
        pollSampleMs: 2000,
        idleThresholdSeconds: 180,
      },
      null,
      2
    )
  );

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    platform: 'DOS',
  });
}

export function appendBundleOverlayToExe(templateExeBuffer: Buffer, bundleZip: Buffer): Buffer {
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(bundleZip.length), 0);
  return Buffer.concat([templateExeBuffer, bundleZip, lenBuf, OVERLAY_MAGIC]);
}

export async function buildWindowsInstallerArtifact(params: {
  tenantId: string;
  userId: string;
  serverUrl: string;
  bridgeSecret: string;
}): Promise<{
  buffer: Buffer;
  filename: string;
  contentType: string;
  format: 'exe' | 'zip';
}> {
  const bundleZip = await buildUnifiedBundleZip(params);
  const templatePath = await ensureWindowsTemplateExe().catch(() => null);

  if (templatePath && fs.existsSync(templatePath)) {
    const templateBytes = fs.readFileSync(templatePath);
    const exeBuffer = appendBundleOverlayToExe(templateBytes, bundleZip);
    return {
      buffer: exeBuffer,
      filename: 'OnTrack-Setup.exe',
      contentType: 'application/vnd.microsoft.portable-executable',
      format: 'exe',
    };
  }

  // Fallback when server runs on Linux/Docker without a pre-compiled .exe template:
  // Ship a 1-click unified archive with OnTrack-Setup.bat + OnTrackSetup.cs + ontrack-bundle.zip
  // so Windows compiles & launches the exact same native GUI installer on double-click.
  const winDir = path.resolve(appConfig.projectRoot, 'packages', 'installer', 'windows');
  const batPath = path.resolve(winDir, 'OnTrack-Setup.bat');
  const csPath = path.resolve(winDir, 'OnTrackSetup.cs');
  if (!fs.existsSync(batPath) || !fs.existsSync(csPath)) {
    throw new HttpError(404, 'INSTALLER_NOT_FOUND', 'Windows installer sources not found.');
  }

  const outerZip = new JSZip();
  outerZip.file('OnTrack-Setup.bat', fs.readFileSync(batPath));
  outerZip.file('OnTrackSetup.cs', fs.readFileSync(csPath));
  outerZip.file('ontrack-bundle.zip', bundleZip);

  const buffer = await outerZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    platform: 'DOS',
  });

  return {
    buffer,
    filename: 'OnTrack-Setup-Windows.zip',
    contentType: 'application/zip',
    format: 'zip',
  };
}

export async function buildUnixInstallerArtifact(params: {
  tenantId: string;
  userId: string;
  serverUrl: string;
  bridgeSecret: string;
}): Promise<{
  buffer: Buffer;
  filename: string;
  contentType: string;
  format: 'zip';
}> {
  const packagesRoot = path.resolve(appConfig.projectRoot, 'packages');
  const agentDir = path.resolve(packagesRoot, 'desktop-agent');
  const extDir = path.resolve(packagesRoot, 'browser-extension');
  const unixScript = path.resolve(packagesRoot, 'installer', 'unix', 'install.sh');

  if (!fs.existsSync(agentDir) || !fs.existsSync(extDir) || !fs.existsSync(unixScript)) {
    throw new HttpError(404, 'INSTALLER_NOT_FOUND', 'Unix installer sources not found.');
  }

  const zip = new JSZip();
  addDirToZip(zip, agentDir, 'desktop-agent');
  addDirToZip(zip, extDir, 'browser-extension');
  zip.file('install.sh', fs.readFileSync(unixScript), { unixPermissions: '755' });
  zip.file(
    'install-meta.json',
    JSON.stringify(
      {
        serverUrl: params.serverUrl,
        tenantId: params.tenantId,
        userId: params.userId,
        bridgePort: 47621,
        bridgeSecret: params.bridgeSecret,
        heartbeatSeconds: 12,
        pollSampleMs: 2000,
        idleThresholdSeconds: 180,
      },
      null,
      2
    )
  );

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    platform: 'UNIX',
  });

  return {
    buffer,
    filename: 'ontrack-collector-unix.zip',
    contentType: 'application/zip',
    format: 'zip',
  };
}
