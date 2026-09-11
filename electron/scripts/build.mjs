import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = path.join(root, 'dist', 'app');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const directory of ['src', 'fixtures']) await cp(path.join(root, directory), path.join(target, directory), { recursive: true });
const { name, version, description, license, main } = JSON.parse(await readFile(path.join(root, 'package.json')));
await writeFile(path.join(target, 'package.json'), JSON.stringify({ name, version, description, license, main }, null, 2) + '\n');
console.log('Built dist/app with local application files and finite fixtures.');
