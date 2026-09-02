import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CrawlReport } from '../types.js';

export async function writeJsonReport(report: CrawlReport, outDir: string): Promise<string> {
  const path = join(outDir, 'report.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}
