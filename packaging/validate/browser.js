// Probe-only browser driver. Compiled only through src/probe.rs (feature probe).
// Trusted clicks/keys are requested from the external validator, never injected
// by the app. Native reads and DOM reads are both required for a pass.
(() => {
  if (window.AbitoValidate) return;
  const errors = [];
  addEventListener('error', e => errors.push(String(e.message)));
  addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  const original = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); original.apply(console, args); };
  let calls=Promise.resolve();
  const invoke = (command, payload) => {
    const next=calls.then(()=>new Promise(r=>setTimeout(r,120))).then(()=>window.__TAURI__.core.invoke(command,{payload}));
    calls=next.catch(()=>{}); return next;
  };
  const emit = (event, payload) => window.__TAURI__.event.emit(event, payload);
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function wait(check, description, ms = 6500) {
    const deadline = performance.now() + ms;
    let value;
    while (performance.now() < deadline) {
      value = await check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`tiempo agotado: ${description}`);
  }
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[inert]');
  async function click(el) {
    if (!el || el.disabled) throw new Error('control ausente o deshabilitado');
    el.scrollIntoView({ block: 'center', inline: 'center' }); await frame(); await frame();
    const r = el.getBoundingClientRect(), o = window.__validateOrigin;
    if (!visible(el)) throw new Error(`control no visible: ${el.id || el.className}; phase=${byId('capsule')?.dataset.phase}`);
    await emit('validate-input', { kind:'click', x:Math.round(o.x + (r.x+r.width/2)*o.scale), y:Math.round(o.y + (r.y+r.height/2)*o.scale) });
  }
  async function key(key) { await emit('validate-input', { kind:'key', key }); }
  const byId = id => document.getElementById(id);
  async function chatFirst() {
    await invoke('chat_action', {action:'check'});
    await wait(async () => (await invoke('chat_action',{action:'view'})).availability?.state === 'ready', 'modelo falso listo');
    const input = byId('chat-input');
    input.value = 'primera pregunta del validador'; input.dispatchEvent(new Event('input'));
    await wait(() => !byId('chat-send').disabled, 'Enviar habilitado');
    await click(byId('chat-send'));
    const stale = await wait(async () => { const v=await invoke('chat_action',{action:'view'}); return v.active_turn && v; }, 'turno en curso');
    const terminal = await wait(async () => { const v=await invoke('chat_action',{action:'view'}); return !v.active_turn && v.turns.some(t=>t.state==='completed' && t.reply.includes('respuesta del validador')) && v; }, 'respuesta completada', 15000);
    await wait(() => !input.disabled && byId('chat-log').textContent.includes('respuesta del validador'), 'respuesta dibujada');
    window.__validateChat = { stale, terminal };
    const cancel=byId('chat-cancel');
    const observer=new MutationObserver(records=>{
      if(records.some(r=>r.oldValue===null) || !cancel.hidden) window.__validateChat.cancel_was_shown=true;
    });
    observer.observe(cancel,{attributes:true,attributeFilter:['hidden'],attributeOldValue:true});
    window.__validateChat.observer=observer;
    const turn=stale.turns.at(-1);
    window.__validateChat.unlisten=await window.__TAURI__.event.listen('chat:state', e=>{
      const t=e.payload?.turns?.find(t=>t.turn_id===turn.turn_id);
      if(t?.seq!==turn.seq) return;
      window.__validateChat.staleObservation={composer_enabled:!input.disabled,cancel_visible:visible(byId('chat-cancel')),state:byId('chat-state').outerHTML};
    });
    return {ok:true, stale, terminal};
  }
  async function chatSecond() {
    // Rust publishes the captured in-flight snapshot AFTER completed, on the
    // same event lane as a delayed real publisher. An RPC cannot mask it here.
    await frame(); await frame();
    const {stale, terminal,staleObservation,unlisten} = window.__validateChat;
    if(unlisten) unlisten();
    window.__validateChat.observer.disconnect();
    if(window.__validateChat.cancel_was_shown) return {ok:false,reason:'snapshot tardío volvió a mostrar Cancelar (turno en curso)',staleObservation};
    if(!staleObservation) return {ok:false,reason:'no se observó la entrega del snapshot tardío'};
    if(!staleObservation.composer_enabled || staleObservation.cancel_visible) return {ok:false,reason:'snapshot tardío volvió a bloquear el compositor',staleObservation};
    const input=byId('chat-input'), state=byId('chat-state');
    if (input.disabled || state.dataset.kind === 'busy' || visible(byId('chat-cancel'))) return {ok:false,reason:'snapshot tardío volvió a bloquear el compositor',state:state.outerHTML};
    input.value='segunda pregunta en la misma conversación'; input.dispatchEvent(new Event('input'));
    if (byId('chat-send').disabled) return {ok:false,reason:'Enviar sigue bloqueado tras completed',state:state.outerHTML};
    await click(byId('chat-send'));
    const second=await wait(async()=>{const v=await invoke('chat_action',{action:'view'});return !v.active_turn && v.turns.filter(t=>t.state==='completed').length===2 && v;},'segundo turno completado',15000);
    await wait(()=>!input.disabled && !visible(byId('chat-cancel')), 'compositor libre tras segundo turno');
    return {ok:second.conversation_id===terminal.conversation_id,reason:'el segundo mensaje cambió de conversación',conversation_id:second.conversation_id,turns:second.turns,stale_seq:stale.turns.at(-1)?.seq,completed_seq:terminal.turns.at(-1)?.seq,composer_enabled:!input.disabled,staleObservation,state:state.outerHTML};
  }
  async function dictationIdle() {
    const s=await invoke('dictation_action',{action:'status'});
    const prefs=Object.fromEntries(['enabled','key','edge','mic','keepDays','cleanup','defaultStyle'].map(k=>[k,s.prefs[k]]));
    await invoke('dictation_action',{action:'set_prefs',prefs:{...prefs,enabled:true}});
    // The real pill refreshes status on open, with a five-second throttle.
    // Force that PUBLIC lifecycle after enabling, so a hidden pill with a
    // stale disabled status cannot give us a false pass.
    await invoke('desktop_action',{action:'close'});
    await new Promise(resolve=>setTimeout(resolve,5200));
    await invoke('desktop_action',{action:'expand'});
    await new Promise(resolve=>setTimeout(resolve,1000));
    await wait(()=>document.querySelector('.dpill'), 'pill montada');
    await frame(); await frame();
    const pill=document.querySelector('.dpill'), css=getComputedStyle(pill), rect=pill.getBoundingClientRect();
    return {ok:pill.hidden && css.display==='none' && rect.width===0 && rect.height===0,reason:'pill de dictado visible en idle con función habilitada',hidden:pill.hidden,display:css.display,rect:[rect.width,rect.height],phase:byId('capsule').dataset.dictation||'idle'};
  }
  async function sessions() {
    const seen=[byId('overview-view').textContent];
    // Observe actual rendered text during initial asynchronous request and at
    // least two ticker polls; even a transient unavailable message is a failure.
    const observer=new MutationObserver(()=>seen.push(byId('overview-view').textContent));
    observer.observe(byId('overview-view'),{subtree:true,childList:true,characterData:true});
    try {
      await invoke('agent_action',{action:'view'});
      let last;
      try { await wait(async()=>{await invoke('agent_action',{action:'view'});last=await invoke('agent_action',{action:'sessions_list'}); return last.connection==='connected' && Array.isArray(last.sessions?.rows);},'daemon conectado y lista de sesiones',15000); }
      catch { const unavailable=seen.some(t=>t.includes('Sesiones no disponibles')); return {ok:false,reason:unavailable ? 'ticker mostró Sesiones no disponibles con daemon conectado' : 'daemon conectado pero sessions_list no devolvió una lista (no es una lista vacía)',unavailable_seen:unavailable,last}; }
      const until=performance.now()+4500;
      while(performance.now()<until){ seen.push(byId('overview-view').textContent); await frame(); }
      const s=await invoke('agent_action',{action:'view'});
      const card=byId('overview-view');
      const rows=s.sessions?.rows || [];
      const count=card.querySelector('.who .count');
      const internal=rows.find(r=>r.tools?.total===2);
      const truthfulSteps=!!internal && internal.tools.steps.map(s=>s.name).join(',')==='read,bash' && internal.tools.steps.every(s=>s.state==='done') && count && !count.hidden && count.textContent==='2/2' && card.textContent.includes('read') && card.textContent.includes('bash');
      const external=rows.find(r=>!r.tools);
      const externalHonest=!external || window.AbitoSessionsTicker.feed(window.AbitoSessionsTicker.newMemory(),{state:'ready',rows:[external],truncated:false}).who.count==='';
      return {ok:!seen.some(t=>t.includes('Sesiones no disponibles')) && truthfulSteps && externalHonest,reason:'faltan dos herramientas reales proyectadas y contador 2/2, o se inventan pasos externos',connection:s.connection,rows:s.sessions?.rows,truthfulSteps,externalHonest,observations:seen.length,unavailable_seen:seen.some(t=>t.includes('Sesiones no disponibles')),empty_state:card.textContent};
    } finally { observer.disconnect(); }
  }
  let focusPrefs;
  async function sessionsFocus() {
    focusPrefs=await invoke('prefs_action',{action:'view'});
    const s=await invoke('agent_action',{action:'sessions_list'});
    const own=s.sessions.rows.find(r=>r.tools?.total===2);
    const beta=s.sessions.rows.find(r=>r.kind==='codex' && r.cwd==='proyecto-beta');
    if(!own || !beta) return {ok:false,reason:'faltan los dos proyectos privados',rows:s.sessions.rows};
    const who=()=>byId('overview-view').querySelector('.who .name').textContent;
    await invoke('prefs_action',{action:'set_main_pill',id:'agent_codex'});
    await wait(()=>who()==='proyecto-beta' && byId('pill-name').textContent==='proyecto-beta','principal Codex cambia tarjeta');
    const mainReadback=await invoke('prefs_action',{action:'view'});
    await invoke('desktop_action',{action:'close'});
    await wait(()=>byId('capsule').dataset.phase==='compact','barra compacta');
    await click(byId('mini-grid').querySelector(`[data-session-id="${own.id}"]`));
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>who()===own.cwd && byId('capsule').dataset.phase==='expanded' && visible(byId(`pill-choice-${beta.id}`)),'mini enfoca proyecto interno');
    const miniFocused=who();
    await click(byId(`pill-choice-${beta.id}`));
    await wait(()=>who()==='proyecto-beta','píldora enfoca segundo proyecto');
    const jump=byId('session-jump');
    await click(jump);
    await wait(()=>!jump.disabled && byId('pill-live').textContent.includes('No se pudo abrir una terminal'),'salto por clase informa ausencia de terminal');
    const count=byId('overview-view').querySelector('.who .count');
    const noFakeSteps=count.hidden && byId('overview-view').textContent.includes('Pasos de herramientas no disponibles');
    const grid=[...byId('pill-choices').children].map(n=>n.dataset.pillId);
    return {ok:mainReadback.mainPill==='agent_codex' && miniFocused===own.cwd && noFakeSteps && grid.length<=4 && !grid.includes(beta.id) && jump.getAttribute('aria-label').includes('por clase'),mainReadback:mainReadback.mainPill,miniFocused,focused:who(),grid,noFakeSteps,jump:jump.getAttribute('aria-label'),reason:'foco, principal, cuadrícula o salto por clase no coinciden'};
  }
  async function restoreSessionFocus() {
    if(focusPrefs) await invoke('prefs_action',{action:'set_main_pill',id:focusPrefs.mainPill});
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>byId('capsule').dataset.phase==='expanded' && visible(byId('overview-view')),'overview restaurado');
    return {ok:true};
  }
  async function connection(connected) {
    const word=byId('connection-word');
    const snapshot=await wait(async()=>{const s=await invoke('desktop_action',{action:'snapshot'});return (connected ? s.connections>0 : s.connections===0) && s;},'conexiones nativas Pi');
    // Do not accept the previous disconnected/connected label before its event
    // paints. Check the settled label repeatedly, not merely one early match.
    await new Promise(resolve=>setTimeout(resolve,500));
    const words=[];
    for(let i=0;i<4;i++){words.push(word.textContent);await new Promise(resolve=>setTimeout(resolve,250));}
    return {ok:words.every(w=>connected ? w!=='Sin motor' : w==='Sin motor'),reason:'etiqueta Sin motor no coincide con conexiones reales',word:word.textContent,words,connections:snapshot.connections,aria:byId('connection')?.getAttribute('aria-label')};
  }
  async function notice() {
    await wait(()=>byId('notices').textContent.includes('Validador'),'aviso Pi visible');
    return {ok:true,text:byId('notices').textContent};
  }
  async function shortcutDispatch() {
    for(const id of ['openChat','goToAlert','muteToggle','jumpToTerminal']) {
      await invoke('hotkey_action',{id,action:'disable'});
      await invoke('hotkey_action',{id,action:'enable'});
    }
    await invoke('desktop_action',{action:'hide'});
    await key('Ctrl+Alt+space');
    await wait(()=>byId('capsule').dataset.view==='chat' && visible(byId('chat-input')) && document.activeElement===byId('chat-input'),'atajo abre chat oculto con foco');
    const chat=await invoke('chat_action',{action:'view'});
    const before=await invoke('prefs_action',{action:'view'});
    await key('Ctrl+Alt+s');
    const muted=await wait(async()=>{const p=await invoke('prefs_action',{action:'view'});return p.sound!==before.sound && p;},'mute global persistido');
    await wait(()=>byId('toggle-sound').getAttribute('aria-pressed')===String(!muted.sound),'mute dibujado');
    // A second deliberate press, outside the shared X11/portal dedup window.
    await new Promise(resolve=>setTimeout(resolve,300));
    await key('Ctrl+Alt+s');
    await wait(async()=> (await invoke('prefs_action',{action:'view'})).sound===before.sound,'sonido restaurado');
    await key('Ctrl+Alt+Shift+a');
    await wait(()=>byId('notice-live').textContent==='No hay permisos ni preguntas pendientes.','alerta vacía explica que no hay solicitud');
    await key('Ctrl+Alt+t');
    await wait(()=>byId('capsule').dataset.shortcutTerminal==='focused-class','terminal confirmó foco por clase');
    return {ok:true,chat_view:chat.view,sound_before:before.sound,sound_after:muted.sound,terminal:'class-based focus_host; native X11 readback follows'};
  }
  async function shortcutTerminalAbsent() {
    await key('Ctrl+Alt+t');
    await wait(()=>byId('capsule').dataset.shortcutTerminal==='unavailable','terminal ausente no anuncia éxito');
    return {ok:!!byId('notice-live').textContent,reason:byId('notice-live').textContent};
  }
  async function shortcutAlert() {
    const before=await wait(async()=>{const v=await invoke('question_action',{action:'view'});return v.pending && v;},'request pendiente');
    await key('Ctrl+Alt+space');
    await wait(()=>byId('capsule').dataset.view==='chat','chat antes de saltar a alerta');
    await key('Ctrl+Alt+Shift+a');
    await wait(()=>byId('capsule').dataset.view==='overview' && visible(byId('question')),'alerta pendiente visible');
    const after=await invoke('question_action',{action:'view'});
    return {ok:JSON.stringify(before.pending)===JSON.stringify(after.pending),before:before.pending,after:after.pending,text:byId('question').textContent};
  }
  async function answerQuestion() {
    const button=await wait(()=>[...document.querySelectorAll('#question-options .q-option')].find(b=>visible(b) && b.textContent.includes('Validar')),'pregunta y opción de Pi');
    const text=byId('question')?.textContent || button.parentElement.textContent;
    await click(button);
    return {ok:true,text,input:'XTest sobre opción real de la isla'};
  }
  async function gear() {
    await invoke('desktop_action',{action:'expand'});
    await new Promise(resolve=>setTimeout(resolve,500));
    await click(visible(byId('open-settings')) ? byId('open-settings') : byId('open-screen-settings'));
    return {ok:true,input:'XTest sobre engranaje público'};
  }
  async function snapshot() {
    return {prefs:await invoke('prefs_action',{action:'view'}),dictation:(await invoke('dictation_action',{action:'status'})).prefs,voice:(await invoke('voice_action',{action:'status'})).prefs};
  }
  async function hub(index, page) {
    const buttons=[...document.querySelectorAll('.hub-side .hub-item')];
    if (!buttons[index]) throw new Error(`falta página ${page}`);
    const previous=document.querySelector('.hub-page');
    await click(buttons[index]);
    await wait(()=>buttons[index].classList.contains('on') && document.querySelector('.hub-page')!==previous,'página '+page);
    const root=document.querySelector('.hub-page');
    await wait(()=>root.textContent.trim().length>20 && root.querySelector('button,input,select,textarea'), 'contenido y controles '+page);
    const text=root.textContent;
    if (/No se pudieron (leer|abrir) los ajustes/.test(text)) return {ok:false,reason:'renderer de ajustes mostró su fallback de error',text};
    const controls=[...root.querySelectorAll('button,input,select,textarea')];
    const before=await snapshot();
    let effect, limitation;
    const buttonByText=t=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===t && !b.disabled);
    const assertChanged=async()=>wait(async()=>{const after=await snapshot();return JSON.stringify(before)!==JSON.stringify(after) && after;},'preferencia persistida '+page);
    if(page==='notes'||page==='phone') {
      limitation='página pública renderizada; controles de la función deshabilitados por el producto';
    } else if(page==='dictionary'||page==='snippets') {
      const fields=[...root.querySelectorAll('input,textarea')].filter(e=>!e.disabled);
      fields[0].value=page==='dictionary'?'Validador':'firma validador';
      if(page==='snippets') fields[1].value='Texto privado del validador';
      const b=buttonByText(page==='dictionary'?'Añadir':'Guardar') || buttonByText(page==='dictionary'?'Agregar':'Save') || root.querySelector('button.primary');
      await click(b);
      const action=page==='dictionary'?'words':'snippets';
      effect=await wait(async()=>{const data=await invoke('dictation_action',{action});return JSON.stringify(data).includes(page==='dictionary'?'Validador':'firma validador') && data;},'dato guardado '+page);
    } else if(page==='insights'||page==='pills') {
      const segment=root.querySelector('.hub-segmented');
      const target=segment && [...segment.querySelectorAll('button')].find(b=>!b.classList.contains('on'));
      const selected=target.textContent;
      await click(target); await wait(()=>[...document.querySelectorAll('.hub-segmented button')].some(b=>b.textContent===selected && b.classList.contains('on')),'selección de vista '+page);
      effect={selected:target.textContent,observable:'selección visual local; no cambia configuración'};
    } else if(page==='dictation') {
      const toggle=root.querySelector('.switch:not(:disabled)');
      await click(toggle); effect=await assertChanged();
    } else if(page==='voice') {
      const segment=root.querySelector('.hub-segmented');
      const target=[...segment.querySelectorAll('button')].find(b=>b.textContent.includes('texto')) || segment.querySelector('button:last-child');
      await click(target); effect=await assertChanged();
    } else if(page==='general') {
      const volume=byId('hub-volume');
      const gain=before.prefs.gain;
      await click(volume); await key('Home'); await key('Right');
      const live=await wait(async()=>{const p=await invoke('prefs_action',{action:'view'});return p.gain===.005 && p;},'volumen por teclado real');
      if(byId('hub-motion') || !root.textContent.includes('El movimiento no se puede configurar en Abito.')) throw new Error('control de movimiento inerte o explicación ausente');
      await invoke('prefs_action',{action:'set_sound_gain',gain});
      const startup=()=>byId('hub-autostart');
      await click(startup());
      await wait(async()=> (await invoke('prefs_action',{action:'autostart_view'})).enabled===true,'autoinicio instalado desde General');
      await wait(()=>startup().getAttribute('aria-pressed')==='true','autoinicio reflejado');
      await click(startup());
      await wait(async()=> (await invoke('prefs_action',{action:'autostart_view'})).enabled===false,'autoinicio retirado desde General');
      effect={liveGain:live.gain,motion:'sin interruptor inerte',autostart:'on/off mediante UI',input:'XTest sobre controles reales'};
    } else if(page==='styles'||page==='flowsettings') {
      // Keyboard navigation on a real select produces trusted change events.
      const selects=[...root.querySelectorAll('select')].filter(s=>!s.disabled && s.options.length>1);
      const select=page==='flowsettings'?selects.at(-1):selects[0];
      await click(select); await key('Down'); await key('Return'); effect=await assertChanged();
      if(page==='flowsettings') {
        await click(byId('hub-open-at-launch'));
        await wait(async()=> (await invoke('prefs_action',{action:'view'})).openSettingsAtLaunch===true,'abrir ajustes al iniciar persistido');
      }
    } else {
      const selector=page==='general'?'#hub-sound':page==='shortcuts'?'#shortcut-desktopToggle .switch':'.switch:not(:disabled)';
      const control=root.querySelector(selector);
      if(!control) throw new Error('no se encontró control seguro en '+page);
      await click(control);
      if(page==='shortcuts') effect=await wait(async()=>{const h=await invoke('hotkey_action',{action:'view',id:'desktopToggle'});return h.enabled===false && h;},'atajo desactivado');
      else effect=await assertChanged();
      if(page==='agents') {
        const instructions=byId('abito-instructions');
        if(!instructions || !root.textContent.includes('Se aplican a los próximos mensajes del chat de Abito.')) throw new Error('instrucciones con explicación falsa o ausente');
        instructions.value='Responde en español neutro.';
        await click(buttonByText('Guardar instrucciones'));
        await wait(async()=> (await invoke('prefs_action',{action:'view'})).abitoInstructions===instructions.value,'instrucciones guardadas');
        effect={...effect,instructions:'guardadas para próximos mensajes'};
      }
    }
    return {ok:true,page,controls:controls.length,text:text.slice(0,500),effect,unverifiable:limitation};
  }
  async function github() {
    await invoke('desktop_action',{action:'expand'});
    const prefs=await invoke('prefs_action',{action:'view'});
    if(!prefs.declaredPills.includes('integration_github')) await invoke('prefs_action',{action:'toggle_declared_pill',id:'integration_github'});
    const data=await invoke('github_action',{action:'refresh',section:'activity'});
    let pill;
    try {pill=await wait(()=>{const p=byId('pill-choice-integration_github');return visible(p) && p;},'pill GitHub declarada con gh falso');}
    catch {return {ok:false,reason:'GitHub devuelve datos del gh falso pero la pill declarada no aparece en la isla',data,prefs:await invoke('prefs_action',{action:'view'})};}
    await click(pill);
    const card=await wait(()=>{const c=document.querySelector('.gh-card');return visible(c) && c.textContent.includes('GitHub') && !c.textContent.includes('Cargando') && c;},'tarjeta GitHub desde gh falso');
    const text=card.textContent;
    // Leave the shared left card free for later scenes using real trusted input.
    await click(byId('pill-choice-abito'));
    await wait(()=>!visible(card),'tarjeta GitHub desenfocada');
    return {ok:data.available===true && data.activity.total===17,text,data};
  }
  async function mail() {
    const answer=await invoke('mail_action',{action:'inbox'});
    return {ok:answer.ok===false && answer.reason==='keychain_unavailable',reason:'correo no explicó la falta de keyring privado',answer,unverifiable:'IMAP/SMTP requieren claves en keyring; sin servicio de secretos privado ni credenciales del usuario'};
  }
  async function sounds() {
    const before=await invoke('sound_action',{action:'list'});
    let changed=false;
    const off=await window.__TAURI__.event.listen('sounds:changed',()=>{changed=true;});
    try {
      const reload=await invoke('sound_action',{action:'reload'});
      await wait(()=>changed,'sounds:changed tras reload');
      const after=await invoke('sound_action',{action:'list'});
      const expected=['peek','open','close','hover','blip','slap','annoyed','dizzy','greet','work','finish','error','approval','question','approve','gulp','tick','send','love','pop','proud','wink','yawn','attach','think','search','rate','sleep','greeting'];
      const catalog=window.AbitoSound.CUE_IDS;
      const context=new AudioContext();
      const decoded=[];
      try {
        for(const name of expected) {
          if(!catalog.includes('snd.'+name) || !after.names.includes(name)) throw new Error('cue ausente: '+name);
          const file=await invoke('sound_action',{action:'read',name});
          const raw=atob(file.data), bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
          await context.decodeAudioData(bytes.buffer); decoded.push(name);
        }
      } finally {await context.close();}
      return {ok:reload.ok===true && decoded.length===29,before,after,changed,decoded,audio:'decodificación privada; no afirma salida audible'};
    } finally {off();}
  }
  async function spotify() {
    const prefs=await invoke('prefs_action',{action:'view'});
    if(!prefs.declaredPills.includes('integration_spotify')) {
      if(prefs.declaredPills.length>=4) await invoke('prefs_action',{action:'toggle_declared_pill',id:prefs.declaredPills[0]});
      await invoke('prefs_action',{action:'toggle_declared_pill',id:'integration_spotify'});
    }
    const card=byId('spotify-card');
    await wait(()=>visible(card) && card.textContent.includes('Fake Song') && card.dataset.playing==='true','MPRIS falso dibujado');
    await click(card.querySelector('[data-action="play_pause"]'));
    await wait(()=>card.dataset.playing==='false','pausa reflejada');
    await click(card.querySelector('[data-action="play_pause"]'));
    await wait(()=>card.dataset.playing==='true','reproducción reflejada');
    const answer=await invoke('spotify_action',{action:'view'});
    return {ok:answer.ok && answer.state.playing && answer.state.track.title==='Fake Song',text:card.textContent,state:answer.state};
  }
  async function character(on) {
    const value=on ? await window.__TAURI__.core.invoke('character_fly_out',{anywhere:true}) : await window.__TAURI__.core.invoke('character_fly_home',{forget:true});
    const info=await window.__TAURI__.core.invoke('character_info');
    return {ok:value===true && info.onDesktop===on,info};
  }
  async function hotkeys() {
    await click(document.querySelectorAll('.hub-side .hub-item')[window.__validatePages.indexOf('shortcuts')]);
    const ids=['toggleIsland','openChat','goToAlert','jumpToTerminal','nextPill','prevPill','muteToggle','desktopToggle','wardrobeToggle'];
    const payload=(id,action)=>id==='toggleIsland'?{action}:{id,action};
    await wait(()=>ids.every(id=>byId(`shortcut-${id}`)?.querySelector('button')?.disabled===false),'nueve atajos disponibles');
    const views={};
    for(const id of ids) {
      const row=()=>byId(`shortcut-${id}`), sw=()=>row().querySelector('button');
      const before=await invoke('hotkey_action',payload(id,'view'));
      await click(sw());
      // XTest delivery and native config readback can precede the renderer's
      // rebind completion. Check the current DOM AFTER the awaited IPC, never
      // carry a pre-await "not busy" observation into the next trusted click.
      await wait(async()=>{const next=await invoke('hotkey_action',payload(id,'view'));return next.enabled!==before.enabled && sw()?.disabled===false;},`${id}: interruptor guardado`);
      await click(sw());
      await wait(async()=>{const next=await invoke('hotkey_action',payload(id,'view'));return next.enabled===before.enabled && sw()?.disabled===false;},`${id}: restaurado`);
      views[id]=await invoke('hotkey_action',payload(id,'view'));
    }
    // A rejected collision must leave BOTH configurations intact.
    let conflict=false;
    try { await invoke('hotkey_action',{id:'openChat',action:'set',combo:views.toggleIsland.combo}); }
    catch(e) { conflict=e.code==='combo_in_use'; }
    const unchanged=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await wait(()=>!byId('shortcut-reset').disabled,'reset disponible tras cambios de catálogo');
    await click(byId('shortcut-reset'));
    await wait(()=>!byId('shortcut-reset').disabled,'reset de catálogo');
    return {ok:conflict && unchanged.combo===views.openChat.combo && new Set(Object.values(views).map(v=>v.combo)).size===9,views,conflict,unchanged};
  }
  async function recordHotkey() {
    const row=()=>byId('shortcut-toggleIsland'), cap=()=>row().querySelector('.keycap');
    await wait(()=>cap() && !cap().disabled && !byId('shortcut-reset').disabled,'catálogo listo para grabar');
    const before=await invoke('hotkey_action',{action:'view'});
    const chat=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await click(cap()).catch(e=>{throw Error(`iniciar grabación: ${e.message}`);});
    await wait(()=>cap()?.classList.contains('recording'),'grabador listo tras suspender catálogo');
    const suspended=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await key('Ctrl+F8');
    await wait(async()=>!cap()?.disabled && (await invoke('hotkey_action',{action:'view'})).combo==='Ctrl+F8','nueva combinación guardada');
    const rebound=await invoke('hotkey_action',{action:'view'});
    await click(cap()).catch(e=>{throw Error(`iniciar borrado: ${e.message}`);});
    await wait(()=>cap()?.classList.contains('recording'),'grabador para borrar');
    await key('BackSpace');
    await wait(async()=>!cap()?.disabled && (await invoke('hotkey_action',{action:'view'})).combo==='','Backspace borró solo la fila elegida');
    const cleared=await invoke('hotkey_action',{action:'view'});
    const other=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await click(byId('shortcut-reset')).catch(e=>{throw Error(`reset después de borrar: ${e.message}`);});
    await wait(()=>!byId('shortcut-reset').disabled,'reset completo');
    return {ok:suspended.status!=='active' && rebound.combo==='Ctrl+F8' && !cleared.enabled && cleared.combo==='' && other.combo===chat.combo,before,suspended,rebound,cleared,other,coverage:'trusted recording/Backspace and native readback; old-combo dispatch not exercised from settings'};
  }
  async function noModel(page) {
    const index=window.__validatePages.indexOf(page);
    if(index < 0) throw Error(`página desconocida: ${page}`);
    const buttons=[...document.querySelectorAll('.hub-side .hub-item')];
    await click(buttons[index]);
    await wait(()=>document.querySelector('.hub-page')?.textContent.includes('Descargar'),`aviso de modelo ausente ${page}`);
    const status=await invoke(page==='voice'?'voice_action':'dictation_action',{action:'status'});
    const text=document.querySelector('.hub-page').textContent;
    const missing=page==='voice' ? status.vad?.state==='missing' && status.parakeet?.state==='missing' && status.listening===false : JSON.stringify(status).includes('missing');
    return {ok:missing && [...document.querySelectorAll('.hub-page button')].some(b=>b.textContent.includes('Descargar')),reason:'sin modelo no se muestra Descargar o se afirma escucha activa',status,text};
  }
  async function run(expression) {
    let result;
    try { result=await expression(); }
    catch(e) {result={ok:false,reason:typeof e==='string' ? e : (e.code ? JSON.stringify(e) : e.message || String(e))};}
    result.errors=[...errors];
    await emit('validate-result',result);
  }
  window.AbitoValidate={run,wait,click,key,visible,invoke,chatFirst,chatSecond,dictationIdle,sessions,connection,notice,shortcutDispatch,shortcutTerminalAbsent,shortcutAlert,answerQuestion,gear,hub,github,mail,sounds,spotify,character,hotkeys,recordHotkey,noModel,sessionsFocus,restoreSessionFocus};
})();
