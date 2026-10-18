// Adapted from Coucou src/hub/shell.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
import { h, clear } from "../views/dom.js";
import { t } from "./i18n-es.js";
import { onEvent } from "./bridge-shim.js";
import { FlowBridge } from "./flow-shim.js";
import { hero, liveMochi } from "./hero.js";
import { icon, keyLabel } from "./ui.js";
const FLOW_PAGES = [
  { id: "dictation", icon: "mic", title: () => t("Dictation") },
  { id: "notes", icon: "record", title: () => t("Notetaker") },
  { id: "insights", icon: "chart", title: () => t("Statistics") },
  { id: "dictionary", icon: "book", title: () => t("Dictionary") },
  { id: "snippets", icon: "bolt", title: () => t("Snippets") },
  { id: "styles", icon: "text", title: () => t("Styles") },
  { id: "flowsettings", icon: "sliders", title: () => t("Settings") }
];
const NOTCH_PAGES = [
  { id: "general", icon: "gear", title: () => t("General"), subtitle: () => t("The character, its sounds and how the island behaves.") },
  { id: "pills", icon: "grid", title: () => t("Active pills"), subtitle: () => t("The pills shown in the island, their order and their colours.") },
  { id: "agents", icon: "terminal", title: () => t("Agents"), subtitle: () => t("Claude Code, Codex and the other agents Abito follows.") },
  { id: "chat", icon: "chat", title: () => t("Chat"), subtitle: () => t("The AI of the island's chat, with your own keys.") },
  { id: "voice", icon: "wave", title: () => "OK Abito" },
  { id: "integrations", icon: "puzzle", title: () => t("Integrations"), subtitle: () => t("Stripe, GitHub, Vercel, n8n, Notion and the rest.") },
  { id: "phone", icon: "phone", title: () => t("Android phone"), subtitle: () => t("Your agents and their approvals on your Android phone, over your Wi-Fi.") },
  { id: "shortcuts", icon: "keyboard", title: () => t("Shortcuts"), subtitle: () => t("The keys that open the island and its actions.") }
];
const ALL = [...FLOW_PAGES, ...NOTCH_PAGES];
const DEFAULT_STATUS = {
  prefs: {
    enabled: false,
    key: "right_ctrl",
    edge: "bottom",
    mic: "",
    keepDays: 30,
    cleanup: false,
    defaultStyle: "natural",
    summaryEngine: "claude",
    openAtLaunch: true,
    voice: false,
    voiceOutput: "system",
    voiceGender: "female"
  },
  models: { parakeet: { state: "missing" }, downloadMb: 700 },
  keys: "ok",
  hasClaudeKey: false,
  mics: [],
  platform: navigator.userAgent.includes("Windows") ? "windows" : "linux",
  autostarted: false
};
async function startHub(root, opts) {
  document.body.classList.add("hub-window");
  let current = "dictation";
  let status = await FlowBridge.status() ?? DEFAULT_STATUS;
  const items = /* @__PURE__ */ new Map();
  const statusLine = h("div", { class: "hub-status" });
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;
  const ctx = {
    get status() {
      return status;
    },
    navigate: (page) => void show(page),
    refresh: async () => {
      status = await FlowBridge.status() ?? status;
      drawStatus();
      return status;
    },
    setPrefs: async (change) => {
      const next = { ...status.prefs };
      change(next);
      await FlowBridge.setPrefs(next);
      status = { ...status, prefs: next };
      drawStatus();
    },
    hero: (page, title, subtitle, actions = [], compact = false) => hero(page, title, subtitle, actions, compact)
  };
  function drawStatus() {
    clear(statusLine);
    const models = status.models.parakeet.state;
    let color = "#6b7079";
    let text;
    if (!status.prefs.enabled) {
      text = t("Dictation is off");
    } else if (models !== "ready") {
      color = "#f7b32b";
      text = models === "downloading" ? t("Downloading the voice model…") : t("Download the voice model to dictate");
    } else if (status.keys !== "ok" && status.keys !== "wayland") {
      color = "#f7b32b";
      text = t("Use the pill's microphone to dictate");
    } else {
      color = "#34d399";
      text = t("Ready · hold {0}", { 0: keyLabel(status.keys === "wayland" ? "wayland" : status.prefs.key, status.platform) });
    }
    statusLine.append(h("i", { class: "dot", style: `background:${color}` }), h("span", { text }));
  }
  async function show(page) {
    const def = ALL.find((p) => p.id === page);
    ctx.onLeave?.();
    ctx.onLeave = void 0;
    current = def?.id ?? page;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    const renderer = opts.flowPages[page];
    if (renderer) {
      await renderer(page_, ctx);
    } else {
      page_.append(hero(page, def?.title() ?? t("Settings"), def?.subtitle?.() ?? null));
      const container = h("div", { id: "settings-root" });
      page_.append(container);
      await opts.renderNotch(page, container);
    }
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    scroll.scrollTop = 0;
  }
  const side = h("nav", { class: "hub-side" });
  const logo = h("canvas", {});
  side.append(h("div", { class: "hub-brand" }, logo, h("span", { text: "Abito" })));
  liveMochi(logo);
  const group = (title, pages) => {
    side.append(h("div", { class: "hub-group", text: title }));
    for (const p of pages) {
      const b = h("button", { class: "hub-item", onclick: () => void show(p.id) });
      b.append(icon(p.icon), h("span", { text: p.title() }));
      items.set(p.id, b);
      side.append(b);
    }
  };
  group("Flow", FLOW_PAGES);
  group(t("Notch"), NOTCH_PAGES);
  side.append(h("div", { class: "spacer" }), statusLine, h("div", { class: "hub-version", text: `Abito ${opts.version}` }));
  clear(root);
  root.append(side, h("main", { class: "hub-panel" }, scroll));
  drawStatus();
  await show(current);
  void onEvent("hub-page", (page) => {
    const id = page === "settings" ? "flowsettings" : page;
    void show(id);
  });
  void onEvent("flow-prefs", (prefs) => {
    status = { ...status, prefs };
    drawStatus();
  });
  void onEvent("speech-models", (models) => {
    status = { ...status, models };
    drawStatus();
  });
  return { redraw: () => void show(current), current: () => current };
}
export {
  FLOW_PAGES,
  NOTCH_PAGES,
  startHub
};
