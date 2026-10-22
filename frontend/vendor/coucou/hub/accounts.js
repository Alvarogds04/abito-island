// Abito-owned migration of settings.js/accounts and models.js; rendered with MIT hub/ui.ts.
import { h, clear } from "../views/dom.js";
import { card, row, select, label } from "./ui.js";
import { notchCard } from "./notch.js";
import { action, field, note, section, status, trusted, session, preserveFocus } from "./runtime.js";
const PRESETS = [
  ["anthropic", "Anthropic", "https://api.anthropic.com/v1", "anthropic-messages"],
  ["google", "Google", "https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"],
  ["openai", "OpenAI", "https://api.openai.com/v1", "openai-completions"],
  ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openai-completions"],
  ["ollama", "Ollama (local)", "http://127.0.0.1:11434/v1", "openai-completions"],
  ["lmstudio", "LM Studio (local)", "http://127.0.0.1:1234/v1", "openai-completions"],
  ["custom", "Endpoint personalizado (HTTPS)", "", "openai-completions"]
];
async function renderAccounts({ invoke, V, listen, timers, page = "all", keys: showKeys = true }) {
  const s = session(invoke, listen, timers), { root, call, work, watch, later, message } = s;
  const agent = (p) => call("agent_action", p);
  let state = null, owned = null, form = null, generation = 0;
  let saving = false, busy = false, daemonBusy = false, login = null, pendingLogin = null;
  let filter = "", flow = null, flowKey = "", waiting = null, lastKey = "";
  const ask = { at: 0, timedOut: false };
  let keyPresence = null, keyBusy = "", keyError = "";
  const keys = h("section", {});
  const withoutError = (st) => JSON.stringify({ ...st, last_error: null });
  function apply(next) {
    if (!s.alive() || !next || typeof next !== "object") return;
    if (Object.hasOwn(next, "ownedAccounts")) owned = next.ownedAccounts === null ? null : { accounts: V.ownedAccounts(next.ownedAccounts) };
    state = { ...state, ...next };
    if (waiting) {
      const out = V.commandOutcome(waiting.before, state, waiting.say);
      if (out.ok === false) {
        message.textContent = out.say;
        waiting = null;
      } else if (withoutError(state) !== waiting.json) {
        message.textContent = waiting.say;
        waiting = null;
      }
    }
    const ready = V.pendingLoginReady(state, pendingLogin);
    if (ready && !busy) {
      pendingLogin = null;
      send({ action: "auth_start", accountId: ready.accountId, method: ready.method });
    }
    paint();
  }
  function send(payload, say = "") {
    if (busy) return;
    busy = true;
    const token = say ? { before: state, json: withoutError(state), say } : null;
    waiting = token;
    if (token) later(() => {
      if (waiting === token) {
        waiting = null;
        message.textContent = "El motor no respondió.";
      }
    }, 5e3);
    work(() => agent(payload), (next) => {
      busy = false;
      apply(next);
    }, () => {
      waiting = null;
      busy = false;
      if (login && !login.sawFlow && /^(auth_start|account_create)$/.test(payload.action)) {
        login.phase = "error";
        pendingLogin = null;
      }
      paint();
    });
  }
  function discard() {
    if (form) {
      for (const input of form.querySelectorAll("input")) if (input.type === "password") input.value = "";
    }
    form = null;
    generation++;
  }
  function accountForm(saved) {
    const f = h("form", { id: "account-form", autocomplete: "off" });
    const config = saved?.config || {};
    const add = (id, title, value = "", type = "text") => {
      const n = field(id, title, type, value);
      n.maxLength = 2048;
      f.append(row(title, null, n));
      return n;
    };
    const provider = trusted(select(PRESETS.map((p) => [p[0], p[1]]), saved?.provider || "openai", () => {
      const preset = PRESETS.find((p) => p[0] === provider.value);
      if (preset) {
        name.value = preset[1];
        url.value = preset[2];
        api.value = preset[3];
      }
      secret.value = "";
      credential.value = "keep";
      secret.disabled = true;
    }));
    provider.setAttribute("id", "account-provider");
    provider.disabled = !!saved;
    if (saved && !PRESETS.some((p) => p[0] === saved.provider)) provider.append(h("option", { value: saved.provider, text: saved.provider }));
    provider.value = saved?.provider || "openai";
    f.append(row("Proveedor", null, provider));
    const name = add("account-name", "Nombre de la cuenta", config.nombre || "OpenAI");
    name.maxLength = 80;
    const url = add("account-url", "URL base (HTTPS remota / HTTP de loopback local)", config.baseUrl || "https://api.openai.com/v1");
    const api = trusted(select(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].map((v) => [v, v]), config.api || "openai-completions", () => {
    }));
    api.setAttribute("id", "account-api");
    f.append(row("API", null, api));
    const models = add("account-models", "Modelos (separados por comas)", (config.models || []).join(", "));
    const def = add("account-default", "Modelo predeterminado de esta cuenta", config.defaultModel || "");
    def.maxLength = 200;
    const credential = trusted(select([["keep", "Conservar"], ["set", "Establecer clave"], ["clear", "Borrar clave"]], "keep", () => {
      secret.value = "";
      secret.disabled = credential.value !== "set";
    }));
    credential.setAttribute("id", "account-credential");
    f.append(row(saved?.hasCredential ? "Clave guardada" : "Sin clave guardada", null, credential));
    const secret = add("account-secret", "Clave (oculta; nunca se recupera del almacén)", "", "password");
    secret.disabled = true;
    secret.maxLength = 4096;
    secret.spellcheck = false;
    function submit(kind) {
      if (saving) return;
      const value = { nombre: name.value, baseUrl: url.value, api: api.value, compat: config.compat || {}, models: models.value.split(",").map((x) => x.trim()).filter(Boolean), defaultModel: def.value };
      if (credential.value === "set") value.apiKey = secret.value;
      else if (credential.value === "clear") value.apiKey = null;
      secret.value = "";
      const p = { action: kind, accountId: saved?.accountId || `account-${Date.now().toString(36)}`, provider: provider.value, config: value };
      const gen = generation;
      saving = true;
      for (const b of f.querySelectorAll("button")) b.disabled = true;
      work(() => agent(p), (next) => {
        if (gen === generation) discard();
        apply(next);
        message.textContent = "Configuración guardada. Conexión no probada.";
      }).finally(() => {
        saving = false;
        for (const b of f.querySelectorAll("button")) b.disabled = false;
        if (s.alive()) paint();
      });
    }
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      if (e.isTrusted === true) submit(saved ? "abito_account_save" : "abito_account_create");
    });
    const save = action("Guardar configuración", () => {
    });
    save.type = "submit";
    f.append(row("Configuración", null, save, saved ? action("Guardar endpoint", () => submit("abito_account_endpoint_set")) : null, action("Cancelar", () => {
      discard();
      paint();
    })));
    return f;
  }
  function start(providerId, method) {
    const plan = V.loginPlan(state, providerId, method);
    if (!plan) return;
    login = { providerId, phase: "active", sawFlow: false };
    paint();
    if (plan.kind === "start") send({ action: "auth_start", accountId: plan.accountId, method: plan.method });
    else {
      pendingLogin = V.pendingLogin(state, plan.provider, plan.method);
      send({ action: "account_create", provider: plan.provider, label: plan.label }, `${plan.label}: cuenta creada.`);
    }
  }
  function cancel() {
    const plan = V.cancelPlan(login);
    if (plan.kind === "send") send({ action: "auth_cancel", flowId: plan.flowId });
    else {
      login = pendingLogin = null;
      paint();
    }
  }
  function renderFlow(auth, prompt, ev) {
    const key = JSON.stringify([prompt, ev, auth.flowId]);
    if (flow && key === flowKey) return flow;
    if (flow) for (const input of flow.querySelectorAll("input")) input.value = "";
    flowKey = key;
    flow = h("div", { role: "group", "aria-label": "Inicio de sesión en curso" });
    if (ev?.message) flow.append(note(ev.message));
    if (ev?.userCode) flow.append(h("code", { class: "path", text: ev.userCode }));
    if (ev?.link) flow.append(note(ev.link), note("Abre este enlace en tu navegador. Abrir enlaces no está disponible en esta ventana."));
    else if (ev?.linkRejected) flow.append(note("No se pudo abrir el enlace desde acá."));
    if (prompt) {
      flow.append(note(prompt.message));
      const reply = (value) => work(() => agent({ action: "auth_reply", flowId: prompt.flowId, promptId: prompt.promptId, value }), apply);
      if (prompt.control === "select") for (const o of prompt.options) flow.append(action(o.label, () => reply(o.id)));
      else if (prompt.control === "confirm") flow.append(action("Sí", () => reply("yes")), action("No", () => reply("no")));
      else {
        const f = h("form", {}), input = field("settings-secret", prompt.masked ? "Clave (se oculta al escribir)" : "Respuesta", prompt.masked ? "password" : "text");
        input.maxLength = 4096;
        input.spellcheck = false;
        const save = action("Enviar", () => {
        }, true);
        save.type = "submit";
        input.addEventListener("input", (e) => {
          if (e.isTrusted) save.disabled = !V.replyValid(input.value);
        });
        f.addEventListener("submit", (e) => {
          e.preventDefault();
          if (e.isTrusted !== true || !V.replyValid(input.value)) return;
          const value = input.value;
          input.value = "";
          save.disabled = true;
          reply(value);
        });
        f.append(row("Respuesta", null, input, save));
        flow.append(f);
      }
    }
    flow.append(action("Cancelar", () => send({ action: "auth_cancel", flowId: prompt?.flowId || String(auth.flowId || "") })));
    return flow;
  }
  function paintKeys() {
    clear(keys);
    keys.append(label("Claves"), note("Se guardan en el llavero del sistema. Sólo se muestra su presencia; el valor nunca se recupera."));
    for (const r of V.keyRows(keyPresence)) {
      const input = field(`key-input-${r.id}`, `${r.label}: valor nuevo (se oculta al escribir)`, "password");
      input.maxLength = 2048;
      input.spellcheck = false;
      const f = h("form", {}), save = action("Guardar", () => {
      }, true);
      save.type = "submit";
      input.addEventListener("input", (e) => {
        if (e.isTrusted) save.disabled = !input.value || !!keyBusy;
      });
      const change = (p) => {
        if (keyBusy || !p) return;
        keyBusy = r.id;
        save.disabled = true;
        work(() => call("secret_action", p), (result) => {
          keyPresence = { ...keyPresence, [r.id]: result?.present === true };
          keyError = "";
        }, (error) => {
          keyError = V.keyError(error);
        }).finally(() => {
          keyBusy = "";
          if (s.alive()) paintKeys();
        });
      };
      f.addEventListener("submit", (e) => {
        e.preventDefault();
        const p = e.isTrusted === true ? V.keyPayload("set", r.id, input.value) : null;
        input.value = "";
        if (p) change(p);
      });
      f.append(row(r.label, r.word, input, save, r.state === "present" ? action("Quitar", () => change(V.keyPayload("clear", r.id)), !!keyBusy) : null));
      keys.append(card(f));
    }
    if (keyError) keys.append(note(keyError));
  }
  function paint() {
    const key = JSON.stringify([state, owned, !!form, generation, saving, daemonBusy, login, pendingLogin, filter, ask.at, ask.timedOut]);
    if (key === lastKey) return;
    lastKey = key;
    const restore = preserveFocus(root);
    clear(root);
    const conn = V.connectionView(state), d = V.daemonRestartView(daemonBusy);
    const restart = action(d.action.label, () => {
      if (daemonBusy) return;
      daemonBusy = true;
      paint();
      work(() => call("daemon_action", { action: "restart" }), (result) => {
        message.textContent = V.daemonRestartOutcome(result).say;
        work(() => agent({ action: "view" }), apply);
      }).finally(() => {
        daemonBusy = false;
        if (s.alive()) paint();
      });
    }, daemonBusy);
    const failing = !!conn && ["lost", "refused", "bad_session"].includes(conn.kind);
    const engineWord = !conn ? ["on", "●", "Motor corriendo"] : conn.kind === "connecting" ? ["busy", "…", "Conectando"] : conn.kind === "no_daemon" ? ["off", "○", conn.word] : ["error", "✗", conn.word];
    const retry = failing ? action("Reintentar", () => {
      if (daemonBusy) return;
      daemonBusy = true;
      paint();
      work(() => call("daemon_action", { action: "restart" }), (result) => {
        message.textContent = V.daemonRestartOutcome(result).say;
        work(() => agent({ action: "view" }), apply);
      }).finally(() => {
        daemonBusy = false;
        if (s.alive()) paint();
      });
    }, daemonBusy) : null;
    const engine = h(
      "div",
      { id: "engine-status", class: `engine-status ${engineWord[0]}`, role: "status", "aria-live": "polite" },
      h("span", { class: "state-ico", "aria-hidden": "true", text: engineWord[1] }),
      h("span", { class: "state-word", text: engineWord[2] }),
      ...conn?.aria && conn.kind !== "connecting" ? [h("span", { class: "hint", text: conn.aria.replace(/^[^:]+: /, "") })] : [],
      ...retry ? [retry] : []
    );
    if (page !== "integrations") root.append(engine);
    if (page !== "integrations") root.append(section("Motor", row(d.rowTitle, conn?.aria || d.rowSub, restart)));
    const ownedSec = section("Configuración de proveedores");
    if (form) ownedSec.append(card(form));
    else if (!owned) ownedSec.append(note("El almacén de cuentas no está disponible. No se modificó ninguna cuenta."));
    else {
      for (const a of owned.accounts) ownedSec.append(card(row(a.config.nombre, a.hasCredential ? "Clave guardada" : "Sin clave", action("Editar", () => {
        form = accountForm(a);
        paint();
      }, saving), action("Quitar conexión", () => {
        if (saving) return;
        saving = true;
        work(() => agent({ action: "abito_account_remove", accountId: a.accountId }), (next) => {
          apply(next);
          message.textContent = "Conexión quitada. La clave se borró del almacén de Abito.";
        }).finally(() => {
          saving = false;
          if (s.alive()) paint();
        });
      }, saving))));
      ownedSec.append(action("Configurar proveedor", () => {
        form = accountForm(null);
        paint();
      }, saving));
    }
    if (page !== "integrations") root.append(ownedSec);
    const auth = state?.auth || {}, prompt = V.promptView(auth.prompt), ev = V.eventView(auth.event);
    const flowLive = !!(prompt || ev || auth.flowId && !auth.last);
    if (login?.phase === "active") {
      if (flowLive) {
        login.sawFlow = true;
        if (!login.flowId && auth.flowId) login.flowId = String(auth.flowId);
      } else if (login.sawFlow && auth.last) {
        const out = V.flowOutcome(auth.last);
        if (out.word === "Conectada") login = null;
        else login.phase = out.word === "Cancelado" ? "cancelled" : "error";
      }
    }
    const search = field("settings-filter", "Buscar proveedor", "search", filter);
    search.addEventListener("input", (e) => {
      if (e.isTrusted) {
        filter = search.value;
        paint();
      }
    });
    const providers = section("Proveedores", row("Buscar proveedor", null, search));
    const cards = [];
    for (const r of V.providerRows(state, { filter, flow: login })) {
      const account = r.accountId ? (state?.accounts || []).find((a) => a.accountId === r.accountId) : null;
      const [kind, icon, word] = r.status.kind === "connected" ? ["ok", "✓", String(account?.label || r.status.word).slice(0, 48)] : r.cancel ? ["busy", "…", "conectando"] : r.error ? ["error", "✗", "error"] : ["missing", "✗", "sin cuenta"];
      const primary = r.logout ? action("Salir", () => send({ action: "account_logout", accountId: r.accountId }, `${r.name}: sesión cerrada.`)) : r.cancel ? action(r.cancel.word, cancel) : (() => {
        const a = r.auth || r.api;
        return a ? action("Conectar…", () => start(r.id, a.method), a.disabled) : null;
      })();
      if (primary) primary.setAttribute("aria-label", r.logout ? `${V.LOGOUT_WORD}: ${r.name}` : r.cancel ? r.cancel.aria : `${(r.auth || r.api).aria}`);
      const extra = [];
      if (!r.logout && !r.cancel && r.auth && r.api) extra.push(action(r.api.word, () => start(r.id, r.api.method), r.api.disabled));
      const c = notchCard(
        r.name,
        h("span", { class: `card-state ${kind}` }, h("span", { class: "state-ico", "aria-hidden": "true", text: icon }), h("span", { class: "state-word", text: word })),
        ...primary ? [primary] : [],
        ...extra,
        ...[r.error, r.note].filter(Boolean).length ? [h("div", { class: "hint", text: [r.error, r.note].filter(Boolean).join(" · ") })] : []
      );
      c.setAttribute("id", `provider-${r.id}`);
      cards.push(c);
    }
    if (flowLive) providers.append(card(renderFlow(auth, prompt, ev)));
    else if (flow) {
      for (const input of flow.querySelectorAll("input")) input.value = "";
      flow = null;
    }
    if (page !== "integrations") root.append(...cards, providers);
    const connectors = section("Conectores"), av = V.agentsView(state, { askedAtError: ask.at, timedOut: ask.timedOut });
    connectors.append(label("Agentes"));
    if (av.kind !== "ready") connectors.append(status(av));
    else for (const r of av.rows) connectors.append(card(row(r.name, [r.word, r.summary, r.note].filter(Boolean).join(" · "), r.primary ? action(r.primary.label, () => send(r.primary.command, `${r.name}: ${r.primary.label === "Actualizar" ? "actualizado" : "conectado"}.`)) : null, r.secondary ? action(r.secondary.label, () => send(r.secondary.command, `${r.name}: desconectado.`)) : null)));
    const services = V.connectorsView(state);
    connectors.append(label("Servicios"));
    if (services.kind !== "ready") connectors.append(status(services));
    else for (const i of services.items) connectors.append(row(i.label, [i.word, i.sends ? "Puede enviar" : ""].filter(Boolean).join(" · ")));
    if (page !== "chat") root.append(connectors);
    if (page !== "integrations" && showKeys) root.append(keys);
    root.append(message);
    restore();
  }
  if (page !== "integrations" && showKeys) paintKeys();
  paint();
  watch("agent:state", apply);
  later(() => {
    if (state === null) {
      state = { connection: "no_daemon" };
      paint();
    }
  }, V.CONNECT_WAIT_MS);
  work(() => agent({ action: "view" }), (next) => {
    ask.at = next?.last_error?.n || 0;
    apply(next);
  });
  for (const a of ["connectors_list", "agents_list", "hooks_preview"]) work(() => agent({ action: a }), apply);
  later(() => {
    ask.timedOut = true;
    paint();
  }, V.AGENTS_WAIT_MS);
  if (page !== "integrations" && showKeys) work(async () => {
    const presence = {};
    for (const id of V.KEY_IDS) {
      const r = await call("secret_action", V.keyPayload("present", id));
      presence[id] = r?.present === true;
    }
    keyPresence = presence;
    paintKeys();
  }, () => {
  }, (error) => {
    keyError = V.keyError(error);
    paintKeys();
  });
  return s.finish();
}
async function renderModels({ invoke, V, C, listen, connected = true }) {
  const s = session(invoke, listen), { root, message, call, work, watch } = s;
  let state = null, prefs = {}, listing = null, busy = false;
  const apply = (next) => {
    listing = next;
    paint();
  };
  function change(cmd, p, done) {
    if (busy) return;
    busy = true;
    paint();
    work(() => call(cmd, p), done).finally(() => {
      busy = false;
      if (s.alive()) paint();
    });
  }
  function paint() {
    const restore = preserveFocus(root);
    clear(root);
    const providers = section("Cuentas conectadas"), view = V.modelsTabView(state, prefs.chosenModels || {});
    if (view.kind !== "ready") providers.append(status(view));
    else for (const g of view.groups) if (g.connected) for (const m of g.models) {
      const detail = [g.name, m.sub, m.contextWindow > 0 ? `Contexto ${m.contextWindow}` : "", m.reasoning ? "Razonamiento" : ""].filter(Boolean).join(" · ");
      providers.append(row(m.name, detail, action(m.chosen ? "Elegido" : "Elegir", () => change("prefs_action", V.chosenModelsPayload(V.chosenToggle(prefs.chosenModels || {}, g.id, m.id), g.id), (p) => {
        prefs = p;
      }), busy)));
    }
    const locals = section("Locales", row("Modelos locales", listing ? C.modelsInfo(listing) : "Leyendo…", action("Actualizar", () => change("models_action", { action: "refresh" }, apply), busy)));
    if (C) locals.append(row("Modelos verificados", String(C.modelsCount(listing))));
    if (listing?.resources_text) locals.append(note(`Recursos: ${listing.resources_text}`));
    if (C) for (const meter of C.modelMeters(listing)) locals.append(row(meter.label, meter.aria));
    if (C) for (const m of C.modelRows(listing)) locals.append(row(m.title, [m.word, m.facts, m.message, m.note, ...m.chips.map((c) => c.text)].filter(Boolean).join(" · "), action(m.selected ? "Elegido" : "Elegir", () => change("models_action", { action: "select", profile_id: m.id }, apply), busy || !m.selectable || m.selected)));
    if (connected) root.append(providers);
    root.append(locals, message);
    restore();
  }
  paint();
  watch("agent:state", (p) => {
    state = { ...state, ...p };
    paint();
  });
  watch("prefs:state", (p) => {
    prefs = p;
    paint();
  });
  watch("models:state", apply);
  work(() => call("agent_action", { action: "view" }), (p) => {
    state = p;
    paint();
  });
  work(() => call("prefs_action", { action: "view" }), (p) => {
    prefs = p;
    paint();
  });
  work(() => call("agent_action", { action: "models_list" }), (p) => {
    state = { ...state, ...p };
    paint();
  });
  s.later(() => {
    if (state === null) {
      state = { connection: "no_daemon" };
      paint();
    }
  }, V.CONNECT_WAIT_MS);
  work(async () => {
    apply(await call("models_action", { action: "list" }));
    return call("models_action", { action: "refresh" });
  }, apply);
  return s.finish();
}
export {
  renderAccounts,
  renderModels
};
