// Assemble chunked deployment inputs and decode gzip for static hosts without custom headers.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {packageWebBuild,validateRelativePath} from './package-web.mjs';
const root=path.resolve(process.argv[2]||'.'),out=path.resolve(process.argv[3]||'site');
const manifest=JSON.parse(await readFile(path.join(root,'payload.json'),'utf8'));
await mkdir(out); // Fresh output only; never delete or mutate an existing deployment.
for(const file of manifest.files) {
  validateRelativePath(file.path);
  if(file.contentEncoding && file.contentEncoding!=='gzip') throw Error('Unsupported encoding');
  const target=file.contentEncoding==='gzip'?file.path.replace(/\.gz$/,''):file.path;
  await mkdir(path.dirname(path.join(out,target)),{recursive:true});
  const encoded=createHash('sha256'),decoded=createHash('sha256');
  let decodedBytes=0;
  async function* parts() {
    for(const part of file.parts) {
      validateRelativePath(part.path);
      if(!part.path.startsWith('payload/')) throw Error('Invalid part location');
      const bytes=await readFile(path.join(root,part.path));
      if(bytes.length!==part.bytes || createHash('sha256').update(bytes).digest('hex')!==part.sha256) throw Error('Corrupt part '+part.path);
      encoded.update(bytes);yield bytes;
    }
  }
  const digest=new Transform({transform(bytes,_,next){decoded.update(bytes);decodedBytes+=bytes.length;next(null,bytes);}});
  const steps=[Readable.from(parts())];
  if(file.contentEncoding==='gzip')steps.push(createGunzip());
  await pipeline(...steps,digest,createWriteStream(path.join(out,target)));
  if(encoded.digest('hex')!==file.sha256 || 'sha256-'+decoded.digest('base64')!==file.integrity || decodedBytes!==file.responseBytes)
    throw Error('Invalid assembled file '+file.path);
}
let html=await readFile(path.join(out,'index.html'),'utf8');
for(const file of manifest.files.filter(f=>f.contentEncoding==='gzip'))html=html.replaceAll(file.path,file.path.replace(/\.gz$/,''));
await writeFile(path.join(out,'index.html'),html);
const release=await packageWebBuild(out);
if(release.totalTransferBytes>=1024**3)throw Error('Site exceeds GitHub Pages 1 GiB limit');
await writeFile(path.join(out,'.nojekyll'),'');
console.log(JSON.stringify({sourceVersion:manifest.sourceVersion,version:release.version,files:release.files.length,bytes:release.totalTransferBytes}));
