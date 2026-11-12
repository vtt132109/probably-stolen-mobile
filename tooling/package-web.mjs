import { readdir, readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createGunzip, createBrotliDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { patchUnityLoader } from './patch-unity-loader.mjs';

const generated = new Set(['sw.js', 'pwa-build.json']);
const workerPath = fileURLToPath(new URL('./pwa/service-worker.js', import.meta.url));
const digest = data => createHash('sha256').update(data).digest('hex');

export function validateRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') ||
      path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid relative asset path: ${path}`);
  }
}

async function inventory(root, current = root) {
  const result = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const full = join(current, item.name);
    const path = relative(root, full).split(sep).join('/');
    validateRelativePath(path);
    if (item.isSymbolicLink()) throw new Error(`Symbolic link is not build content: ${path}`);
    if (item.name.startsWith('.')) throw new Error(`Hidden file is not release content: ${path}`);
    if (item.isDirectory()) result.push(...await inventory(root, full));
    else if (item.isFile() && !generated.has(path) && !path.endsWith('.pwa-tmp')) result.push(path);
  }
  return result.sort();
}

async function hashFile(path, encoding) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  if (encoding) await pipeline(stream, encoding === 'gzip' ? createGunzip() : createBrotliDecompress(), hash);
  else await pipeline(stream, hash);
  return hash.digest();
}

export async function packageWebBuild(directory, { optionalPaths = [], chunkBytes = 0 } = {}) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Build directory is required');
  const paths = await inventory(root);
  for (const path of paths.filter(path => /^Build\/.+\.loader\.js$/.test(path))) {
    const full = join(root, path), original = await readFile(full, 'utf8');
    const patched = patchUnityLoader(original);
    if (patched !== original) await writeFile(full, patched);
  }
  const html = await readFile(join(root, 'index.html'), 'utf8');
  if (/\{\{\{|^\s*#(?:if|endif)/m.test(html)) throw new Error('Unity template has not been built');
  for (const [kind, regex] of [
    ['loader', /^Build\/.+\.loader\.js$/],
    ['data', /^Build\/.+\.data(?:\.(?:br|gz|unityweb))?$/],
    ['wasm', /^Build\/.+\.wasm(?:\.(?:br|gz|unityweb))?$/],
    ['framework', /^Build\/.+\.framework\.js(?:\.(?:br|gz|unityweb))?$/],
  ]) if (!paths.some(path => regex.test(path))) throw new Error(`Missing Unity ${kind} build file`);
  for (const optional of optionalPaths) {
    validateRelativePath(optional);
    if (!optional.startsWith('StreamingAssets/')) throw new Error('Only StreamingAssets packs can be optional; boot files must be required');
    if (!paths.includes(optional)) throw new Error(`Optional asset is missing: ${optional}`);
  }
  const optional = new Set(optionalPaths);
  const files = [];
  const virtualFiles = [];
  for (const path of paths) {
    const full = join(root, path);
    const encoding = path.endsWith('.gz') ? 'gzip' : path.endsWith('.br') ? 'br' : null;
    const encodedHash = await hashFile(full);
    const responseHash = encoding ? await hashFile(full, encoding) : encodedHash;
    let responseBytes = (await lstat(full)).size;
    if (encoding) {
      responseBytes = 0;
      const decoder = encoding === 'gzip' ? createGunzip() : createBrotliDecompress();
      for await (const chunk of createReadStream(full).pipe(decoder)) responseBytes += chunk.length;
    }
    if (chunkBytes && !encoding && /^Build\/.+\.(data|wasm)$/.test(path) && responseBytes > chunkBytes) {
      const parts = [];
      for await (const bytes of createReadStream(full, { highWaterMark: chunkBytes })) {
        const part = path + '.part' + String(parts.length).padStart(3, '0');
        await writeFile(join(root, part), bytes);
        const hash = createHash('sha256').update(bytes).digest();
        const url = part.split('/').map(encodeURIComponent).join('/');
        files.push({path:part,url,transferBytes:bytes.length,responseBytes:bytes.length,
          contentEncoding:null,sha256:hash.toString('hex'),integrity:'sha256-'+hash.toString('base64'),required:true});
        parts.push(url);
      }
      virtualFiles.push({path,url:path.split('/').map(encodeURIComponent).join('/'),parts,responseBytes,
        contentType:path.endsWith('.wasm')?'application/wasm':'application/octet-stream'});
      continue;
    }
    files.push({ path, url: path.split('/').map(encodeURIComponent).join('/'),
      transferBytes: (await lstat(full)).size, responseBytes, contentEncoding: encoding,
      sha256: encodedHash.toString('hex'), integrity: 'sha256-' + responseHash.toString('base64'),
      required: !optional.has(path) });
  }
  const worker = await readFile(workerPath, 'utf8');
  const identity = { schemaVersion: 1, workerDigest: digest(worker), files, ...(virtualFiles.length ? {virtualFiles} : {}) };
  const manifest = { ...identity, version: digest(JSON.stringify(identity)).slice(0, 24),
    totalTransferBytes: files.reduce((sum, file) => sum + file.transferBytes, 0),
    requiredTransferBytes: files.filter(file => file.required).reduce((sum, file) => sum + file.transferBytes, 0) };
  // Publish generated files only after validation/hashing succeeds. Deploy the whole directory atomically.
  await writeFile(join(root, 'pwa-build.json.pwa-tmp'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(root, 'sw.js.pwa-tmp'), `const BUILD = ${JSON.stringify(manifest)};\n${worker}`);
  await rename(join(root, 'pwa-build.json.pwa-tmp'), join(root, 'pwa-build.json'));
  await rename(join(root, 'sw.js.pwa-tmp'), join(root, 'sw.js'));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, ...optionalPaths] = process.argv.slice(2);
  if (!directory) { console.error('Usage: node scripts/package-web.mjs <Unity-Web-build-directory> [optional-StreamingAssets-file ...]'); process.exitCode = 1; }
  else try {
    const result = await packageWebBuild(directory, { optionalPaths });
    console.log(JSON.stringify({ version: result.version, files: result.files.length, requiredTransferBytes: result.requiredTransferBytes }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
