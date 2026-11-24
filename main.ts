import { access, copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const image = join(here, 'entry.png');
const outputDir = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output');

try {
  await access(image);
} catch {
  const render = spawnSync(process.execPath, [join(here, 'render.mjs')], {
    cwd: here,
    stdio: 'inherit',
  });
  if (render.error) throw render.error;
  if (render.status !== 0) throw new Error(`Renderer exited with status ${render.status}`);
}

await mkdir(outputDir, { recursive: true });
await copyFile(image, join(outputDir, 'entry.png'));
process.stdout.write(`Copied entry.png to ${outputDir}\n`);
