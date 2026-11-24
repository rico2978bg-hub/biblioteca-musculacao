import {useLayoutEffect,useRef,type RefObject} from 'react';

const focusable='a[href],button,input:not([type=hidden]),select,textarea,iframe,[tabindex]';
function visibleControls(panel:HTMLElement){return [...panel.querySelectorAll<HTMLElement>(focusable)].filter(el=>!el.matches(':disabled,[hidden],[tabindex="-1"]')&&!el.closest('[inert]')&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden')}
export function focusContent(){requestAnimationFrame(()=>document.getElementById('conteudo')?.focus({preventScroll:true}))}

/** Contain keyboard/AT interaction in a dialog or compact menu, then restore focus. */
export function useFocusLayer(ref:RefObject<HTMLElement|null>,active:boolean,onClose:()=>void,backgroundSelector:string){
  const close=useRef(onClose);close.current=onClose;
  useLayoutEffect(()=>{
    const panel=ref.current;if(!active||!panel)return;
    const previous=document.activeElement as HTMLElement|null;
    const backgrounds=[...document.querySelectorAll<HTMLElement>(backgroundSelector)].map(el=>({el,inert:el.inert}));
    for(const {el} of backgrounds)el.inert=true;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';panel.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();return}
      if(event.key!=='Tab')return;
      const controls=visibleControls(panel);const first=controls[0],last=controls.at(-1);
      if(!first){event.preventDefault();panel.focus();return}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel||!panel.contains(document.activeElement))){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel||!panel.contains(document.activeElement))){event.preventDefault();first.focus()}
    };
    const contain=(event:FocusEvent)=>{if(event.target instanceof Node&&!panel.contains(event.target))panel.focus({preventScroll:true})};
    document.addEventListener('keydown',key,true);document.addEventListener('focusin',contain);
    return()=>{
      document.removeEventListener('keydown',key,true);document.removeEventListener('focusin',contain);
      for(const {el,inert} of backgrounds)el.inert=inert;
      document.body.style.overflow=overflow;
      if(previous?.isConnected&&previous.getClientRects().length&&!previous.closest('[inert]'))previous.focus({preventScroll:true});else focusContent();
    };
  },[active,backgroundSelector,ref]);
}
