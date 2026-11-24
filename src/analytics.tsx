import React,{useEffect,useRef,useState} from 'react';
import {pages,type PageId} from './site';
import {readRuntime} from './seo';
declare global {interface Window {dataLayer?:unknown[];gtag?:(...args:unknown[])=>void;[key:`ga-disable-${string}`]:boolean;}}
const key='dm-analytics-consent';
function preference(){try{const value=JSON.parse(localStorage.getItem(key)||'null');return value&&Date.now()-value.time<180*86400000?value.value:null}catch{return null}}
export function AnalyticsPreferences({page,account,ready}:{page:string;account:unknown;ready:boolean}){
  const id=readRuntime().analyticsId;
  const [choice,setChoice]=useState<string|null>(preference),[editing,setEditing]=useState(false);
  const eligible=!!pages[page as PageId]?.public&&!account&&ready;
  const preferencesRef=useRef<HTMLButtonElement>(null),bannerRef=useRef<HTMLElement>(null);
  const visible=(eligible&&!choice)||editing;
  const restoreFocus=()=>requestAnimationFrame(()=>preferencesRef.current?.focus({preventScroll:true}));
  const closeEditor=()=>{setEditing(false);restoreFocus()};
  useEffect(()=>{if(editing){const frame=requestAnimationFrame(()=>bannerRef.current?.focus({preventScroll:true}));return()=>cancelAnimationFrame(frame)}},[editing]);
  useEffect(()=>{if(!id)return;window[`ga-disable-${id}`]=choice!=='accepted'||!eligible;
    if(choice!=='accepted'||!eligible)return;
    if(!window.gtag){window.dataLayer=window.dataLayer||[];window.gtag=function(){window.dataLayer!.push(arguments)};
      window.gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});
      window.gtag('js',new Date());window.gtag('config',id,{send_page_view:false,page_location:readRuntime().origin+pages[page as PageId].path,page_referrer:'',allow_google_signals:false,allow_ad_personalization_signals:false});
      const script=document.createElement('script');script.async=true;script.src='https://www.googletagmanager.com/gtag/js?id='+id;script.id='google-analytics';document.head.append(script);
    }
    window.gtag('consent','update',{analytics_storage:'granted'});
    // No search terms, tokens, account data or query strings are sent.
    window.gtag('event','page_view',{send_to:id,page_location:readRuntime().origin+pages[page as PageId].path,page_title:pages[page as PageId].title,page_referrer:''});
  },[id,choice,page,eligible]);
  if(!id)return null;
  const choose=(value:string)=>{try{localStorage.setItem(key,JSON.stringify({value,time:Date.now()}))}catch{/* Keep this visit usable when browser storage is unavailable. */}setChoice(value);setEditing(false);restoreFocus();if(value==='rejected'){
    window[`ga-disable-${id}`]=true;window.gtag?.('consent','update',{analytics_storage:'denied'});
    for(const cookie of document.cookie.split(';')){const name=cookie.split('=')[0].trim();if(/^_ga(?:_|$)/.test(name))for(const domain of ['',location.hostname,'.'+location.hostname])document.cookie=`${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure${domain?'; Domain='+domain:''}`}
  }};
  return <><button ref={preferencesRef} className="text-button cookie-preferences" aria-expanded={Boolean(visible)} aria-controls={visible?'analytics-consent-panel':undefined} aria-describedby={choice?'analytics-consent-status':undefined} onClick={()=>setEditing(true)}>Preferências de cookies</button><span id="analytics-consent-status" className="sr-only" role="status" aria-live="polite">{choice==='accepted'?'Estatísticas permitidas.':choice==='rejected'?'Estatísticas recusadas.':''}</span>{visible&&<section ref={bannerRef} id="analytics-consent-panel" tabIndex={-1} className="cookie-banner" role="region" aria-label="Preferências de estatísticas" onKeyDown={event=>{if(event.key==='Escape'&&editing&&choice){event.preventDefault();event.stopPropagation();closeEditor()}}}><h2>Estatísticas de navegação</h2><p>Com sua permissão, usamos Google Analytics nas páginas públicas para entender as visitas. Você pode recusar e alterar sua escolha depois. <a href="/privacidade">Saiba mais</a>.</p><div><button className="button secondary" onClick={()=>choose('rejected')}>Recusar estatísticas</button><button className="button secondary" onClick={()=>choose('accepted')}>Permitir estatísticas</button>{editing&&choice&&<button className="text-button" onClick={closeEditor}>Fechar preferências</button>}</div></section>}</>;
}
