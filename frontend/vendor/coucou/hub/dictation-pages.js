// Adapted from Coucou src/hub/pages/{dictation,flowsettings}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { t } from "./i18n-es.js";
import { onEvent } from "./bridge-shim.js";
import { FlowBridge } from "./flow-shim.js";
import { button, card, divider, keyKeycap, keycap, label, number, row, segmented, select, toggle, icon } from "./ui.js";
import { trusted } from "./runtime.js";
import { emptyState, glowCard } from "./hero.js";
const unavailable = (el) => {
  el.disabled = true;
  el.title = "No disponible todavía";
  return el;
};
function mount(page, ctx) {
  let alive = true;
  const cleanups = [];
  const message = h("div", { class: "hub-note", role: "status" });
  const life = {
    alive: () => alive,
    watch: async (fn) => {
      const off = await onEvent("dictation:models", (m) => {
        if (alive) fn(m);
      });
      if (alive) cleanups.push(off);
      else off();
    },
    work: async (fn) => {
      if (!alive) return;
      try {
        return await fn();
      } catch {
        if (alive) message.textContent = "No se pudo completar. No se anuncia ningún cambio como guardado.";
      }
    }
  };
  ctx.onLeave = () => {
    alive = false;
    for (const off of cleanups.splice(0)) off();
  };
  queueMicrotask(() => {
    if (alive) page.append(message);
  });
  return life;
}
function modelsControl(ctx, life, onReady) {
  const el = h("div", { style: "display:flex;align-items:center;gap:8px" });
  let models = ctx.status.models, confirming = false, busy = false;
  const run = (fn) => void life.work(async () => {
    if (busy) return;
    busy = true;
    try {
      const next = await fn();
      if (life.alive()) {
        models = next;
        ctx.status.models = next;
        ctx.updateModels?.(next);
        confirming = false;
        draw();
      }
    } finally {
      busy = false;
    }
  });
  const click = (text, fn, kind = "", small = false) => trusted(button(text, fn, kind, small));
  const draw = () => {
    clear(el);
    const m = models.parakeet;
    if (m.state === "missing") el.append(click(t("Download"), () => run(FlowBridge.download), "primary"));
    else if (m.state === "downloading") {
      const percent = Math.round(Math.max(0, Math.min(1, m.fraction ?? 0)) * 100);
      el.append(h("div", { class: "hub-progress" }, h("i", { style: `width:${percent}%` })), h("span", { class: "hub-note", text: `${percent} %` }));
    } else if (m.state === "failed") el.append(h("span", { class: "hub-note", text: m.error, title: m.error, style: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }), click(t("Retry"), () => run(FlowBridge.download)));
    else if (confirming) el.append(click(t("Remove the models"), () => run(FlowBridge.removeModels), "danger", true), click(t("Cancel"), () => {
      confirming = false;
      draw();
    }, "", true));
    else el.append(trusted(h("button", { class: "hub-link", style: "color:var(--hub-green)", text: `✓ ${t("Installed")}`, title: t("Remove the models"), onclick: () => {
      confirming = true;
      draw();
    } })));
  };
  draw();
  void life.watch((next) => {
    const wasReady = models.parakeet.state === "ready";
    models = next;
    ctx.status.models = next;
    ctx.updateModels?.(next);
    draw();
    if (!wasReady && next.parakeet.state === "ready") onReady?.();
  });
  return el;
}
async function flowSettingsPage(page, ctx) {
  const life = mount(page, ctx);
  const status = await ctx.refresh();
  if (!life.alive()) return;
  const save = (change) => life.work(() => ctx.setPrefs(change));
  const prefs = status.prefs;
  page.append(ctx.hero("flowsettings", t("Settings"), null));
  const edges = [["bottom", t("Bottom")], ["left", t("Left")], ["right", t("Right")]];
  page.append(label(t("Keys")));
  const keysCard = card(
    row(t("Hold a key to dictate anywhere"), null, trusted(toggle(prefs.enabled, (on) => save((p) => p.enabled = on)))),
    divider(),
    row(t("Hold to dictate"), null, keyKeycap("wayland", status.platform)),
    divider(),
    row(t("Where the pill is"), null, trusted(segmented(edges, prefs.edge, (edge) => save((p) => p.edge = edge)))),
    divider(),
    row(t("Hands-free"), t("Tap twice, speak as long as you like, tap once to paste."), keyKeycap("wayland", status.platform, true)),
    divider(),
    row(t("Paste the last dictation again"), t("When the words went to the wrong place."), unavailable(button(t("Paste again"), () => {
    }, "", true))),
    divider(),
    row(t("Cancel a dictation"), null, keycap(t("Esc")))
  );
  if (status.keys === "ok") {
    keysCard.append(h("div", {
      class: "hub-warn",
      text: t("On Wayland, the desktop holds the dictation key for Abito: Ctrl+Alt+V, or the keys you picked when it asked. The first paste asks once to let Abito type for you.")
    }));
  } else if (status.keys !== "ok") {
    keysCard.append(h("div", { class: "hub-warn", text: t("Abito can't watch the keyboard here: use the pill's microphone to dictate.") }));
  }
  page.append(keysCard);
  page.append(label(t("Microphone")));
  const mics = [["", t("System default")], ...status.mics.map((m) => [m.name, m.name])];
  if (prefs.mic && !mics.some(([id]) => id === prefs.mic)) mics.push([prefs.mic, prefs.mic]);
  page.append(card(row(t("Microphone"), t("The one Abito listens to for dictation and calls."), trusted(select(mics, prefs.mic, (mic) => save((p) => p.mic = mic))))));
  page.append(label(t("Recognition")));
  page.append(card(
    row(t("Parakeet, on your computer"), t("The most accurate, offline, 25 languages. Downloaded once (about {0} MB).", { 0: number(status.models.downloadMb) }), modelsControl(ctx, life)),
    h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here, and the recording is dropped as soon as it is pasted.") })
  ));
  page.append(label(t("Notetaker")));
  page.append(card(
    row(t("Summaries"), null, unavailable(select([["claude", t("Claude (your key)")], ["off", t("No summary")]], "off", () => {
    }))),
    h("div", { class: "hub-note", text: t("With Claude, the transcript (never the audio) goes to Anthropic with your key from Notch → Chat.") }),
    divider(),
    h("div", { class: "hub-note", text: t("Everything stays on this computer. Tell the people in the call that you are recording.") })
  ));
  page.append(h("div", { class: "hub-note", text: "No disponible todavía" }));
  page.append(label(t("App")));
  page.append(card(
    row(t("Open this window when you open Abito"), t("Not when Abito starts with the computer."), unavailable(toggle(false, () => {
    })))
  ));
  page.append(label(t("Privacy")));
  const keep = [["0", t("Don't keep")], ["7", t("7 days")], ["30", t("30 days")], ["365", t("1 year")], ["-1", t("Forever")]];
  const confirmRow = h(
    "div",
    { class: "hub-row" },
    unavailable(button(t("Erase the history"), () => {
    }, "", true)),
    unavailable(button(t("Erase everything"), () => {
    }, "", true))
  );
  page.append(card(
    row(t("Keep the history"), null, trusted(select(keep, String(prefs.keepDays), (v) => save((p) => p.keepDays = Number(v))))),
    divider(),
    confirmRow,
    h("div", { class: "hub-note", text: t("The history, the statistics and your notes stay on this computer, in Abito's folder. Dictations are never saved as audio; a call's audio is deleted as soon as its transcript is written.") })
  ));
}
async function dictationPage(page, ctx) {
  const life = mount(page, ctx), status = await ctx.refresh(), key = "Ctrl+Alt+V";
  if (!life.alive()) return;
  const record = unavailable(button(t("Record a call"), () => {
  }, "primary"));
  record.prepend(h("span", { class: "hub-rec", style: "background:#170c04;box-shadow:none;margin-inline-end:8px" }));
  page.append(ctx.hero("dictation", t("Hello"), t("Hold {0} anywhere, speak, let go: it's pasted.", { 0: key }), [record]));
  page.append(h("div", { class: "hub-note" }));
  if (!status.prefs.enabled || status.models.parakeet.state !== "ready") {
    const body = h(
      "div",
      { style: "display:flex;flex-direction:column;gap:12px" },
      h("div", { style: "font:700 17px var(--font)", text: t("Dictate anywhere on your computer") }),
      h("div", { class: "hub-note", style: "color:#b7bbc2;font-size:13px", text: t("Hold {0} in any app, speak, let go: your words are pasted where you type.", { 0: key }) }),
      row(t("Turn on dictation"), null, trusted(toggle(status.prefs.enabled, (on) => void life.work(async () => {
        await ctx.setPrefs((p) => {
          p.enabled = on;
        });
        if (life.alive()) ctx.navigate("dictation");
      })))),
      row(t("Parakeet, on your computer"), t("The most accurate, offline, 25 languages. Downloaded once (about {0} MB).", { 0: number(status.models.downloadMb) }), modelsControl(ctx, life, () => ctx.navigate("dictation")))
    );
    page.append(glowCard("#FB923C", body));
  }
  const search = unavailable(h("input", { class: "hub-input", placeholder: t("Search dictations"), type: "search" }));
  const list = h(
    "div",
    { style: "display:flex;flex-direction:column;gap:10px" },
    emptyState(status.prefs.keepDays === 0 ? t("The history is off. Turn it on in Settings → Privacy.") : t("Your dictations will show here. Hold {0} in any app and speak.", { 0: key })),
    h("div", { class: "hub-note", text: "No disponible todavía" })
  );
  const left = h("div", { style: "display:flex;flex-direction:column;gap:10px;min-width:0" }, h("div", { class: "hub-history-head" }, label(t("History")), search), list);
  const big = (text) => h("div", { class: "hub-big-number" }, h("b", { text: number(0) }), h("span", { text: t(text) }));
  const check = icon("check");
  check.style.setProperty("width", "15px");
  check.style.setProperty("height", "15px");
  check.style.setProperty("fill", "none");
  check.style.setProperty("stroke", "currentColor");
  check.style.setProperty("stroke-width", "2.2");
  const numbers = card(big("words dictated"), big("words/min"), big("days in a row"), divider(), h("div", { class: "hub-ok" }, check, h("span", { text: t("Unlimited and free") })));
  const promo = glowCard(
    "#FB923C",
    h("div", { style: "font:700 15px var(--font)", text: t("The Notetaker") }),
    h("div", { class: "hub-note", style: "color:#b7bbc2", text: t("Your calls transcribed person by person, with a summary and the to-dos. No bot in the meeting.") }),
    unavailable(h("button", { class: "hub-link", text: t("Open the Notetaker →") }))
  );
  page.append(h("div", { class: "hub-columns" }, left, h("div", { style: "display:flex;flex-direction:column;gap:14px" }, numbers, promo)));
}
export {
  dictationPage,
  flowSettingsPage,
  modelsControl
};
