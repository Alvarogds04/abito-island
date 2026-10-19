// Adapted from Coucou src/settings/main.ts integrationsSection/INTEGRATIONS @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito: closed preference/key planners, trusted gestures, no retained secrets.
import { h } from '../views/dom.js';
import { colorDot } from '../settings/colors.js';
import { statusDot } from '../settings/parts.js';
import { pillColor } from '../core/pill-colors.js';
import { availablePills, MAX_DECLARED } from '../core/pills.js';
import { notchSection as section, notchHint as hint } from './notch.js';
import { session, trusted } from './runtime.js';
import { t } from './i18n-es.js';
const UNAVAILABLE = 'No disponible todavía';
const STORE = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
  ? 'Windows Credential Manager' : 'Secret Service (GNOME Keyring, KWallet)';
const INTEGRATIONS = [
  {id:'integration_stripe',name:'Stripe',color:'#0570DE',fields:[['stripe-api-key','Secret key','sk_live_…']]},
  {id:'integration_github',name:'GitHub',color:'#F4505E',fields:[['github-token','Token','ghp_…']],hint:'Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.'},
  {id:'integration_vercel',name:'Vercel',color:'#7C5CFF',fields:[['vercel-token','Token','…']]},
  {id:'integration_n8n',name:'n8n',color:'#F29B38',fields:[['n8n-url','Instance URL','https://n8n.example.com'],['n8n-api-key','API key','…']]},
  {id:'integration_resend',name:'Resend',color:'#22C55E',fields:[['resend-api-key','API key','re_…'],['resend-from','Sender address','Abito <you@yourdomain.com>']],hint:'Sender must belong to a domain verified in Resend. It is used when you send mail from the island.'},
  {id:'integration_notion',name:'Notion',color:'#8C8C8C',fields:[['notion-api-key','Integration token','ntn_…']]},
  {id:'integration_calcom',name:'Cal.com',color:'#C9956A',fields:[['calcom-api-key','API key','cal_…']]},
  {id:'integration_spotify',name:'Spotify',color:'#1DB954',fields:[]},
  // Abito-owned (#490): not a pill. The user's own SMTP account for sending mail from the island when Resend is not set.
  {id:'mail_smtp',name:'Mail (SMTP)',color:'#8C8C8C',noPill:true,fields:[['smtp-host','Server (port 465 = TLS, otherwise STARTTLS)','smtp.example.com:587'],['smtp-user','User','you@example.com'],['smtp-password','Password','…'],['smtp-from','Sender (optional)','Abito <you@example.com>']],hint:'Used to send mail from the island when no Resend key and sender are saved. The connection is always encrypted.'},
  {id:'mail_imap',name:'Mail (IMAP)',color:'#8C8C8C',noPill:true,fields:[['imap-host','Server (TLS, port 993 by default)','imap.example.com'],['imap-user','User','you@example.com'],['imap-password','Password','…']],hint:'Your inbox in the island: unread, sender, time and preview. Abito only reads; it changes a message only when you press Mark as read. The connection is always encrypted.'},
];
export async function renderIntegrations({ invoke, V, P, C, listen, timers }: any) {
  const s = session(invoke, listen, timers), { root, call, work, watch } = s;
  root.style.setProperty('display','contents');
  const note = hint(''), list = h('div',{id:'integration-list',style:'display:flex;flex-direction:column;gap:14px'});
  let prefs: any = {}, known = false, busy = false;
  const switches = new Map<string,HTMLButtonElement>(), dots: ReturnType<typeof colorDot>[] = [];
  const refreshColors: (()=>void)[] = [];
  function refresh() {
    const cur = P.normalize(prefs);
    // Owner-approved security exception: a persistent OS keychain is not "never on disk".
    note.textContent = t('Pick up to {max} pills to show next to el personaje — {used}/{max} in use.',{max:MAX_DECLARED,used:cur.declaredPills.length})
      + ' ' + t('Keys are stored in the {store}.',{store:STORE}) + ' ' + t('Keys stay in the system keychain.');
    for(const update of refreshColors) update();
    for(const [id,sw] of switches) {
      const active = cur.declaredPills.includes(id);
      sw.classList.toggle('on',active);sw.setAttribute('aria-pressed',String(active));
      sw.disabled = !known || busy || id === cur.mainPill || (!active && cur.declaredPills.length >= MAX_DECLARED);
    }
  }
  function save(payload: any) {
    if(!known || busy || !s.alive())return;
    busy = true;refresh();
    work(()=>call('prefs_action',payload), next=>{prefs=next;},()=>{known=false;})
      .finally(()=>{busy=false;if(s.alive())refresh();});
  }
  const offered = new Set(C.available().map((p:any)=>p.id));
  const upstream = new Set(availablePills().map(p=>p.id));
  for(const def of INTEGRATIONS.filter(d=>(d as any).noPill||(offered.has(d.id)&&upstream.has(d.id)))) {
    const noPill = !!(def as any).noPill;
    const sw = trusted(h('button',{id:`declare-${def.id}`,class:'switch','aria-label':def.name})) as HTMLButtonElement;
    sw.addEventListener('click',e=>{
      if(!e.isTrusted || sw.disabled)return;
      if(!P.toggle(P.normalize(prefs),def.id))return;
      save({action:'toggle_declared_pill',id:def.id});
    });if(!noPill)switches.set(def.id,sw);
    const rows=h('div',{style:'display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0'});
    for(const [key,label,placeholder] of def.fields) {
      const supported=V.KEY_IDS.includes(key);
      // n8n-url lives in the keystore too: mask it rather than expose a stored secret.
      const input=h('input',{id:`integration-key-${key}`,type:'password',placeholder,autocomplete:'off',spellcheck:'false',style:'flex:1 1 auto;min-width:0'}) as HTMLInputElement;
      input.maxLength=2048;input.disabled=!supported;
      const dot=statusDot(false);dot.style.setProperty('background','#6b7079');
      let keyBusy=false;
      const saveBtn=trusted(h('button',{text:t('Save')})) as HTMLButtonElement;saveBtn.disabled=!supported;
      saveBtn.addEventListener('click',e=>{
        if(!e.isTrusted||!supported||keyBusy||!s.alive())return;
        const value=input.value.trim();input.value=''; // BEFORE IPC, including rejection.
        const payload=V.keyPayload(value?'set':'clear',key,value);if(!payload)return;
        keyBusy=true;saveBtn.disabled=true;
        work(()=>call('secret_action',payload),result=>{
          if(result?.present!==(payload.action==='set'))throw Error('unconfirmed');
          input.placeholder=result.present?`••••••••  ${t('(stored)')}`:placeholder;
          dot.style.setProperty('background',result.present?'#22c55e':'#f4505e');
        },()=>{dot.style.setProperty('background','#f5a524');})
          .finally(()=>{keyBusy=false;if(s.alive())saveBtn.disabled=false;});
      });
      rows.append(h('div',{class:'row'},h('label',{style:'min-width:104px',text:t(label)}),input,saveBtn,dot));
      if(!supported){input.title=saveBtn.title=UNAVAILABLE;rows.append(hint(UNAVAILABLE));}
      else work(()=>call('secret_action',V.keyPayload('present',key)),result=>{
        if(typeof result?.present!=='boolean')return;
        input.placeholder=result.present?`••••••••  ${t('(stored)')}`:placeholder;
        dot.style.setProperty('background',result.present?'#22c55e':'#f4505e');
      });
    }
    if(def.hint)rows.append(hint(t(def.hint)));
    // spotify_action is NOT reachable from settings: preserve the hint slot, not a fabricated state.
    if(def.id==='integration_spotify')rows.append(h('div',{class:'hint',style:'padding-top:5px'}));
    if(noPill){
      list.append(h('div',{id:def.id,style:'display:flex;gap:12px;align-items:flex-start'},
        h('div',{style:'display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px'},h('span',{style:'font-size:12.5px',text:def.name})),rows));
      continue;
    }
    const dot=colorDot(def,'',()=>prefs.pillColors,next=>{
      if(!known||busy)return;
      const color=next[def.id];save(color?{action:'set_pill_color',id:def.id,color}:{action:'clear_pill_color',id:def.id});
    },true);dots.push(dot);
    refreshColors.push(()=>dot.style.setProperty('background',pillColor(def.id,def.color,prefs.pillColors)));
    list.append(h('div',{id:def.id,style:'display:flex;gap:12px;align-items:flex-start'},
      h('div',{style:'display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px'},sw,dot,h('span',{style:'font-size:12.5px',text:def.name})),rows));
  }
  root.append(section(t('Integrations'),note,list),s.message);
  refresh();
  watch('prefs:state',next=>{prefs=next;known=true;refresh();});
  work(()=>call('prefs_action',{action:'view'}),next=>{prefs=next;known=true;refresh();});
  const mounted=s.finish(), dispose=mounted.dispose;
  mounted.dispose=()=>{for(const dot of dots)dot.dispose();dispose();};
  return mounted;
}
