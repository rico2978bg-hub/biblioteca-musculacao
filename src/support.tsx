import React,{useEffect,useRef,useState} from 'react';
import {ShieldCheck,LoaderCircle} from 'lucide-react';
import {api} from './api';
const statuses:Record<string,string>={pending:'Aguardando pagamento',in_process:'Em análise',approved:'Pagamento confirmado',paid:'Pagamento confirmado',rejected:'Pagamento recusado',cancelled:'Cancelado',refunded:'Reembolsado',charged_back:'Pagamento contestado',active:'Ativo',expired:'Expirado',reversed:'Revertido'};
const amount=(value:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);

export function PaymentHistory({account}:any){
 const [data,setData]=useState(account),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[pendingOrder,setPendingOrder]=useState<string|null>(null);
 const errorRef=useRef<HTMLParagraphElement>(null),refreshBusyRef=useRef(false);
 useEffect(()=>setData(account),[account]);
 useEffect(()=>{if(error)errorRef.current?.focus()},[error]);
 if(!data)return null;
 async function refresh(order:any,index:number){
  if(refreshBusyRef.current)return;
  refreshBusyRef.current=true;
  setBusy(true);setPendingOrder(order.id);setError('');setMessage('Consultando a situação do pagamento '+(index+1)+'.');
  try{await api('/orders/'+order.id+'/refresh','POST');const updated=await api('/account');setData(updated);const current=updated.orders?.find((item:any)=>item.id===order.id);setMessage('Pagamento '+(index+1)+': '+(statuses[current?.status]||'situação atualizada')+'.')}
  catch(e){setError((e as Error).message);setMessage('')}
  finally{refreshBusyRef.current=false;setBusy(false);setPendingOrder(null)}
 }
 return <section className="content-page" aria-labelledby="payment-history-title" style={{paddingTop:0,minHeight:0}}><div className="member-orders">
  <h2 id="payment-history-title">Seus pagamentos e períodos de acesso</h2>
  <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</p>
  {!(data.orders||[]).length&&<p>Nenhum pagamento registrado nesta conta.</p>}
  {(data.orders||[]).map((o:any,index:number)=><div className="payment-status" key={o.id}><div><strong>{statuses[o.status]||'Aguardando atualização'}</strong><small style={{display:'block',marginTop:5}}>{amount(o.amount_cents)} • {o.period_days} dias{o.access_until?' • Acesso até '+new Date(o.access_until).toLocaleDateString('pt-BR'):''}</small></div><button aria-disabled={busy} aria-busy={pendingOrder===o.id} aria-label={'Atualizar situação do pagamento '+(index+1)+', '+amount(o.amount_cents)+(pendingOrder===o.id?', Consultando…':'')} aria-describedby={error?'payments-error':undefined} onClick={()=>refresh(o,index)}>{pendingOrder===o.id?'Consultando…':'Atualizar situação'}</button></div>)}
  <h2 style={{marginTop:28}}>Matrículas gratuitas</h2>
  {(data.grants||[]).map((g:any)=><div className="payment-status" key={g.id}><div><strong>{g.status==='active'&&(!g.expires_at||Date.parse(g.expires_at)>Date.now())?'Matrícula ativa':g.status==='active'?'Matrícula expirada':'Matrícula cancelada'}</strong><small style={{display:'block',marginTop:5}}>{g.expires_at?'Validade até '+new Date(g.expires_at).toLocaleDateString('pt-BR'):'Sem data de vencimento cadastrada'}</small></div></div>)}
  {!(data.grants||[]).length&&<p>Nenhuma matrícula gratuita registrada. A concessão é feita pelo Professor.</p>}
  {error&&<p id="payments-error" ref={errorRef} tabIndex={-1} className="form-error" role="alert">{error}</p>}
 </div></section>;
}

export function EmailFlow({onDone}:any){
 const [verified,setVerified]=useState(false),[reset,setReset]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[mismatch,setMismatch]=useState(false);
 const titleRef=useRef<HTMLHeadingElement>(null),confirmRef=useRef<HTMLInputElement>(null),errorRef=useRef<HTMLParagraphElement>(null);
 const params=new URLSearchParams(location.search);
 useEffect(()=>{if(verified){const frame=requestAnimationFrame(()=>titleRef.current?.focus());return()=>cancelAnimationFrame(frame)}},[verified,reset]);
 useEffect(()=>{if(error){if(mismatch)confirmRef.current?.focus();else errorRef.current?.focus()}},[error,mismatch]);
 async function confirm(){
  setBusy(true);setError('');
  try{const r=await api('/auth/confirm','POST',{token_hash:params.get('token_hash'),type:params.get('type')});history.replaceState({},'','/confirmar-email');setVerified(true);setReset(r.set_password)}
  catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 const clearMismatch=()=>{if(mismatch){setMismatch(false);setError('')}};
 return <section className="content-page"><ShieldCheck size={30} color="var(--accent)" aria-hidden="true"/><div className="section-kicker" style={{marginTop:25}}>SEU ACESSO COM SEGURANÇA</div>
  <h1 ref={titleRef} tabIndex={-1}>{reset?'Defina sua senha.':verified?'E-mail confirmado.':'Confirme seu acesso.'}</h1>
  {!verified?<><p id="email-confirm-help">{params.get('token_hash')?'Continue para validar o link enviado ao seu e-mail. O link é temporário e só pode ser usado uma vez.':'Este link está incompleto. Use o endereço completo recebido por e-mail ou solicite um novo link de acesso.'}</p><button className="button primary" disabled={busy||!params.get('token_hash')} aria-busy={busy} aria-describedby={'email-confirm-help'+(error?' email-flow-error':'')} onClick={confirm}>{busy?<LoaderCircle className="spin" size={17}/>:null}Confirmar e-mail</button></>:reset?<form className="admin-form" aria-label="Definir nova senha" aria-busy={busy} aria-describedby={'reset-password-help'+(error?' email-flow-error':'')} onSubmit={async e=>{
   e.preventDefault();setError('');setMismatch(false);const f=new FormData(e.currentTarget);
   if(f.get('password')!==f.get('confirm')){setMismatch(true);setError('As senhas precisam ser iguais.');confirmRef.current?.focus();return}
   setBusy(true);try{await api('/auth/reset','POST',{password:f.get('password')});onDone()}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }}><label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={12} required aria-describedby="reset-password-help" onChange={clearMismatch}/></label><label>Confirme a senha<input ref={confirmRef} name="confirm" type="password" autoComplete="new-password" minLength={12} required aria-invalid={mismatch||undefined} aria-describedby={'reset-password-help'+(mismatch?' email-flow-error':'')} onChange={clearMismatch}/></label><p id="reset-password-help">Use pelo menos 12 caracteres. Você entrará novamente após definir a senha.</p><button className="button primary" disabled={busy} aria-busy={busy}>Salvar nova senha</button></form>:<><p>Seu e-mail foi confirmado. Para assistir, sua conta também precisa de uma assinatura ou matrícula válida.</p><button className="button primary" onClick={onDone}>Continuar para minha conta</button></>}
  {error&&<p id="email-flow-error" ref={errorRef} tabIndex={-1} className="form-error" role="alert" style={{marginTop:20}}>{error}</p>}
 </section>;
}
