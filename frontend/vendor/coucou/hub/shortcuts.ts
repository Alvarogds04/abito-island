// Adapted from Coucou src/settings/main.ts shortcutsSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Desktop toggle wiring: Adapted from Coucou windows/src/settings/main.ts @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from '../views/dom.js';
import { SHORTCUTS, SHORTCUT_TEXT, ISLAND_SHORTCUTS, displayKeys, duplicates } from '../core/shortcuts.js';
import { toggle } from './ui.js';
import { notchSection as section, notchHint as hint } from './notch.js';
import { session, trusted } from './runtime.js';
import { renderRecapRows } from './recap.js';
import { t } from './i18n-es.js';
export async function renderShortcuts({invoke,V,listen,timers}:any) {
  const s=session(invoke,listen,timers),{root,call,work}=s;
  root.style.setProperty('display','contents');
  const views:Record<string,any>={toggleIsland:null,desktopToggle:null};
  let recording:string|null=null,busy=false;
  const payloadFor=(id:string,payload:any)=>id==='toggleIsland'?payload:{...payload,id};
  const list=h('div',{id:'global-shortcuts',class:'shortcut-list'}),feedback=hint('');
  function save(id:string,payload:any){
    if(busy||!views[id]||!s.alive())return;
    busy=true;recording=null;draw();
    work(()=>call('hotkey_action',payloadFor(id,payload)),next=>{views[id]=next;},()=>{views[id]=null;})
      .finally(()=>{busy=false;if(s.alive())draw();});
  }
  function draw(){
    clear(list);
    // Defaults are visible for unavailable bindings, not registered or treated as active.
    const dups=duplicates(Object.entries(views).filter(([,v])=>v?.enabled).map(([id,v])=>[id,v.combo]));
    for(const d of SHORTCUTS.filter(d=>d.ported)){
      const supported=Object.hasOwn(views,d.id),hotkey=views[d.id],known=supported&&!!hotkey;
      const enabled=supported?hotkey?.enabled===true:d.enabledByDefault;
      const keys=hotkey?hotkey.combo:d.defaultKeys;
      const sw=trusted(toggle(enabled,on=>{if(known&&!busy)save(d.id,{action:on?'enable':'disable'});}));
      (sw as HTMLButtonElement).disabled=!known||busy;sw.setAttribute('aria-label',t(SHORTCUT_TEXT[d.id]));
      const isRecording=recording===d.id;
      const keycap=trusted(h('button',{class:isRecording?'keycap recording':'keycap',text:isRecording?t('Press keys…'):displayKeys(keys)})) as HTMLButtonElement;
      keycap.disabled=!known||!enabled||busy;
      if(supported)keycap.title='Backspace: No disponible todavía';
      keycap.addEventListener('click',e=>{if(!e.isTrusted||keycap.disabled)return;recording=isRecording?null:d.id;draw();list.querySelector<HTMLButtonElement>('.recording')?.focus();});
      keycap.addEventListener('keydown',e=>{
        if(!e.isTrusted||recording!==d.id||!known||busy)return;
        e.preventDefault();const result=V.captureCombo(e);
        if(result.kind==='cancel'){recording=null;draw();}
        else if(result.kind==='combo')save(d.id,{action:'set',combo:result.text});
      });
      keycap.addEventListener('blur',()=>{if(recording===d.id){recording=null;draw();}});
      const r=h('div',{id:`shortcut-${d.id}`,class:enabled?'row shortcut':'row shortcut off'},sw,h('span',{class:'shortcut-name',text:t(SHORTCUT_TEXT[d.id])}));
      if(known&&enabled){
        if(dups.has(d.id))r.append(h('span',{class:'tag err',text:t('Used twice')}));
        else if(hotkey.status==='taken')r.append(h('span',{class:'tag warn',text:t('In use by another app')}));
        else if(hotkey.status==='invalid')r.append(h('span',{class:'tag err',text:t('Not a valid shortcut')}));
        else if(hotkey.status==='unsupported')r.append(h('span',{class:'tag',text:t('Not available')}));
        else if(hotkey.status==='permission_denied')r.append(h('span',{class:'tag warn',text:t('Not set by your desktop')}));
      }
      if(!supported){(sw as HTMLButtonElement).title=keycap.title='No disponible todavía';}
      r.append(keycap);list.append(r);
    }
    feedback.textContent=Object.values(views).some(v=>v?.status==='permission_pending')
      ? t('Asking your desktop to register the shortcuts. It may show its own window to confirm them.')
      : Object.values(views).map(hotkey=>V.generalView({hotkey}).hotkey).flatMap(view=>[view?.backendLabel,view?.note]).filter(Boolean).join(' — ');
    reset.disabled=Object.values(views).some(v=>!v)||busy;
  }
  const reset=trusted(h('button',{id:'shortcut-reset',text:t('Reset to defaults')})) as HTMLButtonElement;
  reset.addEventListener('click',e=>{
    if(!e.isTrusted||reset.disabled)return;
    busy=true;recording=null;draw();
    work(async()=>{
      for(const id of Object.keys(views))views[id]=await call('hotkey_action',payloadFor(id,{action:'reset'}));
    },()=>{},()=>{}).finally(()=>{busy=false;if(s.alive())draw();});
  });
  const island=h('div',{id:'island-shortcuts',class:'shortcut-list'});
  for(const r of ISLAND_SHORTCUTS)island.append(h('div',{class:'row shortcut'},h('span',{class:'shortcut-name',text:t(r.description)}),h('span',{class:'keycap static',text:r.keys})));
  const recap=await renderRecapRows({invoke,listen,timers});
  root.append(section(t('Shortcuts'),hint(t('Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it.')),
    h('div',{class:'subhead',text:t('From anywhere')}),list,hint('No disponible todavía'),feedback,h('div',{class:'row'},reset),h('div',{class:'subhead',text:t('In the open island')}),island),recap,s.message);
  draw();
  for(const id of Object.keys(views)){
    work(()=>call('hotkey_action',payloadFor(id,{action:'view'})),next=>{views[id]=next;draw();});
    s.watch(id==='toggleIsland'?'hotkey:state':'hotkey-desktop:state',next=>{views[id]=next;if(!recording)draw();});
  }
  const mounted=s.finish(),dispose=mounted.dispose,settled=mounted.settled;
  mounted.dispose=()=>{recording=null;recap.dispose();dispose();};
  mounted.settled=async()=>{await settled();await recap.settled();};
  return mounted;
}
