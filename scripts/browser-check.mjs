import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const preview=spawn(process.execPath,['scripts/preview.mjs'],{env:{...process.env,PORT:'8788'},windowsHide:true,stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{preview.stdout.once('data',resolve);preview.once('error',reject);preview.once('exit',code=>reject(new Error('Preview exited '+code)))});
process.on('exit',()=>preview.kill());
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{window.__openedContacts=[];window.open=(url)=>{window.__openedContacts.push(String(url));return null};if(!sessionStorage.getItem('dm-stale-list-tested')){localStorage.setItem('dm-demo-favorites','["demo-1","demo-2"]');sessionStorage.setItem('dm-stale-list-tested','true')}});
const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const passed=[];const check=async(name,fn)=>{await fn();passed.push(name);console.log('PASS '+name)};
try{
await page.goto('http://127.0.0.1:8788',{waitUntil:'networkidle'});
await check('Banner anterior restaurado e marca original integrada ao menu',async()=>{assert.equal(await page.locator('.hero-identity').count(),0);assert.equal(await page.locator('.hero-stamp').count(),1);const logo=page.locator('.brand-visual img');assert.equal(await logo.getAttribute('src'),'/brand/logo.webp');assert.equal(await logo.evaluate(img=>img.complete&&img.naturalWidth===768&&img.naturalHeight===512),true);await page.getByRole('link',{name:'Explorar as técnicas',exact:false}).click();assert(page.url().endsWith('/tecnicas'));await page.getByRole('link',{name:'Início',exact:true}).click()});
await check('Biblioteca vazia sem vídeos ou miniaturas demonstrativas',async()=>{await page.getByText('As aulas do Professor chegam em breve.',{exact:true}).waitFor();assert.equal(await page.locator('.video-card,.thumbnail').count(),0);await page.getByText('0 técnicas disponíveis',{exact:true}).waitFor()});
await check('Professor Professor identificado e nome anterior removido',async()=>{assert((await page.locator('body').innerText()).includes('Professor'));assert(!(await page.locator('body').innerText()).includes('Fulano'));assert(!(await page.locator('body').innerText()).includes('Agachamento livre: acerte a base'))});
await check('Favoritos ilustrativos antigos não reaparecem',async()=>{assert.equal(await page.evaluate(()=>localStorage.getItem('dm-demo-favorites')),null);await page.getByRole('link',{name:'Minha lista',exact:true}).click();await page.getByText('Sua lista ainda está vazia.',{exact:true}).waitFor();assert.equal(await page.locator('.video-card').count(),0);await page.getByRole('link',{name:'Biblioteca de técnicas',exact:true}).click()});
await check('Busca e filtros mantêm estado vazio sem inventar conteúdo',async()=>{await page.getByRole('textbox',{name:'Buscar exercícios, técnicas e metodologias'}).fill('GLUTEOS');await page.getByRole('button',{name:'Filtros',exact:true}).click();await page.getByLabel('Dificuldade',{exact:true}).selectOption('Intermediário');assert.equal(await page.locator('.video-card').count(),0);await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await page.getByRole('button',{name:'Filtros',exact:true}).click()});
await check('Instagram e WhatsApp usam exatamente os contatos fornecidos',async()=>{await page.getByRole('button',{name:'Instagram oficial'}).click();await page.getByRole('button',{name:'WhatsApp oficial'}).click();assert.deepEqual(await page.evaluate(()=>window.__openedContacts),['https://www.instagram.com/seu_perfil/','https://wa.me/5511900000000'])});
await check('Biblioteca de apoio removida das páginas e do painel',async()=>{for(const route of ['biblioteca','sobre','assinatura','admin']){await page.goto('http://127.0.0.1:8788/#'+route);await page.waitForTimeout(100);assert(!/Biblioteca de apoio|Materiais de apoio|Tabelas e materiais|Materiais gerais|Tabelas de treino/i.test(await page.locator('main').innerText()))}assert.equal(await page.getByRole('button',{name:'Materiais',exact:true}).count(),0);await page.getByText('Nenhum vídeo cadastrado.',{exact:false}).waitFor()});
await check('Painel vazio impede cadastro fictício e informa duração máxima',async()=>{await page.getByRole('button',{name:'Novo vídeo',exact:true}).click();await page.getByText('Envie aulas de até 3 minutos.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Salvar dados'}).isDisabled(),true);assert.equal(await page.locator('.admin-video-card').count(),0);await page.getByRole('button',{name:'Cancelar',exact:true}).click()});
await check('Tema claro persiste após recarga',async()=>{await page.getByRole('button',{name:'Ativar tema claro'}).click();await page.reload({waitUntil:'networkidle'});assert.equal(await page.locator('html').getAttribute('data-theme'),'light');await page.getByRole('button',{name:'Ativar tema escuro'}).click()});
await check('Autenticação sem serviços continua recusada',async()=>{await page.getByRole('button',{name:'Entrar na conta',exact:true}).click();await page.getByRole('textbox',{name:'E-mail',exact:true}).fill('teste@example.com');await page.getByLabel('Senha',{exact:true}).fill('senha-forte-de-teste');await page.getByRole('button',{name:'Entrar na minha conta',exact:true}).click();await page.locator('.form-error').waitFor();await page.keyboard.press('Escape')});
await page.getByRole('link',{name:'Início',exact:true}).click();await page.reload({waitUntil:'networkidle'});await mkdir('docs/previas',{recursive:true});await page.screenshot({path:'docs/previas/desktop.png',fullPage:true,animations:'disabled'});
await page.locator('.hero').screenshot({path:'docs/previas/banner-desktop.png',animations:'disabled'});await page.locator('.brand-official').screenshot({path:'docs/previas/logo-menu.png',animations:'disabled'});
await page.getByRole('button',{name:'Ativar tema claro'}).click();await page.waitForTimeout(250);
await check('Modo claro com marca original, foco visível e contraste legível',async()=>{
  const logoStyle=await page.locator('.brand-visual img').evaluate(el=>getComputedStyle(el).filter);assert.equal(logoStyle,'none');
  const search=page.getByRole('textbox',{name:'Buscar exercícios, técnicas e metodologias'});await search.focus();
  assert.notEqual(await page.locator('.searchbox').evaluate(el=>getComputedStyle(el).boxShadow),'none');
  const ratios=await page.evaluate(()=>{
    const luminance=(rgb)=>{const c=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722};
    return ['.searchbox input','.muscle-tabs button.selected','.level-card strong','.level-card small','.empty-state h3','.empty-state p','.hero .button.primary','.sidebar-note strong','.sidebar-note p','.nav-item.active'].map(selector=>{
      const el=document.querySelector(selector);let parent=el;let bg;
      while(parent){const color=getComputedStyle(parent).backgroundColor;const values=color.match(/[\d.]+/g)?.map(Number);if(values&&(values.length===3||values[3]===1)){bg=values.slice(0,3);break}parent=parent.parentElement}
      const fg=getComputedStyle(el).color.match(/[\d.]+/g).map(Number).slice(0,3);const a=luminance(fg),b=luminance(bg);return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    });
  });for(const {selector,ratio} of ratios)assert(ratio>=4.5,`${selector}: contraste ${ratio.toFixed(2)}:1`);
  await search.blur();
});
await page.screenshot({path:'docs/previas/desktop-claro.png',fullPage:true,animations:'disabled'});
await page.locator('.hero').screenshot({path:'docs/previas/banner-desktop-claro.png',animations:'disabled'});
await check('Modo claro responsivo em 1920, 768, 360 e 320 pixels',async()=>{
  for(const width of [1920,768,360,320]){
    await page.setViewportSize({width,height:width===360?800:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Transbordamento em ${width}px`);
    assert.equal(await page.locator('.skip-link').evaluate(el=>el.getBoundingClientRect().bottom<=0),true,'Atalho de conteúdo escondido até receber foco');
    const inside=await page.locator('.hero').evaluate(el=>{const outer=el.getBoundingClientRect();return [...el.querySelectorAll('h1,p,.button.primary,.hero-meta')].every(child=>{const r=child.getBoundingClientRect();return r.left>=outer.left&&r.right<=outer.right&&r.bottom<=outer.bottom})});assert.equal(inside,true,`Banner em ${width}px`);
    if(width===360){await page.getByRole('button',{name:'Ativar tema escuro'}).click();await page.getByRole('button',{name:'Ativar tema claro'}).click()}
    await page.screenshot({path:`docs/previas/claro-${width}.png`,fullPage:true,animations:'disabled'});
  }
});
await page.setViewportSize({width:1440,height:1000});
await check('Modo claro mantém formulários e mensagens de erro legíveis',async()=>{
  await page.getByRole('button',{name:'Entrar na conta',exact:true}).click();
  await page.getByRole('textbox',{name:'E-mail',exact:true}).fill('teste@example.com');await page.getByLabel('Senha',{exact:true}).fill('senha-forte-de-teste');await page.getByRole('button',{name:'Entrar na minha conta',exact:true}).click();await page.locator('.form-error').waitFor();
  const errorRatio=await page.locator('.form-error').evaluate(el=>{const style=getComputedStyle(el);const luminance=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722};const a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)});assert(errorRatio>=4.5,`Mensagem de erro: ${errorRatio.toFixed(2)}:1`);
  await page.screenshot({path:'docs/previas/formulario-claro.png',animations:'disabled'});await page.keyboard.press('Escape');
});
await page.getByRole('button',{name:'Ativar tema escuro'}).click();
await check('Celular sem vídeos demonstrativos e sem transbordamento',async()=>{await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Abrir menu'}).click();await page.getByRole('link',{name:'Biblioteca de técnicas',exact:true}).click();await page.waitForTimeout(250);assert.equal(await page.locator('.video-card').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.getByRole('button',{name:'Ativar tema claro'}).click();await page.screenshot({path:'docs/previas/celular-claro.png',fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'Ativar tema escuro'}).click();await page.screenshot({path:'docs/previas/celular.png',fullPage:true,animations:'disabled'})});
await check('Banner restaurado e marca do menu funcionam no celular e tema claro',async()=>{await page.getByRole('button',{name:'Abrir menu'}).click();await page.waitForTimeout(250);await page.locator('.brand-official').screenshot({path:'docs/previas/logo-menu-celular.png',animations:'disabled'});await page.getByRole('link',{name:'Início',exact:true}).click();await page.waitForTimeout(250);assert.equal(await page.locator('.hero-identity').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('.hero').screenshot({path:'docs/previas/banner-celular.png',animations:'disabled'});await page.screenshot({path:'docs/previas/celular-inicio.png',fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'Ativar tema claro'}).click();await page.locator('.hero').screenshot({path:'docs/previas/banner-celular-claro.png',animations:'disabled'});await page.getByRole('button',{name:'Abrir menu'}).click();await page.waitForTimeout(250);await page.locator('.brand-official').screenshot({path:'docs/previas/logo-menu-claro.png',animations:'disabled'});await page.getByRole('link',{name:'Início',exact:true}).click();await page.getByRole('button',{name:'Ativar tema escuro'}).click()});
await check('Nenhum erro de JavaScript no navegador',async()=>assert.deepEqual(errors,[]));
await writeFile('docs/previas/browser-results.json',JSON.stringify({passed,errors,date:'2026-10-26',note:'Modo claro redesenhado, contraste mínimo de 4,5:1 nos textos e controles medidos, foco na busca e adaptação entre 320 e 1920 px. Composição do banner e modo escuro preservados. Chrome local sem integrações externas.'},null,2));console.log(JSON.stringify({tests:passed.length,errors},null,2));
}finally{await browser.close();preview.kill()}
