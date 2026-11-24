import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from '../config.ts';
import { ensureWindowsTemplateExe, findWindowsCscExe } from '../installerBuilder.ts';

async function main() {
  const csc = findWindowsCscExe();
  if (!csc) {
    console.error('build:win-installer requires Windows with .NET Framework csc.exe installed.');
    process.exit(1);
  }
  const built = await ensureWindowsTemplateExe();
  if (!built || !fs.existsSync(built)) {
    console.error('Failed to compile OnTrackSetupTemplate.exe');
    process.exit(1);
  }
  const distDir = path.resolve(appConfig.projectRoot, 'packages', 'installer', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const target = path.resolve(distDir, 'OnTrackSetupTemplate.exe');
  fs.copyFileSync(built, target);
  console.log(`Built Windows installer template: ${target}`);
}

void main();
