import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const preview=spawn(process.execPath,['scripts/preview.mjs'],{env:{...process.env,PORT:'8792'},windowsHide:true,stdio:['ignore','pipe','pipe']});
process.on('exit',()=>preview.kill());await new Promise((resolve,reject)=>{preview.stdout.once('data',resolve);preview.once('error',reject)});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],passed=[];const origin='http://127.0.0.1:8792';page.on('pageerror',e=>errors.push(e.message));
const check=async(name,fn)=>{await fn();passed.push(name);console.log('PASS '+name)};
try{
await check('Rotas diretas e navegação entregam um H1 e metadados únicos',async()=>{
  const titles=new Set();for(const path of ['/','/sobre','/assinatura','/tecnicas','/tecnicas/iniciante','/tecnicas/intermediarias','/tecnicas/avancadas','/minha-lista','/minha-conta','/administracao','/confirmar-email','/privacidade','/termos','/cancelamento']){
    const response=await page.goto(origin+path,{waitUntil:'networkidle'});assert.equal(response.status(),200);assert.equal(await page.locator('h1').count(),1,path);
    titles.add(await page.title());assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'),origin+path);assert((await page.locator('meta[name=description]').getAttribute('content')).length>35);
    assert.equal(await page.locator('meta[property="og:title"]').getAttribute('content'),await page.title());
  }assert.equal(titles.size,14);
  await page.goto(origin);await page.getByRole('link',{name:'A plataforma',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/sobre');assert((await page.title()).startsWith('Sobre'));await page.goBack();assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('h1').count(),1);
});
await check('Links internos são rastreáveis e URLs antigas continuam funcionando',async()=>{
  const hrefs=await page.locator('.sidebar nav a').evaluateAll(links=>links.map(a=>a.getAttribute('href')));assert(hrefs.includes('/tecnicas'));assert(hrefs.includes('/minha-lista'));assert(hrefs.every(h=>h.startsWith('/')&&!h.includes('#')));
  await page.goto(origin+'/#biblioteca',{waitUntil:'networkidle'});assert.equal(new URL(page.url()).pathname,'/tecnicas');assert.equal(new URL(page.url()).hash,'');
});
await check('404 tem retorno útil e resposta HTTP correta',async()=>{
  const response=await page.goto(origin+'/rota-inexistente',{waitUntil:'networkidle'});assert.equal(response.status(),404);assert.equal(await page.locator('h1').count(),1);await page.getByRole('link',{name:'Voltar ao início'}).click();assert.equal(new URL(page.url()).pathname,'/');
});
await check('Imagens de apresentação são locais WebP, com alt e sem lazy no banner principal',async()=>{
  await page.goto(origin,{waitUntil:'networkidle'});const hero=page.locator('.hero-image');assert((await hero.getAttribute('src')).endsWith('.webp'));assert.equal(await hero.getAttribute('fetchpriority'),'high');assert.notEqual(await hero.getAttribute('loading'),'lazy');
  assert.equal(await page.locator('img').evaluateAll(images=>images.every(img=>img.alt.trim().length>0&&img.complete&&img.naturalWidth>0)),true);assert.equal(await page.locator('link[rel=icon]').getAttribute('href'),'/favicon.svg');
});
await check('Analytics ausente permanece desativado sem banner de cookies',async()=>{
  assert.equal(await page.locator('#google-analytics').count(),0);assert.equal(await page.getByRole('region',{name:'Preferências de estatísticas'}).count(),0);
});
await check('Analytics simulado respeita recusa, consentimento, rotas privadas e retirada',async()=>{
  let loads=0;await page.route('https://www.googletagmanager.com/**',async route=>{loads++;await route.fulfill({contentType:'application/javascript',body:'/* fornecedor simulado, nenhuma coleta real */'})});
  await page.route(origin+'/**',async route=>{if(route.request().resourceType()!=='document')return route.continue();const response=await route.fetch();let body=await response.text();body=body.replace('"analyticsId":null','"analyticsId":"G-TESTE12345"');const headers={...response.headers()};headers['content-security-policy']=headers['content-security-policy'].replace("script-src 'self'", "script-src 'self' https://www.googletagmanager.com");await route.fulfill({response,headers,body})});
  await page.goto(origin,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Recusar estatísticas',exact:true}).click();assert.equal(loads,0);
  await page.getByRole('button',{name:'Preferências de cookies'}).click();await page.getByRole('button',{name:'Permitir estatísticas',exact:true}).click();await page.waitForFunction(()=>!!document.getElementById('google-analytics'));await page.waitForTimeout(100);assert.equal(loads,1);
  await page.getByRole('link',{name:'A plataforma',exact:true}).click();await page.getByRole('link',{name:'Minha conta',exact:true}).click();assert.equal(await page.evaluate(()=>window['ga-disable-G-TESTE12345']),true);
  const views=await page.evaluate(()=>window.dataLayer.map(args=>Array.from(args)).filter(args=>args[0]==='event'&&args[1]==='page_view').map(args=>args[2].page_location));assert.deepEqual(views,[origin+'/',origin+'/sobre']);
  await page.getByRole('button',{name:'Preferências de cookies'}).click();await page.getByRole('button',{name:'Recusar estatísticas',exact:true}).click();assert.equal(await page.evaluate(()=>window['ga-disable-G-TESTE12345']),true);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dm-analytics-consent')).value),'rejected');
});
await check('SEO e navegação sem erros de JavaScript',async()=>assert.deepEqual(errors,[]));
await writeFile('docs/previas/seo-browser-results.json',JSON.stringify({date:'2026-10-26',passed,errors,note:'Chrome local; Analytics interceptado e sem chamadas reais ao Google.'},null,2));
}finally{await browser.close();preview.kill()}
