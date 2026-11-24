import {build as viteBuild} from 'vite';
import {build as bundle} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
await viteBuild();
const assets={};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2'};
async function collect(dir,base=dir){for(const entry of await readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())await collect(full,base);else{const key='/'+path.relative(base,full).replaceAll('\\','/');assets[key]={content:(await readFile(full)).toString('base64'),type:types[path.extname(full)]||'application/octet-stream'};}}}
await collect('dist/client');
await mkdir('dist/.openai',{recursive:true});await mkdir('dist/server',{recursive:true});
// hosting.json is deployment-specific and not versioned; copy it only when present.
await copyFile('.openai/hosting.json','dist/.openai/hosting.json').catch(e=>{if(e.code!=='ENOENT')throw e});
const source=`import app from './server/index.ts';
const assets=${JSON.stringify(assets)};
const assetServer={async fetch(request){const pathname=new URL(request.url).pathname;let entry=assets[pathname];if(!entry&&!pathname.split('/').at(-1).includes('.'))entry=assets['/index.html'];if(!entry)return new Response('Não encontrado',{status:404});if(!['GET','HEAD'].includes(request.method))return new Response('Método não permitido',{status:405});return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(entry.content),c=>c.charCodeAt(0)),{headers:{'Content-Type':entry.type,'Cache-Control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'}})}};
export default {fetch(request,env,ctx){return app.fetch(request,{...env,ASSETS:assetServer},ctx)},scheduled:app.scheduled};`;
await bundle({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'entry.generated.ts'},outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
console.log('React e API compilados em um Worker ESM portátil. Nenhuma credencial incluída.');
