import React,{useEffect,useRef,useState} from 'react';
import {Settings2,Users,Video as VideoIcon,Layers,Plus,Upload,LoaderCircle,ShieldCheck,RefreshCw,ChevronDown} from 'lucide-react';
import * as tus from 'tus-js-client';
import {api} from './api';
import {optimizedThumbnail} from './images';
import {duration} from './catalog';
export function Admin({demo,account,videos,notify}:any){
 const [tab,setTab]=useState('videos'),[rows,setRows]=useState<any[]>([]),[tax,setTax]=useState<any[]>([]),[settings,setSettings]=useState<any>({}),[overview,setOverview]=useState<any>({}),[form,setForm]=useState<any>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState<number|null>(null),[error,setError]=useState(''),[factor,setFactor]=useState<any>(null),[otp,setOtp]=useState('');
 const allowed=demo||account?.profile?.role==='admin';const mfa=!demo&&account?.aal!=='aal2';
 const adminRef=useRef<HTMLElement>(null),formRef=useRef<HTMLFormElement>(null),errorRef=useRef<HTMLParagraphElement>(null),formTriggerRef=useRef<HTMLElement|null>(null);
 const restoreFormFocus=()=>requestAnimationFrame(()=>{const trigger=formTriggerRef.current;if(trigger?.isConnected)trigger.focus();else adminRef.current?.querySelector<HTMLButtonElement>('.admin-tabs button[aria-pressed="true"]')?.focus()});
 const openForm=(value:any,trigger:HTMLElement)=>{
  const disclosure=trigger.closest<HTMLDetailsElement>('.admin-more');
  formTriggerRef.current=disclosure?.querySelector('summary')||trigger;
  if(disclosure)disclosure.open=false;
  setError('');setForm(value);
 };
 const closeForm=()=>{setForm(null);restoreFormFocus()};
 useEffect(()=>{if(!form)return;const frame=requestAnimationFrame(()=>formRef.current?.querySelector<HTMLElement>('input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled)')?.focus());return()=>cancelAnimationFrame(frame)},[form]);
 useEffect(()=>{if(error)errorRef.current?.focus()},[error]);
 async function reload(){if(demo)return;setBusy(true);try{if(tab==='videos'){let cursor='';let all:any[]=[];do{const r=await api('/admin/videos'+(cursor?'?cursor='+encodeURIComponent(cursor):''));all=[...all,...r.items];setRows(all.map((v:any)=>({...v,taxonomies:v.video_taxonomies?.map((x:any)=>x.taxonomies)||[]})));cursor=r.next_cursor||''}while(cursor);const t=await api('/admin/taxonomies');setTax(t.items||[])}if(tab==='alunos'){let page=1;let users:any[]=[];do{const r=await api('/admin/users?page='+page);users=[...users,...r.items];setRows(users);page=r.next_page||0}while(page);const records:Record<string,any[]>={};for(const kind of ['memberships','subscriptions','payment_orders']){let cursor='';let all:any[]=[];do{const r=await api('/admin/access-records?kind='+kind+(cursor?'&cursor='+encodeURIComponent(cursor):''));all=[...all,...r.items];cursor=r.next_cursor||''}while(cursor);records[kind]=all}setOverview({grants:records.memberships,subscriptions:records.subscriptions,orders:records.payment_orders})}if(tab==='categorias'){const r=await api('/admin/taxonomies');setRows(r.items||[])}if(tab==='config'){const r=await api('/admin/settings');setSettings(r)}setError('')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 useEffect(()=>{setForm(null);setError('');setRows([]);if(allowed&&!mfa)reload()},[tab,allowed,mfa]);
 const action=async(task:()=>Promise<any>,message:string,refreshOnError=false)=>{setBusy(true);setError('');try{const result=await task();notify(result?.publication_error||message);const hadForm=!!form;setForm(null);await reload();if(hadForm)restoreFormFocus()}catch(e){if(refreshOnError)await reload();setError((e as Error).message)}finally{setBusy(false)}};
 if(!allowed)return <section className="content-page"><ShieldCheck/><h1>Área administrativa</h1><p>Esta área exige uma conta de administrador autorizada e autenticação em dois fatores.</p></section>;
 if(mfa)return <section className="content-page"><div className="section-kicker">SEGURANÇA DA ADMINISTRAÇÃO</div><h1>Confirme o segundo fator.</h1><p>Use seu aplicativo autenticador para entrar no painel. Guarde os meios de recuperação em local protegido.</p>{factor?.totp?.qr_code&&<img style={{background:'#fff',maxWidth:220}} src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(factor.totp.qr_code)} alt="QR code de configuração do aplicativo autenticador"/>}{typeof factor?.totp?.secret==='string'&&<div className="mfa-manual"><label>Chave para configuração manual<input readOnly value={factor.totp.secret} autoComplete="off" spellCheck={false} aria-describedby="mfa-manual-help"/></label><p id="mfa-manual-help">Se não puder ler o QR code, copie esta chave para a opção de entrada manual do seu aplicativo autenticador. Guarde-a em local protegido.</p></div>}<form className="admin-form" aria-label="Confirmar segundo fator" aria-busy={busy} aria-describedby={error?'admin-error':undefined} onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/mfa/verify','POST',{factor_id:factor?.id||account.factors?.find((f:any)=>f.status==='verified')?.id,code:otp});location.reload()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>{!account.factors?.some((f:any)=>f.status==='verified')&&!factor&&<button type="button" className="button primary" onClick={async()=>{try{setFactor(await api('/auth/mfa/enroll','POST'))}catch(e){setError((e as Error).message)}}}>Configurar aplicativo autenticador</button>}<label>Código de seis dígitos<input value={otp} onChange={e=>setOtp(e.target.value)} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" aria-describedby={error?'admin-error':undefined} required/></label><button className="button primary" disabled={busy}>Confirmar código</button>{error&&<p id="admin-error" ref={errorRef} tabIndex={-1} className="form-error" role="alert">{error}</p>}</form></section>;
 const items=demo?(tab==='videos'?videos:tab==='categorias'?[{id:'d1',kind:'muscle',name:'Glúteos'},{id:'d2',kind:'category',name:'Execução'},{id:'d3',kind:'equipment',name:'Halteres'}]:[]):rows;
 async function upload(file:File,id:string){
  setBusy(true);
  setError('');
  try{
   const metadata=await readVideoMetadata(file);
   if(metadata){
    if(metadata.duration>180)throw new Error('Selecione um vídeo de até 3 minutos.');
    if(Math.min(metadata.width,metadata.height)<720&&!window.confirm(
      'O arquivo tem '+metadata.width+' × '+metadata.height+' pixels. Para mais nitidez, use o original da câmera em 720p ou 1080p. Deseja enviar este arquivo mesmo assim?'
    ))return;
   }
   setProgress(0);
   const authorization=await api('/admin/videos/'+id+'/upload','POST');
   await new Promise<void>((resolve,reject)=>{
    const upload=new tus.Upload(file,{
     endpoint:authorization.endpoint,retryDelays:[0,1500,3000,5000],chunkSize:10*1024*1024,
     headers:{AuthorizationSignature:authorization.signature,AuthorizationExpire:String(authorization.expirationTime),VideoId:authorization.videoId,LibraryId:String(authorization.libraryId)},
     metadata:{filetype:file.type,title:file.name},onError:reject,
     onProgress:(sent,total)=>setProgress(Math.round(sent/total*100)),onSuccess:()=>resolve(),
    });
    upload.start();
   });
   notify('Envio concluído. O vídeo está em processamento. Use Atualizar processamento para consultar.');
   await reload();
  }catch(e){setError((e as Error).message)}
  finally{setBusy(false);setProgress(null)}
 }
 function removeVideo(video:{id:string;title:string;deleted_at?:string}){
  if(!video.deleted_at&&!window.confirm('Excluir “'+video.title+'” definitivamente? O vídeo sai da biblioteca e o arquivo enviado ao Bunny é apagado.'))return;
  void action(()=>api('/admin/videos/'+video.id,'DELETE'),'Vídeo excluído.',true);
 }
 const section=adminSections.find(item=>item.id===tab)!;
 const publishedCount=tab==='videos'?items.filter((v:any)=>v.published).length:0;
 const changePublication=(v:any)=>action(()=>api('/admin/videos/'+v.id+'/publish','POST',{published:!v.published}),v.published?'Vídeo retirado da biblioteca.':'Vídeo publicado.');
 const refreshVideo=(v:any)=>action(()=>api('/admin/videos/'+v.id+'/refresh','POST'),'Processamento atualizado.');
 const changeThumbnail=(v:any,file:File)=>action(async()=>{
  const data=new FormData();
  data.set('file',await optimizedThumbnail(file));
  return api('/admin/videos/'+v.id+'/thumbnail','POST',data);
 },'Miniatura salva.');

 return <section className="content-page admin-page" ref={adminRef}>
 <header className="admin-heading">
  <div><div className="section-kicker">BIBLIOTECA DE MUSCULAÇÃO</div><h1>Painel do Professor</h1></div>
 </header>
 {demo&&<div className="notice"><Settings2 size={20}/><p>Prévia do painel. Entre como administrador para gerenciar vídeos e alunos.</p></div>}
 <div className="admin-tabs" role="group" aria-label="Seções da administração">
  {adminSections.map(({id,label,icon:Icon})=><button key={id} className={tab===id?'active':''} aria-pressed={tab===id} onClick={()=>setTab(id)}><Icon size={17}/>{label}</button>)}
 </div>
 <div className="admin-section-heading">
  <div>
   <h2>{section.heading}</h2>
   {tab==='videos'&&items.length>0&&<p>{publishedCount} {publishedCount===1?'publicado':'publicados'} · {items.length-publishedCount} fora da biblioteca</p>}
  </div>
  {section.create&&<button className="button primary" onClick={e=>openForm({},e.currentTarget)}><Plus size={17}/>{section.create}</button>}
 </div>
 {error&&<p id="admin-error" ref={errorRef} tabIndex={-1} className="form-error" role="alert" style={{marginBottom:20}}>{error}</p>}{progress!==null&&<div className="upload-progress" role="status">Enviando vídeo: {progress}%<progress max={100} value={progress} aria-label="Progresso do envio do vídeo" aria-valuetext={progress+'% enviado'}/></div>}
 {form&&tab==='videos'&&<form className="admin-form" ref={formRef} aria-labelledby="admin-video-form-title" aria-busy={busy} aria-describedby={error?'admin-error':undefined} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const title=String(f.get('title'));if(demo){notify('O cadastro de vídeos será disponibilizado após a configuração do streaming.');return}const body={title,exercise:f.get('exercise'),description:f.get('description'),difficulty:f.get('level'),keywords:String(f.get('keywords')).split(',').map(x=>x.trim()).filter(Boolean),taxonomy_ids:f.getAll('taxonomy')};action(async()=>{const id=form.id||(await api('/admin/videos','POST',{title})).id;if(!id)throw new Error('Não foi possível identificar o vídeo.');await api('/admin/videos/'+id,'PATCH',body)},form.id?'Dados do vídeo salvos.':'Rascunho salvo. Selecione Enviar vídeo no cartão da aula.')}}><h2 id="admin-video-form-title">{form.id?'Editar técnica':'Cadastrar técnica'}</h2><p>Envie aulas de até 3 minutos. Para melhor qualidade, use o original da câmera.</p><label>Título<input name="title" defaultValue={form.title} maxLength={180} required/></label><details className="admin-form-details" open={form.id?true:undefined}><summary>Detalhes da aula</summary><div className="admin-form-detail-fields"><label>Exercício<input name="exercise" defaultValue={form.exercise} maxLength={180}/></label><label>Descrição<textarea name="description" defaultValue={form.description}/></label><div className="form-row"><label>Dificuldade<select name="level" defaultValue={demo?form.level||'Iniciante':form.difficulty||'beginner'}>{(demo?['Iniciante','Intermediário','Avançado']:['beginner','intermediate','advanced']).map((s,i)=><option key={s} value={s}>{['Iniciante','Intermediário','Avançado'][i]}</option>)}</select></label><label>Palavras-chave, separadas por vírgula<input name="keywords" defaultValue={form.keywords?.join(', ')} maxLength={1000}/></label></div>{!demo&&<fieldset><legend>Grupos, categorias e equipamentos</legend>{tax.map(t=><label className="checkbox-label" key={t.id}><input type="checkbox" name="taxonomy" value={t.id} defaultChecked={form.taxonomies?.some((x:any)=>x.id===t.id)}/>{t.name} ({t.kind})</label>)}</fieldset>}</div></details><div className="admin-inline"><button className="button primary" disabled={busy||demo}>Salvar dados</button><button type="button" className="text-button" onClick={closeForm}>Cancelar</button></div></form>}
 {form&&tab==='alunos'&&<form className="admin-form" ref={formRef} aria-labelledby="admin-student-form-title" aria-busy={busy} aria-describedby={error?'admin-error':undefined} onSubmit={e=>{e.preventDefault();if(demo){notify('Envio de convite disponível após a configuração dos serviços.');return}const f=new FormData(e.currentTarget);action(()=>api('/admin/users/invite','POST',{email:f.get('email'),display_name:f.get('display_name')}),'Convite enviado. O aluno definirá a própria senha.')}}><h2 id="admin-student-form-title">Convidar aluno</h2><label>Nome<input name="display_name" required maxLength={100}/></label><label>E-mail<input type="email" name="email" required/></label><p>O convite cria uma conta. Conceda a matrícula gratuita separadamente após localizar o aluno.</p><div className="admin-inline"><button className="button primary" disabled={busy||demo}>Enviar convite</button><button type="button" className="text-button" onClick={closeForm}>Cancelar</button></div></form>}
 {form&&tab==='categorias'&&<form className="admin-form" ref={formRef} aria-labelledby="admin-taxonomy-form-title" aria-busy={busy} aria-describedby={error?'admin-error':undefined} onSubmit={e=>{e.preventDefault();if(demo){notify('Classificações serão persistidas após a integração.');return}const f=new FormData(e.currentTarget);action(()=>api('/admin/taxonomies'+(form.id?'/'+form.id:''),form.id?'PATCH':'POST',{name:f.get('name'),kind:f.get('kind'),slug:String(f.get('name')).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}),'Classificação salva.')}}><h2 id="admin-taxonomy-form-title">Classificação de conteúdo</h2><label>Nome<input name="name" defaultValue={form.name} required maxLength={80}/></label><label>Tipo<select name="kind" defaultValue={form.kind||'muscle'}><option value="muscle">Grupo muscular</option><option value="category">Categoria ou metodologia</option><option value="equipment">Equipamento</option></select></label><div className="admin-inline"><button className="button primary" disabled={busy||demo}>Salvar classificação</button><button type="button" className="text-button" onClick={closeForm}>Cancelar</button></div></form>}
 {tab==='videos'&&<>
  {items.length===0&&!busy&&<div className="admin-empty">Nenhum vídeo cadastrado. Clique em <strong>Novo vídeo</strong> para começar.</div>}
  {items.length>0&&<ul className="admin-video-list" role="list" aria-label="Vídeos e publicação">
   {items.map((v:any)=>{
    const videoState = demo?'Ilustrativo':v.deleted_at?'Exclusão pendente':v.published?'Publicado':v.status==='ready'&&!v.thumbnail_url?'Falta miniatura':videoStates[v.status]||'Rascunho';
    const thumbnail = !demo&&v.thumbnail_storage_path&&!v.deleted_at ? '/api/admin/videos/'+v.id+'/thumbnail' : v.thumbnail_url&&!v.deleted_at?v.thumbnail_url:imagesFallback;
    const thumbnailIsNext=!demo&&!v.deleted_at&&v.status==='ready'&&!v.published&&!v.thumbnail_url;
    const thumbnailLabel=v.thumbnail_url?'Substituir miniatura':'Enviar miniatura';
    const edit=(e:React.MouseEvent<HTMLButtonElement>)=>openForm(v,e.currentTarget);
    const thumbnailAction=(primary=false)=><AdminFileAction primary={primary} label={thumbnailLabel} name={thumbnailLabel+' da técnica: '+v.title} busy={busy} accept="image/jpeg,image/png,image/webp" onFile={file=>changeThumbnail(v,file)}/>;
    return <li className="admin-video-card" key={v.id}>
     <img key={v.thumbnail_storage_path||thumbnail} src={thumbnail} alt="" loading="lazy" decoding="async" width={112} height={63}/>
     <div className="admin-video-info">
      <h3>{v.title}</h3>
      <span className="admin-video-state">{videoState}</span>
      {(v.level||videoLevels[v.difficulty]||v.duration_seconds>0)&&<p>{[v.level||videoLevels[v.difficulty],v.duration_seconds>0?duration(v.duration_seconds):''].filter(Boolean).join(' · ')}</p>}
     </div>
     <div className="admin-video-controls">
      {(demo||v.published)&&<button className="button secondary" onClick={edit} aria-label={'Editar técnica: '+v.title}>Editar</button>}
      {!demo&&v.deleted_at&&<button className="button secondary" disabled={busy} onClick={()=>removeVideo(v)}>Concluir exclusão</button>}
      {!demo&&!v.deleted_at&&!v.published&&<>
       {v.status==='draft'&&<AdminFileAction primary label="Enviar vídeo" name={'Enviar vídeo da técnica: '+v.title} busy={busy} accept="video/mp4,video/quicktime,video/webm" onFile={file=>void upload(file,v.id)}/>}
       {['processing','failed'].includes(v.status)&&<button className="button secondary" disabled={busy} onClick={()=>refreshVideo(v)} aria-label={'Atualizar processamento de: '+v.title}>Atualizar processamento</button>}
       {thumbnailIsNext&&thumbnailAction(true)}
       {v.status==='ready'&&v.thumbnail_url&&<button className="button primary" disabled={busy} aria-label={'Publicar técnica: '+v.title} onClick={()=>changePublication(v)}>Publicar</button>}
      </>}
      {!demo&&!v.deleted_at&&<details className="admin-more" name="video-actions" onKeyDown={e=>{
       if(e.key!=='Escape'||!e.currentTarget.open)return;
       e.currentTarget.open=false;
       e.currentTarget.querySelector('summary')?.focus();
      }}>
       <summary className="button secondary" aria-label={'Mais ações para '+v.title}>Mais ações <ChevronDown size={15}/></summary>
       <div className="admin-more-options">
        {!v.published&&<button className="text-button" aria-label={'Editar técnica: '+v.title} onClick={edit}>Editar</button>}
        {!thumbnailIsNext&&thumbnailAction()}
        {v.status==='processing'&&!v.published&&<AdminFileAction label="Tentar envio novamente" name={'Tentar envio novamente: '+v.title} busy={busy} accept="video/mp4,video/quicktime,video/webm" onFile={file=>void upload(file,v.id)}/>}
        {v.status==='ready'&&<button className="text-button" disabled={busy} aria-label={'Atualizar processamento de: '+v.title} onClick={()=>refreshVideo(v)}>Atualizar processamento</button>}
        {v.published&&<button className="text-button" disabled={busy} aria-label={'Despublicar técnica: '+v.title} onClick={()=>changePublication(v)}>Despublicar</button>}
        <button className="text-button admin-remove" aria-label={'Excluir vídeo: '+v.title} disabled={busy} onClick={()=>removeVideo(v)}>Excluir</button>
       </div>
      </details>}
     </div>
    </li>
   })}
  </ul>}
 </>}
 {tab==='alunos'&&<><div className="notice"><ShieldCheck size={20}/><p>Convide alunos e conceda a matrícula gratuita. O bloqueio da conta suspende também o acesso pago.</p></div>{demo?<div className="admin-empty">Nenhum dado pessoal é exibido nesta demonstração.</div>:<div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Registros administrativos. Role horizontalmente para ver todas as colunas."><table className="admin-table" aria-label="Alunos, matrículas e assinaturas"><thead><tr><th scope="col">Aluno</th><th scope="col">Matrícula gratuita</th><th scope="col">Assinatura</th><th scope="col">Conta</th></tr></thead><tbody>{items.map((u:any)=><Student key={u.id} user={u} grants={overview.grants||[]} subscriptions={overview.subscriptions||[]} action={action}/>)}</tbody></table></div>}<button className="text-button" disabled={demo||busy} onClick={()=>action(()=>api('/admin/reconcile','POST'),'Reconciliação de pagamentos executada.') }><RefreshCw size={14}/>Reconciliar pagamentos</button></>}
 {tab==='categorias'&&<div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Registros administrativos. Role horizontalmente para ver todas as colunas."><table className="admin-table" aria-label="Classificações de conteúdo"><thead><tr><th scope="col">Nome</th><th scope="col">Tipo</th><th scope="col">Ações</th></tr></thead><tbody>{items.map((t:any)=><tr key={t.id}><td>{t.name}</td><td>{{muscle:'Grupo muscular',category:'Categoria',equipment:'Equipamento'}[t.kind as 'muscle']}</td><td><button aria-label={'Editar classificação: '+t.name} onClick={e=>openForm(t,e.currentTarget)}>Editar</button>{!demo&&<button aria-label={'Remover classificação: '+t.name} onClick={()=>action(()=>api('/admin/taxonomies/'+t.id,'DELETE'),'Classificação removida.')}>Remover</button>}</td></tr>)}</tbody></table></div>}
 {tab==='config'&&<><form className="admin-form" aria-labelledby="admin-settings-title" aria-busy={busy} aria-describedby={error?'admin-error':undefined} onSubmit={e=>{e.preventDefault();if(demo){notify('Configurações demonstrativas. Conecte os serviços para salvar.');return}const f=new FormData(e.currentTarget);action(()=>api('/admin/settings','PATCH',{key:'public',value:{instagram_url:f.get('instagram_url'),whatsapp_number:f.get('whatsapp_number'),logo_url:f.get('logo_url'),banner_enabled:!!f.get('banner_alt'),banner_title:f.get('banner_alt'),banner_text:f.get('banner_text'),banner_url:f.get('banner_link')}}),'Contatos e identidade salvos. Recarregue a página para conferir.')}}><h2 id="admin-settings-title">Identidade e contatos</h2><label>Instagram oficial (https)<input name="instagram_url" type="url" defaultValue={settings.public?.instagram_url}/></label><label>WhatsApp com DDI e DDD<input name="whatsapp_number" inputMode="numeric" placeholder="5511999999999" defaultValue={settings.public?.whatsapp_number}/></label><label>URL do logotipo da plataforma<input name="logo_url" type="url" defaultValue={settings.public?.logo_url}/></label><p>Use o arquivo original em endereço HTTPS. A imagem será exibida sem distorção.</p><label>Título do banner<input name="banner_alt" defaultValue={settings.public?.banner_title}/></label><label>Texto do banner<input name="banner_text" defaultValue={settings.public?.banner_text}/></label><label>Link do banner (https, opcional)<input name="banner_link" type="url" defaultValue={settings.public?.banner_url}/></label><button className="button primary" disabled={demo||busy}>Salvar configurações</button></form><div className="notice"><ShieldCheck size={20}/><p>Preço, duração do acesso e aprovação das políticas são configurados no servidor. Credenciais privilegiadas não são editadas nem exibidas neste painel.</p></div></>}
 {busy&&progress===null&&<div className="loading-state" role="status"><LoaderCircle className="spin" size={18}/>Processando com segurança…</div>}
 </section>;
}
const adminSections=[
 {id:'videos',label:'Vídeos',heading:'Seus vídeos',icon:VideoIcon,create:'Novo vídeo'},
 {id:'alunos',label:'Alunos',heading:'Alunos e acessos',icon:Users,create:'Convidar aluno'},
 {id:'categorias',label:'Categorias',heading:'Categorias, grupos e equipamentos',icon:Layers,create:'Nova classificação'},
 {id:'config',label:'Configurações',heading:'Configurações',icon:Settings2},
];

function AdminFileAction({label,name,busy,accept,onFile,primary=false}:{label:string;name:string;busy:boolean;accept:string;onFile:(file:File)=>void;primary?:boolean}){
 return <label className={(primary?'button primary':'text-button')+' upload-control'}>
  {primary&&<Upload size={16}/>}
  {label}
  <input type="file" className="sr-only-input" accept={accept} aria-label={name} disabled={busy} onChange={e=>{
   const file=e.currentTarget.files?.[0];
   e.currentTarget.value='';
   if(file)onFile(file);
  }}/>
 </label>;
}

function readVideoMetadata(file:File):Promise<{width:number;height:number;duration:number}|undefined>{
 const video=document.createElement('video');
 const url=URL.createObjectURL(file);
 return new Promise(resolve=>{
  const finish=(metadata?:{width:number;height:number;duration:number})=>{
   window.clearTimeout(timer);
   video.onloadedmetadata=null;
   video.onerror=null;
   video.removeAttribute('src');
   video.load();
   URL.revokeObjectURL(url);
   resolve(metadata);
  };
  const timer=window.setTimeout(()=>finish(),3000);
  video.preload='metadata';
  video.onloadedmetadata=()=>finish(video.videoWidth&&video.videoHeight
   ? {width:video.videoWidth,height:video.videoHeight,duration:video.duration}
   : undefined);
  video.onerror=()=>finish();
  video.src=url;
 });
}
const imagesFallback='/brand/academia-960.webp';
const videoStates:Record<string,string>={draft:'Rascunho sem vídeo',processing:'Processando',ready:'Pronto',failed:'Falha no processamento'};
const videoLevels:Record<string,string>={beginner:'Iniciante',intermediate:'Intermediário',advanced:'Avançado'};
function Student({user:u,grants,subscriptions,action}:any){const [expires,setExpires]=useState('');const own=grants.filter((g:any)=>g.user_id===u.id);const grant=own.find((g:any)=>g.status==='active')||own[0];const grantValid=grant?.status==='active'&&(!grant.expires_at||Date.parse(grant.expires_at)>Date.now());const sub=subscriptions.find((s:any)=>s.user_id===u.id&&['active','cancelled'].includes(s.status)&&Date.parse(s.period_end)>Date.now());return <tr><td>{u.display_name||'Aluno'}<small style={{display:'block',color:'var(--muted)',fontSize:9}}>{u.email||u.id}</small></td><td>{grant?(grantValid?'Ativa':grant.status==='active'?'Expirada':'Cancelada'):'Sem concessão'}<label style={{display:'block',fontSize:9,color:'var(--muted)',marginTop:8}}>Validade opcional<input type="date" value={expires} onChange={e=>setExpires(e.target.value)} aria-label={'Validade opcional da matrícula de '+u.display_name}/></label><button aria-label={(grantValid?'Cancelar matrícula de ':grant?'Reativar matrícula de ':'Conceder gratuidade a ')+(u.display_name||u.email||'aluno')} onClick={()=>action(()=>grant?api('/admin/grants/'+grant.id,'PATCH',{status:grantValid?'cancelled':'active',expires_at:expires?new Date(expires+'T23:59:59-03:00').toISOString():null}):api('/admin/users/'+u.id+'/grants','POST',{expires_at:expires?new Date(expires+'T23:59:59-03:00').toISOString():null}),grantValid?'Matrícula gratuita cancelada. A assinatura paga foi preservada.':'Matrícula gratuita concedida ou reativada.')}>{grantValid?'Cancelar matrícula':grant?'Reativar matrícula':'Conceder gratuidade'}</button></td><td>{sub?'Válida até '+new Date(sub.period_end).toLocaleDateString('pt-BR'):'Sem assinatura ativa'}</td><td>{u.enabled?'Habilitada':'Bloqueada'}<button aria-label={(u.enabled?'Bloquear conta de ':'Reativar conta de ')+(u.display_name||u.email||'aluno')} onClick={()=>action(()=>api('/admin/users/'+u.id+'/block','PATCH',{enabled:!u.enabled}),u.enabled?'Conta bloqueada.':'Conta reativada.')}>{u.enabled?'Bloquear conta':'Reativar conta'}</button></td></tr>}
