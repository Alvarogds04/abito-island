// Adapted from Coucou src/hub/pages/voice.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h } from "../views/dom.js";
import { card, row, button, label, divider, toggle, segmented } from "./ui.js";
import { t } from "./i18n-es.js";
import { trusted } from "./runtime.js";
import { VoiceBridge, FlowBridge } from "./flow-shim.js";
async function voicePage(page, ctx) {
  let alive = true, st = await VoiceBridge.status();
  ctx.onLeave = () => {
    alive = false;
  };
  const message = h("div", { class: "hub-note", role: "status" });
  const apply = (next) => {
    if (alive && next) {
      st = next;
      draw();
    }
  };
  const work = async (fn) => {
    try {
      apply(await fn());
    } catch {
      if (alive) {
        message.textContent = "No se pudo completar. No se anuncia ningún cambio como guardado.";
      }
    }
  };
  const save = (change) => work(() => {
    const p = { ...st.prefs };
    change(p);
    return VoiceBridge.setPrefs(p);
  });
  const box = h("div", {});
  page.append(ctx.hero("voice", "OK Abito", t("Say « OK Abito », then ask anything: add a pill, play music, the weather, an email to prepare.")), box);
  function modelControl() {
    const el = h("div", { style: "display:flex;align-items:center;gap:8px" });
    const k = st?.kws?.state ?? "missing", p = st?.parakeet?.state ?? "missing";
    const fraction = k === "downloading" ? st.kws.fraction : p === "downloading" ? st.parakeet.fraction : 0;
    if (k === "downloading" || p === "downloading") {
      const percent = Math.round(Math.max(0, Math.min(1, fraction ?? 0)) * 100);
      el.append(h("div", { class: "hub-progress" }, h("i", { style: `width:${percent}%` })), h("span", { class: "hub-note", text: `${percent} %` }));
    } else if (k === "ready" && p === "ready") {
      el.append(
        h("span", { class: "hub-note", style: "color:var(--hub-green)", text: `✓ ${t("Installed")}` }),
        trusted(button(t("Remove the models"), () => void work(VoiceBridge.remove), "", true))
      );
    } else {
      const err = st?.kws?.error ?? st?.parakeet?.error;
      if (err) el.append(h("span", { class: "hub-note", text: err, title: err, style: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
      el.append(trusted(button(err ? t("Retry") : t("Download"), () => void work(async () => {
        const next = await VoiceBridge.download();
        if (p === "missing" || p === "failed") await FlowBridge.download();
        return next;
      }), "primary")));
    }
    return el;
  }
  function draw() {
    box.replaceChildren();
    if (!st) {
      box.append(card(row(t("Dictation is off"), "No disponible")));
      return;
    }
    const output = segmented([["system", t("System voice")], ["elevenlabs", "ElevenLabs"], ["off", t("Text only")]], st.prefs.output, (v) => void save((p) => {
      p.output = v;
    }));
    trusted(output);
    const sensitivity = trusted(h("input", { type: "range", min: "0", max: "100", step: "5", value: String(st.prefs.sensitivity ?? 50), class: "hub-range", "aria-label": t("Wake-word sensitivity") }));
    sensitivity.addEventListener("change", () => void save((p) => {
      p.sensitivity = Math.max(0, Math.min(100, Math.round(Number(sensitivity.value))));
    }));
    box.append(
      label(t("Listening")),
      card(
        row(t("Listen for « OK Abito »"), t("The microphone stays open; only what follows « OK Abito » goes further."), trusted(toggle(st.prefs.enabled, (on) => void save((p) => {
          p.enabled = on;
        })))),
        divider(),
        row(t("Parakeet, on your computer"), t("Hears « OK Abito » here, without the internet."), modelControl())
      ),
      label(t("Answers")),
      card(row(t("Abito answers out loud"), null, output)),
      label(t("Sensitivity")),
      card(row(t("Wake-word sensitivity"), t("Higher hears « OK Abito » more easily, and mishears more."), sensitivity)),
      label(t("Privacy")),
      card(
        h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here. Only the words after « OK Abito » go to Anthropic with your Claude key, and to ElevenLabs if you picked it for the answers.") }),
        divider(),
        h("div", { class: "hub-note", text: t("An email is never sent by Abito: your mail app opens with it written, and you send it.") })
      ),
      message
    );
    if (st.error) message.textContent = st.error;
  }
  draw();
  const listen = window.__TAURI__?.event?.listen;
  if (listen) {
    const off = await listen("voice-model", (e) => {
      if (alive && e?.payload) apply(e.payload);
    });
    const prev = ctx.onLeave;
    ctx.onLeave = () => {
      prev?.();
      off();
    };
  }
}
export {
  voicePage
};
