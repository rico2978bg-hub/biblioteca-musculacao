import {metadata,type SiteRuntime} from './site';
export function readRuntime():SiteRuntime{
  try{return JSON.parse(document.getElementById('site-runtime')?.textContent||'null')||{origin:location.origin,indexing:false,analyticsId:null}}catch{return {origin:location.origin,indexing:false,analyticsId:null}}
}
export function updateMetadata(page:string){
  const data=metadata(page,readRuntime());document.title=data.title;
  const meta=(key:string,value:string,property=false)=>{const attribute=property?'property':'name';let el=document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);if(!el){el=document.createElement('meta');el.setAttribute(attribute,key);document.head.append(el)}el.content=value};
  meta('description',data.description);meta('robots',data.robots);meta('og:title',data.title,true);meta('og:description',data.description,true);meta('og:url',data.canonical,true);meta('og:image',data.image,true);
  let canonical=document.head.querySelector<HTMLLinkElement>('link[rel=canonical]');if(!canonical){canonical=document.createElement('link');canonical.rel='canonical';document.head.append(canonical)}canonical.href=data.canonical;
}
