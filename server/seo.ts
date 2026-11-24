import {aliases,business,metadata,pages,pageFromPath,publicCopy,type SiteRuntime} from '../src/site.ts';
import type {Env} from './services.ts';

const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const safeJson=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
const local=(url:URL)=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
export function configuredOrigin(env:Env):string|null {
  try{const url=new URL(String(env.SITE_ORIGIN||''));return url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash?url.origin:null}catch{return null}
}
export function runtimeConfig(request:Request,env:Env):SiteRuntime{
  const url=new URL(request.url),origin=configuredOrigin(env);
  return {origin:origin||url.origin,indexing:!!origin&&env.SEO_INDEXING_ENABLED==='true'&&url.origin===origin&&!local(url),
    analyticsId:env.ANALYTICS_ENABLED==='true'&&origin===url.origin&&/^G-[A-Z0-9]{6,20}$/.test(String(env.GOOGLE_ANALYTICS_ID||''))?String(env.GOOGLE_ANALYTICS_ID):null,
    verification:/^[A-Za-z0-9_-]{10,200}$/.test(String(env.GOOGLE_SITE_VERIFICATION||''))?String(env.GOOGLE_SITE_VERIFICATION):null};
}
export function siteRedirect(request:Request,env:Env):Response|null{
  const url=new URL(request.url),origin=configuredOrigin(env);let target=new URL(url);let changed=false;
  if(url.protocol==='http:'&&!local(url)){target.protocol='https:';changed=true}
  if(origin){const canonical=new URL(origin),bare=canonical.hostname.replace(/^www\./,'');if([bare,'www.'+bare].includes(url.hostname)&&url.origin!==origin){target=new URL(origin+url.pathname+url.search);changed=true}}
  if(!url.pathname.startsWith('/api/')){
    const clean=url.pathname.length>1?url.pathname.replace(/\/+$/,''):url.pathname;
    if(aliases[clean]||clean!==url.pathname){target.pathname=aliases[clean]||clean;changed=true}
  }
  if(!changed)return null;
  return new Response(null,{status:['GET','HEAD'].includes(request.method)?301:308,headers:{Location:target.href,'Cache-Control':'no-cache'}});
}
function publicBody(id:string):string{
  const route=pages[id as keyof typeof pages]||pages['nao-encontrada'];
  const text=id==='inicio'?publicCopy.home:id==='sobre'?publicCopy.about:id==='assinatura'?publicCopy.access:id==='nao-encontrada'?'O endereço pode ter mudado. Volte ao início ou conheça a plataforma.':route.description;
  return `<main id="conteudo" class="content-page"><h1>${escape(route.heading)}</h1><p>${escape(text)}</p>${id==='sobre'?`<p>Conteúdo educativo, sem substituir avaliação e acompanhamento individual.</p><p>Professor: ${business.teacher}. Contato: <a href="${business.whatsapp}">${business.telephone}</a> e <a href="${business.instagram}">Instagram oficial</a>.</p>`:''}<nav aria-label="Páginas da plataforma"><a href="/">Início</a> · <a href="/sobre">Sobre o Professor</a> · <a href="/assinatura">Condições de acesso</a> · <a href="/privacidade">Privacidade</a></nav></main>`;
}
export async function serveSite(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url),runtime=runtimeConfig(request,env);
  if(url.pathname==='/robots.txt')return new Response(runtime.indexing?`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /administracao\nDisallow: /minha-conta\nDisallow: /minha-lista\nDisallow: /confirmar-email\nDisallow: /tecnicas\nSitemap: ${runtime.origin}/sitemap.xml\n`:'User-agent: *\nDisallow: /\n',{headers:{'Content-Type':'text/plain; charset=utf-8'}});
  if(url.pathname==='/sitemap.xml')return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${runtime.indexing?Object.values(pages).filter(p=>p.public).map(p=>`<url><loc>${escape(runtime.origin+p.path)}</loc></url>`).join(''):''}</urlset>`,{headers:{'Content-Type':'application/xml; charset=utf-8'}});
  if(!env.ASSETS)return new Response('Execute a compilação da interface antes de publicar.',{status:503});
  if(!['GET','HEAD'].includes(request.method))return new Response('Método não permitido',{status:405,headers:{Allow:'GET, HEAD'}});
  // Assets never fall back to HTML: a missing file keeps its real 404 status.
  if(url.pathname.split('/').at(-1)?.includes('.'))return env.ASSETS.fetch(request);
  const id=pageFromPath(url.pathname),meta=metadata(id,runtime),nonce=crypto.randomUUID().replaceAll('-','');
  const template=await env.ASSETS.fetch(new Request(new URL('/index.html',url),{method:'GET'}));
  if(!template.ok)return template;
  const schema=pages[id].public?{'@context':'https://schema.org','@type':'Organization','@id':runtime.origin+'/#organizacao',name:business.name,url:runtime.origin,logo:runtime.origin+'/brand/logo.webp',telephone:business.telephone,sameAs:[business.instagram]}:null;
  const head=`<title>${escape(meta.title)}</title><meta name="description" content="${escape(meta.description)}"/><meta name="robots" content="${meta.robots}"/><link rel="canonical" href="${escape(meta.canonical)}"/><meta property="og:type" content="website"/><meta property="og:locale" content="pt_BR"/><meta property="og:site_name" content="${business.name}"/><meta property="og:title" content="${escape(meta.title)}"/><meta property="og:description" content="${escape(meta.description)}"/><meta property="og:url" content="${escape(meta.canonical)}"/><meta property="og:image" content="${escape(meta.image)}"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta property="og:image:alt" content="Biblioteca de Musculação com o Professor e a marca Logo da plataforma"/><meta name="twitter:card" content="summary_large_image"/>${runtime.verification?`<meta name="google-site-verification" content="${escape(runtime.verification)}"/>`:''}${schema?`<script type="application/ld+json" nonce="${nonce}">${safeJson(schema)}</script>`:''}<script id="site-runtime" type="application/json" nonce="${nonce}">${safeJson(runtime)}</script>`;
  const html=(await template.text()).replace(/<title>[\s\S]*?<\/title>/i,'').replace(/<meta\s+name="description"[^>]*>/i,'').replace('<!--seo-head-->',head).replace('<!--public-content-->',publicBody(id));
  return new Response(request.method==='HEAD'?null:html,{status:id==='nao-encontrada'?404:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Robots-Tag':meta.robots,'X-Content-Nonce':nonce}});
}
