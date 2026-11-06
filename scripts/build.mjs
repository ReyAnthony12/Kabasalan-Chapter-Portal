import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL('../dist/', import.meta.url);
if (resolve(fileURLToPath(out)) !== resolve(root,'dist')) throw new Error('Build directory must remain inside this project.');
// Only the public site is packaged; migrations, tests and developer packages stay private.
await rm(out, { recursive:true, force:true });
await mkdir(out, { recursive:true });
for (const path of ['index.html','public','src']) await cp(new URL(path,new URL('../',import.meta.url)),new URL(path,out),{recursive:true});
console.log(`Static site prepared at ${root}dist`);
