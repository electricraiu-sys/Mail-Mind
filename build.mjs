import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { zipDirectory } from './scripts/zip.mjs';

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const pkg = args.has('--package');

const entryPoints = {
  background: 'src/background/main.ts',
  'ui/chat/chat': 'src/ui/chat/chat.ts',
  'ui/options/options': 'src/ui/options/options.ts',
  'ui/popups/message': 'src/ui/popups/message.ts',
  'ui/popups/compose': 'src/ui/popups/compose.ts',
  'ui/presend/presend': 'src/ui/presend/presend.ts',
};

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await cp('src/manifest.json', 'dist/manifest.json');
  await cp('src/icons', 'dist/icons', { recursive: true });
  // Copy every .html / .css file under src/ui, keeping the folder structure.
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(html|css)$/.test(e.name)) {
        const dest = path.join('dist', path.relative('src', full));
        await mkdir(path.dirname(dest), { recursive: true });
        await cp(full, dest);
      }
    }
  }
  await walk('src/ui');
}

const options = {
  entryPoints,
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: ['firefox128'],
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

await rm('dist', { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes… (static files are copied once; restart to recopy html/css)');
} else {
  await esbuild.build(options);
  if (pkg) {
    const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
    const out = `artifacts/mailmind-${manifest.version}.xpi`;
    const n = await zipDirectory('dist', out);
    console.log(`Packaged ${n} files -> ${out}`);
  }
}
