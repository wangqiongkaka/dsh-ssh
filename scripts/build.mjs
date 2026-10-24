import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('lib', { recursive: true });
await build({ entryPoints: ['src/index.mjs'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@deepseek-ai/*'], sourcemap: true });
await copyFile('src/ssh-cli.mjs', 'lib/ssh-cli.mjs');
await copyFile('src/askpass.mjs', 'lib/askpass.mjs');
await mkdir('lib/licenses', { recursive: true });
for (const file of ['NotoSansSC-OFL.txt', 'JetBrainsMono-OFL.txt', 'Lucide-LICENSE.txt']) await copyFile('src/assets/' + file, 'lib/licenses/' + file);
await build({ entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text', '.woff2': 'dataurl' },
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-ssh", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' }, sourcemap: true });
