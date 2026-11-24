import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const baseline=process.argv.includes('--baseline');
const preview=spawn(process.execPath,['scripts/preview.mjs'],{env:{...process.env,PORT:'8793'},windowsHide:true,stdio:['ignore','pipe','pipe']});
process.on('exit',()=>preview.kill());await new Promise((resolve,reject)=>{preview.stdout.once('data',resolve);preview.once('error',reject);preview.once('exit',code=>reject(Error('Prévia encerrou: '+code)))});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const origin='http://127.0.0.1:8793',scans=[],layouts=[],checks=[],errors=[];
await mkdir('docs/previas/acessibilidade',{recursive:true});
const scan=async(page,name)=>{const r=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']).analyze();scans.push({name,violations:r.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),passes:r.passes.length});for(const v of r.violations)console.log(JSON.stringify({name,id:v.id,nodes:v.nodes.slice(0,8).map(n=>({target:n.target,summary:n.failureSummary}))}));console.log(`${r.violations.length?'FAIL':'PASS'} axe ${name}: ${r.violations.map(v=>v.id).join(', ')||'sem violações automáticas'}`)};
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name)};
try{
for(const theme of ['dark','light']){
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});await context.addInitScript(theme=>localStorage.setItem('dm-theme',JSON.stringify(theme)),theme);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'networkidle'});
 for(const width of [320,360,375,390,412,430,768,1024,1440]){
  await page.setViewportSize({width,height:width<500?844:1000});
  const layout=await page.locator('.hero').evaluate(el=>{const hero=el.getBoundingClientRect();const nodes=[...el.querySelectorAll('h1,p,.button.primary,.hero-meta')].map(child=>{const r=child.getBoundingClientRect();return {selector:child.className||child.tagName,left:r.left,right:r.right,bottom:r.bottom,inside:r.left>=hero.left&&r.right<=hero.right&&r.bottom<=hero.bottom}});return {overflow:document.documentElement.scrollWidth>innerWidth,nodes}});
  layouts.push({theme,width,...layout});if(!baseline)assert(!layout.overflow&&layout.nodes.every(n=>n.inside),`Banner ${theme} ${width}px: ${JSON.stringify(layout)}`);
  if([390,1440].includes(width)){await scan(page,`${theme} início ${width}px`);await page.screenshot({path:`docs/previas/acessibilidade/${baseline?'antes-':''}${theme}-${width}.png`,fullPage:true,animations:'disabled'})}
 }
 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/tecnicas',{waitUntil:'networkidle'});await page.locator('.filter-button').click();await scan(page,`${theme} filtros celular`);
 await page.getByRole('button',{name:'Entrar na conta',exact:true}).click();await scan(page,`${theme} entrar celular`);await page.keyboard.press('Escape');
 if(!baseline){
  await check(`Modal ${theme}: foco contido, fundo inerte e retorno`,async()=>{
   const opener=page.getByRole('button',{name:'Entrar na conta',exact:true});await opener.click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert(await dialog.evaluate(el=>el.contains(document.activeElement)));assert(await page.locator('.app-shell').evaluate(el=>el.inert));
   for(let i=0;i<16;i++){await page.keyboard.press('Tab');assert(await dialog.evaluate(el=>el.contains(document.activeElement)))}
   for(let i=0;i<8;i++){await page.keyboard.press('Shift+Tab');assert(await dialog.evaluate(el=>el.contains(document.activeElement)))}
   await page.getByRole('textbox',{name:'E-mail',exact:true}).fill('teste@example.com');assert(await dialog.evaluate(el=>el.contains(document.activeElement)));
   await page.keyboard.press('Escape');assert.equal(await page.locator('[role=dialog]').count(),0);assert(await opener.evaluate(el=>el===document.activeElement));
  });
  await check(`Menu ${theme}: teclado, Escape e isolamento do fundo`,async()=>{
   const opener=page.getByRole('button',{name:'Abrir menu',exact:true});await opener.click();assert.equal(await opener.getAttribute('aria-expanded'),'true');const menu=page.locator('#menu-principal');assert(await menu.evaluate(el=>el.contains(document.activeElement)));assert(await page.locator('.workspace').evaluate(el=>el.inert));
   for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert(await menu.evaluate(el=>el.contains(document.activeElement)))}
   await scan(page,`${theme} menu celular aberto`);await page.keyboard.press('Escape');assert.equal(await opener.getAttribute('aria-expanded'),'false');assert(await opener.evaluate(el=>el===document.activeElement));assert(await menu.evaluate(el=>el.inert));
  });
  await check(`Navegação e busca ${theme}: foco e estado selecionado`,async()=>{
   await page.getByRole('button',{name:'Abrir menu',exact:true}).click();await page.getByRole('link',{name:'Biblioteca de técnicas',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/tecnicas');await page.waitForFunction(()=>document.activeElement?.id==='conteudo');assert(await page.locator('main').evaluate(el=>el===document.activeElement));assert.equal(await page.locator('.muscle-tabs button').first().getAttribute('aria-pressed'),'true');
   await page.getByRole('textbox',{name:'Buscar exercícios, técnicas e metodologias'}).focus();assert.notEqual(await page.locator('.searchbox').evaluate(el=>getComputedStyle(el).boxShadow),'none');
  });
  for(const mode of ['signup','recover']){await page.getByRole('button',{name:'Entrar na conta',exact:true}).click();await page.getByRole('button',{name:mode==='signup'?'Criar conta':'Esqueci minha senha',exact:true}).click();await scan(page,`${theme} ${mode}`);await page.keyboard.press('Escape')}
  for(const path of ['/sobre','/assinatura','/minha-lista','/minha-conta','/administracao','/confirmar-email','/privacidade','/termos','/cancelamento','/ausente']){await page.goto(origin+path,{waitUntil:'networkidle'});await scan(page,`${theme} ${path}`);assert.equal(await page.locator('h1').count(),1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))}
  await page.goto(origin,{waitUntil:'networkidle'});
  await check(`Banner ${theme}: texto ampliado e espaçamento`,async()=>{
   await page.setViewportSize({width:320,height:844});await page.addStyleTag({content:'*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}'});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('.hero').evaluate(el=>{const h=el.getBoundingClientRect();return [...el.querySelectorAll('h1,p,.button.primary,.hero-meta')].every(child=>child.getBoundingClientRect().bottom<=h.bottom)}));await page.screenshot({path:`docs/previas/acessibilidade/${theme}-espacamento.png`,fullPage:true});
   await page.reload({waitUntil:'networkidle'});const enlarged=await page.evaluate(()=>['.hero h1','.hero p','.hero .eyebrow','.hero-meta','.hero .button'].map(selector=>selector+'{font-size:'+(parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)*2)+'px!important}').join(''));await page.addStyleTag({content:enlarged});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('.hero').evaluate(el=>{const h=el.getBoundingClientRect();return [...el.querySelectorAll('h1,p,.button.primary,.hero-meta')].every(child=>child.getBoundingClientRect().bottom<=h.bottom)}));
  });
 }
 await context.close();
}
const results={date:'2026-10-28',baseline,checks,scans,layouts,errors,note:'axe WCAG A/AA até 2.2 + boas práticas, Chrome local e verificações de teclado/layout. Não é certificação WCAG nem teste de leitor de tela real ou player externo.'};
await writeFile(`docs/previas/${baseline?'accessibility-before':'accessibility-results'}.json`,JSON.stringify(results,null,2));
if(!baseline){assert.deepEqual(errors,[]);assert.equal(scans.reduce((sum,s)=>sum+s.violations.length,0),0,'Foram detectadas violações automáticas; veja o relatório.')}console.log(JSON.stringify({scans:scans.length,checks:checks.length,layoutProblems:layouts.filter(l=>l.overflow||l.nodes.some(n=>!n.inside)).map(l=>({theme:l.theme,width:l.width})),violations:scans.reduce((sum,s)=>sum+s.violations.length,0)}));
}catch(error){await writeFile('docs/previas/accessibility-progress.json',JSON.stringify({scans,layouts,checks,error:String(error)},null,2));throw error}finally{await browser.close();preview.kill()}
