import {chromium,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const origin='http://127.0.0.1:8794';
const tags=['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'];
const ids={admin:'11111111-1111-4111-8111-111111111111',alice:'22222222-2222-4222-8222-222222222222',bob:'33333333-3333-4333-8333-333333333333',video:'44444444-4444-4444-8444-444444444444',otherVideo:'55555555-5555-4555-8555-555555555555',factor:'66666666-6666-4666-8666-666666666666',grant:'77777777-7777-4777-8777-777777777777',order:'88888888-8888-4888-8888-888888888888',otherOrder:'99999999-9999-4999-8999-999999999999'};
const taxonomies=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'muscle',name:'Glúteos',slug:'gluteos'},{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',kind:'category',name:'Execução',slug:'execucao'},{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',kind:'equipment',name:'Halteres',slug:'halteres'}];
const videos=[{id:ids.video,title:'Agachamento de teste acessível',exercise:'Agachamento',description:'Demonstração sintética para verificar a interface. Não é uma aula publicada.',difficulty:'beginner',duration_seconds:180,keywords:['glúteos'],thumbnail_url:'/brand/academia-960.webp',taxonomies,status:'ready',published:true},{id:ids.otherVideo,title:'Remada de teste acessível',exercise:'Remada',description:'Segundo conteúdo sintético do teste.',difficulty:'intermediate',duration_seconds:0,keywords:['costas'],thumbnail_url:null,taxonomies,status:'draft',published:false}];
const future=new Date(Date.now()+30*86400000).toISOString(),past=new Date(Date.now()-86400000).toISOString();
function fixtureState(){return {role:'admin',aal:'aal1',authenticated:true,analytics:false,grants:[{id:ids.grant,user_id:ids.alice,status:'active',starts_at:past,expires_at:future}],subscriptions:[{id:ids.order,user_id:ids.alice,status:'active',period_start:past,period_end:future}],orders:[{id:ids.order,user_id:ids.alice,status:'pending',amount_cents:3990,period_days:30,created_at:past},{id:ids.otherOrder,user_id:ids.alice,status:'approved',amount_cents:3990,period_days:30,created_at:past,access_until:future}]}}

const checks=[],scans=[],pageErrors=[],unexpectedRequests=[],blockedExternalRequests=[];
const preview=spawn(process.execPath,['scripts/preview.mjs'],{env:{...process.env,PORT:'8794'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser,logs='';preview.stderr.on('data',chunk=>logs+=String(chunk));
const killPreview=()=>{if(preview.exitCode===null)preview.kill()};process.on('exit',killPreview);
const focused=async locator=>expect(locator).toBeFocused({timeout:5000});
try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Prévia não iniciou: '+logs.slice(-1000))),20000);preview.stdout.on('data',chunk=>{if(String(chunk).includes('Local:')){clearTimeout(timeout);resolve()}});preview.once('error',error=>{clearTimeout(timeout);reject(error)});preview.once('exit',code=>{clearTimeout(timeout);reject(new Error('Prévia encerrou: '+code))})});
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  for(const theme of ['dark','light'])for(const width of [390,1440]){
    const context=await browser.newContext({viewport:{width,height:width===390?844:1000},isMobile:width===390,hasTouch:width===390,deviceScaleFactor:1});
    await context.addInitScript(value=>localStorage.setItem('dm-theme',JSON.stringify(value)),theme);
    const page=await context.newPage(),state=fixtureState(),calls=[];page.setDefaultTimeout(10000);
    page.on('pageerror',error=>pageErrors.push({theme,width,message:error.message}));
    await page.route('**/*',async route=>{
      try{
      const request=route.request(),url=new URL(request.url()),path=url.pathname;
      if(url.hostname==='www.googletagmanager.com')return route.fulfill({contentType:'application/javascript',body:'/* Google simulado: nenhuma coleta ou solicitação real. */'});
      if(url.origin!==origin){blockedExternalRequests.push({theme,width,url:url.origin+path});return route.abort()}
      if(path.startsWith('/api/')){
        calls.push({path,method:request.method()});let body={},status=200;
        if(path==='/api/config')body={configured:true,demo:false,contacts:{},plan:{enabled:false,name:'Plano em preparação'},banner:{enabled:false}};
        else if(path==='/api/account'){
          if(!state.authenticated){status=401;body={message:'Entre na sua conta.'}}
          else{const id=state.role==='admin'?ids.admin:ids.alice;body={user:{id,email:state.role==='admin'?'professor@example.com':'alice@example.com'},profile:{id,display_name:state.role==='admin'?'Professor':'Alice de teste',role:state.role,enabled:true},entitlement:true,favorites:[],aal:state.aal,factors:[],grants:state.grants.filter(g=>g.user_id===id),subscriptions:state.subscriptions.filter(s=>s.user_id===id),orders:state.orders.filter(o=>o.user_id===id)}}
        }
        else if(path==='/api/catalog')body={items:videos.filter(v=>v.published),next_cursor:null};
        else if(path==='/api/admin/videos')body={items:videos.map(v=>({...v,video_taxonomies:taxonomies.map(t=>({taxonomies:t}))})),next_cursor:null};
        else if(path==='/api/admin/taxonomies')body={items:taxonomies};
        else if(path==='/api/admin/users')body={items:[{id:ids.alice,display_name:'Alice de teste',email:'alice@example.com',enabled:true},{id:ids.bob,display_name:'Bruno de teste',email:'bruno@example.com',enabled:true}],next_page:null};
        else if(path==='/api/admin/access-records'){const kind=url.searchParams.get('kind');body={items:kind==='memberships'?state.grants:kind==='subscriptions'?state.subscriptions:state.orders,next_cursor:null}}
        else if(path==='/api/admin/settings')body={public:{instagram_url:'https://www.instagram.com/seu_perfil/',whatsapp_number:'5511900000000',logo_url:'',banner_title:'',banner_text:'',banner_url:''}};
        else if(path==='/api/auth/mfa/enroll')body={id:ids.factor,totp:{qr_code:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/><path d="M10 10h25v25H10zm55 0h25v25H65zM10 65h25v25H10zm40-15h15v15H50zm25 25h15v15H75z" fill="black"/></svg>',secret:'JBSWY3DPEHPK3PXP'}};
        else if(path==='/api/auth/mfa/verify'){state.aal='aal2';body={verified:true}}
        else if(path==='/api/auth/confirm')body={verified:true,set_password:true};
        else if(path==='/api/auth/reset')body={message:'Senha atualizada.'};
        else if(path==='/api/admin/grants/'+ids.grant&&request.method()==='PATCH'){const change=request.postDataJSON();state.grants[0]={...state.grants[0],...change};body={updated:true}}
        else if(path==='/api/orders/'+ids.order+'/refresh'&&request.method()==='POST'){if(state.holdPayment)await new Promise(resolve=>{state.releasePayment=resolve});state.orders[0]={...state.orders[0],status:'approved',access_until:future};body={refreshed:true}}
        else{status=404;body={message:'Rota não prevista pela fixture.'};unexpectedRequests.push({theme,width,path,method:request.method()})}
        return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      }
      if(state.analytics&&request.resourceType()==='document'){
        const response=await route.fetch();const body=(await response.text()).replace('"analyticsId":null','"analyticsId":"G-TESTE12345"');const headers={...response.headers()};headers['content-security-policy']=headers['content-security-policy'].replace("script-src 'self'","script-src 'self' https://www.googletagmanager.com");return route.fulfill({response,headers,body});
      }
      return route.continue();
      }catch(error){unexpectedRequests.push({theme,width,path:'fixture-handler',error:error.message});return route.abort()}
    });
    const run=async(name,operation)=>{
      let behaviorError=null,scanError=null;try{await operation()}catch(error){behaviorError=error.message}
      let violations=[],incomplete=[];
      try{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(220);const result=await new AxeBuilder({page}).withTags(tags).analyze();violations=result.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,helpUrl:v.helpUrl,nodes:v.nodes.map(n=>({target:n.target,failureSummary:n.failureSummary,checks:[...n.any,...n.all,...n.none].map(check=>({id:check.id,data:check.data,message:check.message}))}))}));incomplete=result.incomplete.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}))}catch(error){scanError=error.message}
      const passed=!behaviorError&&!scanError&&violations.length===0;checks.push({theme,width,name,passed,behaviorError,scanError});scans.push({theme,width,name,violations,incomplete});console.log((passed?'PASS ':'FAIL ')+theme+' '+width+' '+name+(behaviorError?' | '+behaviorError.split('\n')[0]:'')+(violations.length?' | axe: '+violations.map(v=>v.id).join(', '):''));
    };
    const admin=async()=>{state.role='admin';state.authenticated=true;state.aal='aal2';await page.goto(origin+'/administracao',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Painel do Professor',exact:true}).waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
    const selectAdminSection=async name=>{await page.getByRole('button',{name,exact:true}).click();await expect(page.getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true')};
    try{
      await run('MFA com alternativa de configuração manual',async()=>{await page.goto(origin+'/administracao',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Configurar aplicativo autenticador',exact:true}).click();const key=page.getByLabel('Chave para configuração manual',{exact:true});await expect(key).toHaveValue('JBSWY3DPEHPK3PXP');assert.equal(await key.getAttribute('readonly'),'');await key.focus();await focused(key);await expect(page.getByLabel('Código de seis dígitos',{exact:true})).toHaveAttribute('autocomplete','one-time-code')});
      await run('Envio visível apenas no rascunho e seletores acionáveis por teclado',async()=>{
        await admin();
        const upload=page.getByLabel('Enviar vídeo da técnica: Remada de teste acessível',{exact:true});
        await expect(upload).toHaveCount(1);
        await expect(page.getByLabel('Enviar vídeo da técnica: Agachamento de teste acessível',{exact:true})).toHaveCount(0);
        const fullyVisible=await upload.evaluate(el=>{
          const action=el.closest('label').getBoundingClientRect();
          const panel=el.closest('.admin-video-card').getBoundingClientRect();
          return action.left>=panel.left && action.right<=panel.right && action.height>=44;
        });
        assert(fullyVisible,'A ação de envio deve caber na largura visível');
        const options=page.getByText('Mais ações',{exact:true}).first();
        await options.focus();
        await page.keyboard.press('Enter');
        const thumbnail=page.getByLabel('Substituir miniatura da técnica: Agachamento de teste acessível',{exact:true});
        const remove=page.getByRole('button',{name:'Excluir vídeo: Agachamento de teste acessível',exact:true});
        await expect(remove).toBeVisible();
        for(const input of [upload,thumbnail]){
          await input.focus();await focused(input);
          const event=page.waitForEvent('filechooser',{timeout:5000});
          await page.keyboard.press('Space');
          const chooser=await event;assert.equal(chooser.isMultiple(),false);await chooser.setFiles([]);
        }
        await page.keyboard.press('Escape');
        await expect(remove).toBeHidden();
        await focused(options);
        assert(!calls.some(c=>c.path.endsWith('/upload')||c.path.endsWith('/thumbnail')));
      });
      await run('Formulário de vídeo e retorno do foco ao cancelar',async()=>{await admin();const trigger=page.getByRole('button',{name:'Novo vídeo',exact:true});await trigger.click();const form=page.getByRole('form',{name:'Cadastrar técnica',exact:true});await focused(form.getByLabel('Título',{exact:true}));await form.getByRole('button',{name:'Cancelar',exact:true}).focus();await page.keyboard.press('Enter');await focused(trigger);await trigger.click();await focused(form.getByLabel('Título',{exact:true}))});
      await run('Classificações e ações identificadas',async()=>{await admin();await selectAdminSection('Categorias');await page.getByRole('button',{name:'Editar classificação: Glúteos',exact:true}).waitFor();await expect(page.getByRole('table',{name:'Classificações de conteúdo'})).toBeVisible()});
      await run('Formulário de classificação com foco e cancelamento',async()=>{await admin();await selectAdminSection('Categorias');const trigger=page.getByRole('button',{name:'Nova classificação',exact:true});await trigger.click();const form=page.getByRole('form',{name:'Classificação de conteúdo',exact:true});await focused(form.getByLabel('Nome',{exact:true}));await form.getByRole('button',{name:'Cancelar',exact:true}).click();await focused(trigger);await trigger.click();await focused(form.getByLabel('Nome',{exact:true}))});
      await run('Alunos: gratuidade independente e ações por teclado',async()=>{await admin();await selectAdminSection('Alunos');const row=page.getByRole('row').filter({hasText:'Alice de teste'});await row.waitFor();const cancel=row.getByRole('button',{name:'Cancelar matrícula de Alice de teste',exact:true});await cancel.focus();await page.keyboard.press('Enter');const reactivate=row.getByRole('button',{name:'Reativar matrícula de Alice de teste',exact:true});await reactivate.waitFor();await focused(reactivate);assert.equal(state.grants[0].status,'cancelled');assert.equal(state.subscriptions[0].status,'active');await reactivate.focus();await page.keyboard.press('Enter');await cancel.waitFor();assert.equal(state.grants[0].status,'active');await focused(cancel)});
      await run('Convite de aluno com campos nomeados e cancelamento',async()=>{await admin();await selectAdminSection('Alunos');const trigger=page.getByRole('button',{name:'Convidar aluno',exact:true});await trigger.click();const form=page.getByRole('form',{name:'Convidar aluno',exact:true});await focused(form.getByLabel('Nome',{exact:true}));await form.getByRole('button',{name:'Cancelar',exact:true}).click();await focused(trigger);await trigger.click();await focused(form.getByLabel('Nome',{exact:true}))});
      await run('Pagamentos: atualização anunciada, foco e proteção contra repetição',async()=>{state.role='user';await page.goto(origin+'/assinatura',{waitUntil:'networkidle'});const refresh=page.getByRole('button',{name:/Atualizar situação do pagamento 1,/}),refreshPath='/api/orders/'+ids.order+'/refresh',before=calls.filter(call=>call.path===refreshPath).length;state.holdPayment=true;try{await refresh.focus();await page.keyboard.press('Enter');await expect(refresh).toHaveAttribute('aria-busy','true');await expect(refresh).toHaveAttribute('aria-disabled','true');await focused(refresh);await expect.poll(()=>calls.filter(call=>call.path===refreshPath).length).toBe(before+1);await page.keyboard.press('Enter');await page.keyboard.press('Enter');assert.equal(calls.filter(call=>call.path===refreshPath).length,before+1)}finally{state.holdPayment=false;state.releasePayment?.();state.releasePayment=null}await expect(page.locator('.member-orders [role=status]')).toContainText('Pagamento 1: Pagamento confirmado.');await focused(refresh);await expect(page.locator('.payment-status').first()).toContainText('Pagamento confirmado');assert.equal(calls.filter(call=>call.path===refreshPath).length,before+1)});
      await run('Janela de vídeo bloqueado: conteúdo cabe, foco e Escape',async()=>{state.role='user';await page.goto(origin+'/tecnicas',{waitUntil:'networkidle'});const opener=page.locator('.thumbnail-open').first(),dialog=page.getByRole('dialog',{name:'Agachamento de teste acessível',exact:true});await opener.focus();await page.keyboard.press('Enter');await expect(dialog).toBeVisible();await expect.poll(()=>dialog.evaluate(el=>el===document.activeElement||el.contains(document.activeElement))).toBe(true);const inside=await dialog.locator('.player-area').evaluate(el=>{const outer=el.getBoundingClientRect();const children=[...el.querySelectorAll('.player-lock>strong,.player-lock>p,.player-lock>button,.player-lock>small')];return children.length===4&&children.every(child=>{const r=child.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=outer.left-.5&&r.right<=outer.right+.5&&r.top>=outer.top-.5&&r.bottom<=outer.bottom+.5})});assert.equal(inside,true,'Texto e botão do player bloqueado devem caber na área');assert(!calls.some(call=>call.path.startsWith('/api/watch/')));await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await focused(opener);await page.keyboard.press('Enter');await expect(dialog).toBeVisible();await expect.poll(()=>dialog.evaluate(el=>el===document.activeElement||el.contains(document.activeElement))).toBe(true)});
      await run('Redefinição: mudança de foco e divergência de senha associada',async()=>{await page.goto(origin+'/confirmar-email?token_hash=fixture-temporary&type=invite',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Confirmar e-mail',exact:true}).click();await focused(page.getByRole('heading',{name:'Defina sua senha.',exact:true}));await page.getByLabel('Nova senha',{exact:true}).fill('Senha-fixture-A123');const confirm=page.getByLabel('Confirme a senha',{exact:true});await confirm.fill('Senha-fixture-B123');await page.getByRole('button',{name:'Salvar nova senha',exact:true}).click();await focused(confirm);await expect(confirm).toHaveAttribute('aria-invalid','true');assert((await confirm.getAttribute('aria-describedby')).split(' ').includes('email-flow-error'));await expect(page.locator('#email-flow-error')).toHaveText('As senhas precisam ser iguais.');assert(!calls.some(c=>c.path==='/api/auth/reset'))});
      await run('Preferências de cookies: foco manual, recusa e Escape',async()=>{state.authenticated=false;state.analytics=true;await page.evaluate(()=>localStorage.removeItem('dm-analytics-consent'));await page.goto(origin+'/',{waitUntil:'networkidle'});const panel=page.getByRole('region',{name:'Preferências de estatísticas',exact:true}),trigger=page.getByRole('button',{name:'Preferências de cookies',exact:true});await panel.waitFor();assert.equal(await panel.evaluate(el=>el===document.activeElement||el.contains(document.activeElement)),false);await page.getByRole('button',{name:'Recusar estatísticas',exact:true}).click();await focused(trigger);await trigger.click();await focused(panel);await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);await focused(trigger);await trigger.click();await focused(panel)});
    }finally{await context.close()}
  }
}catch(error){checks.push({name:'Infraestrutura da auditoria',passed:false,behaviorError:error.message})}
finally{
  if(browser)await browser.close();killPreview();process.removeListener('exit',killPreview);
  const failed=checks.filter(check=>!check.passed);await mkdir('docs/previas',{recursive:true});
  await writeFile('docs/previas/accessibility-fixtures-results.json',JSON.stringify({date:'2026-10-28',origin,tags,excludedRules:[],note:'Auditoria automatizada e verificações de teclado com dados sintéticos. APIs e Google interceptados; nenhum fornecedor real. Não comprova compatibilidade com todos os leitores de tela, legendas ou player real.',summary:{checks:checks.length,passed:checks.length-failed.length,failed:failed.length,scans:scans.length,axeViolations:scans.reduce((sum,scan)=>sum+scan.violations.length,0)},checks,scans,pageErrors,unexpectedRequests,blockedExternalRequests},null,2));
  console.log(JSON.stringify({checks:checks.length,failed:failed.length,axeViolations:scans.reduce((sum,scan)=>sum+scan.violations.length,0),pageErrors:pageErrors.length,unexpectedRequests:unexpectedRequests.length,blockedExternalRequests:blockedExternalRequests.length}));
  if(failed.length||pageErrors.length||unexpectedRequests.length||blockedExternalRequests.length)process.exitCode=1;
}
