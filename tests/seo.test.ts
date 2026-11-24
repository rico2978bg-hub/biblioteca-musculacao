import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleRequest} from '../server/index.ts';
import {pages} from '../src/site.ts';
import {sniffFile} from '../server/core.ts';
import {configuredOrigin} from '../server/seo.ts';
const origin='https://biblioteca.example';
const template='<!doctype html><html lang="pt-BR"><head><title>Antigo</title><meta name="description" content="Antiga"/><!--seo-head--></head><body><div id="root"><!--public-content--></div><script type="module" src="/assets/app.js"></script></body></html>';
const env={SITE_ORIGIN:origin,SEO_INDEXING_ENABLED:'true',ASSETS:{async fetch(request:Request){return new Response(new URL(request.url).pathname==='/index.html'?template:'Arquivo ausente',{status:new URL(request.url).pathname==='/index.html'?200:404})}}};

test('Cada rota entrega título, descrição, canonical e um H1 no HTML inicial',async()=>{
  const titles=new Set();for(const [id,page] of Object.entries(pages)){
    const response=await handleRequest(new Request(origin+page.path),env),html=await response.text();
    assert.equal(response.status,id==='nao-encontrada'?404:200);
    assert.equal((html.match(/<h1>/g)||[]).length,1);assert.equal((html.match(/<title>/g)||[]).length,1);
    assert(html.includes(page.title));assert(html.includes(page.description));assert(html.includes(`href="${origin+page.path}"`));titles.add(page.title);
    assert.equal(response.headers.get('X-Robots-Tag'),page.public?'index, follow':'noindex, follow');
  }assert.equal(titles.size,Object.keys(pages).length);
});
test('Prévia não indexa e não anuncia páginas no sitemap',async()=>{
  const preview={...env,SEO_INDEXING_ENABLED:'false'};
  const html=await handleRequest(new Request(origin),preview);assert.equal(html.headers.get('X-Robots-Tag'),'noindex, follow');
  assert.equal(await (await handleRequest(new Request(origin+'/robots.txt'),preview)).text(),'User-agent: *\nDisallow: /\n');
  assert(!(await (await handleRequest(new Request(origin+'/sitemap.xml'),preview)).text()).includes('<loc>'));
  const alternate=await handleRequest(new Request('https://preview.example/sitemap.xml'),env);assert(!(await alternate.text()).includes('<loc>'));
});
test('Sitemap público contém só páginas públicas e robots protege rotas privadas',async()=>{
  const xml=await (await handleRequest(new Request(origin+'/sitemap.xml'),env)).text();
  assert.equal((xml.match(/<loc>/g)||[]).length,3);for(const path of ['/sobre','/assinatura'])assert(xml.includes(origin+path));
  for(const path of ['/administracao','/minha-conta','/confirmar-email','/termos','/tecnicas'])assert(!xml.includes(path));
  const robots=await (await handleRequest(new Request(origin+'/robots.txt'),env)).text();assert(robots.includes(`Sitemap: ${origin}/sitemap.xml`));assert(robots.includes('Disallow: /api/'));
});
test('HTTP, www, barra final e aliases redirecionam sem perder caminho ou parâmetros',async()=>{
  const response=await handleRequest(new Request('http://www.biblioteca.example/sobre/?utm_source=teste'),env);
  assert.equal(response.status,301);assert.equal(response.headers.get('Location'),origin+'/sobre?utm_source=teste');
  const alias=await handleRequest(new Request(origin+'/confirm?token_hash=temporario&type=invite'),env);
  assert.equal(alias.status,301);assert.equal(alias.headers.get('Location'),origin+'/confirmar-email?token_hash=temporario&type=invite');
  const post=await handleRequest(new Request('http://biblioteca.example/api/health',{method:'POST'}),env);assert.equal(post.status,308);
});
test('Canonical e Open Graph não contêm parâmetros ou tokens; schema não inventa endereço',async()=>{
  const html=await (await handleRequest(new Request(origin+'/sobre?token_hash=segredo&utm_source=teste'),env)).text();
  assert(!html.includes('segredo'));assert(html.includes('property="og:image"'));assert(html.includes(origin+'/brand/compartilhar.png'));
  const schema=JSON.parse(html.match(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/)![1]);
  assert.equal(schema['@type'],'Organization');assert.equal(schema.name,'Biblioteca de Musculação');assert(!('address' in schema));assert.equal(schema.telephone,'+55 11 90000-0000');
});
test('404 tem status real, orientação de retorno e arquivos ausentes não viram HTML 200',async()=>{
  const response=await handleRequest(new Request(origin+'/endereco-que-nao-existe'),env);assert.equal(response.status,404);assert((await response.text()).includes('href="/"'));
  const asset=await handleRequest(new Request(origin+'/arquivo-ausente.webp'),env);assert.equal(asset.status,404);assert(!(await asset.text()).includes('<html'));
  const head=await handleRequest(new Request(origin+'/sobre',{method:'HEAD'}),env);assert.equal(head.status,200);assert.equal(await head.text(),'');
});
test('Tags do Google dependem de valores válidos e a CSP permanece restrita',async()=>{
  const config={...env,GOOGLE_SITE_VERIFICATION:'codigo_real_de_teste_123',GOOGLE_ANALYTICS_ID:'G-TESTE12345',ANALYTICS_ENABLED:'true'};
  const response=await handleRequest(new Request(origin+'/sobre'),config),html=await response.text();assert(html.includes('name="google-site-verification"'));assert(html.includes('"analyticsId":"G-TESTE12345"'));
  const csp=response.headers.get('Content-Security-Policy')!;assert(csp.includes('https://www.googletagmanager.com'));assert(csp.includes("'nonce-"));assert(!csp.includes("script-src 'self' 'unsafe-inline'"));assert(!response.headers.has('X-Content-Nonce'));
  const unconfigured=await handleRequest(new Request(origin),env);assert(!unconfigured.headers.get('Content-Security-Policy')?.includes('googletagmanager'));
  assert(!configuredOrigin({...env,SITE_ORIGIN:'https://usuario:senha@site.example'}));assert(!configuredOrigin({...env,SITE_ORIGIN:'https://site.example/caminho'}));
});
test('WebP otimizado é reconhecido; RIFF falso e SVG são recusados',async()=>{
  const webp=new Uint8Array(await readFile(new URL('../public/brand/logo.webp',import.meta.url)));assert.equal(sniffFile(webp,'thumbnail'),'image/webp');
  const falseRiff=webp.slice();falseRiff[8]=88;assert.throws(()=>sniffFile(falseRiff,'thumbnail'));
  const wrongSize=webp.slice();wrongSize[4]=0;assert.throws(()=>sniffFile(wrongSize,'thumbnail'));
  assert.throws(()=>sniffFile(new TextEncoder().encode('<svg onload="alert(1)"></svg>'),'thumbnail'));
});
