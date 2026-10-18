// Adapted from Coucou src/hub/pages/{dictation,notes,insights,words,styles,flowsettings,voice}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h } from "../views/dom.js";
import { card, row, button, keyLabel, label, divider, toggle, segmented } from "./ui.js";
import { notchSection, notchRow, notchHint } from "./notch.js";
import { t } from "./i18n-es.js";
const definitions = {
  notes: ["Notetaker", "Your calls transcribed person by person, with a summary and the to-dos. No bot in the meeting.", "Record a call"],
  voice: ["OK Abito", "Say « OK Abito », then ask anything: add a pill, play music, the weather, an email to prepare.", "Enable"]
};
function renderUnavailable(page) {
  if (page === "phone") {
    const sw = toggle(false, () => {
    });
    sw.disabled = true;
    return notchSection(
      t("Android phone"),
      notchHint(t("Send your agents' sessions to Abito for Android and answer permission requests from the phone. Off by default; it only listens on your local network.")),
      notchHint(t("Allow on the phone asks for the fingerprint or the screen lock. Deny does not.")),
      notchRow(t("Phone link"), sw),
      notchHint("No disponible"),
      h("div", {})
    );
  }
  const control = button(t(page === "phone" ? "Connect" : "Enable"), () => {
  });
  control.disabled = true;
  return card(row(page === "phone" ? "No disponible" : "pendiente de conectar", null, control));
}
const inactivePages = Object.fromEntries(
  Object.entries(definitions).map(([page, [title, subtitle, action]]) => [page, (container, ctx) => {
    if (page === "voice") {
      const off = toggle(false, () => {
      });
      off.disabled = true;
      const download = button(t("Download"), () => {
      }, "primary");
      download.disabled = true;
      const output = segmented([["system", t("System voice")], ["elevenlabs", "ElevenLabs"], ["off", t("Text only")]], "system", () => {
      });
      for (const b of output.querySelectorAll("button")) b.disabled = true;
      container.append(
        ctx.hero("voice", "OK Abito", t(subtitle)),
        label(t("Listening")),
        card(
          row(t("Listen for « OK Abito »"), t("The microphone stays open; only what follows « OK Abito » goes further."), off),
          divider(),
          row(t("Parakeet, on your computer"), t("Hears « OK Abito » here, without the internet."), h("div", { style: "display:flex;align-items:center;gap:8px" }, download))
        ),
        label(t("Answers")),
        card(row(t("Abito answers out loud"), null, output)),
        label(t("Privacy")),
        card(
          h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here. Only the words after « OK Abito » go to Anthropic with your Claude key, and to ElevenLabs if you picked it for the answers.") }),
          divider(),
          h("div", { class: "hub-note", text: t("An email is never sent by Abito: your mail app opens with it written, and you send it.") })
        ),
        h("div", { class: "hub-note", text: "pendiente de conectar" })
      );
      return;
    }
    const control = button(t(action), () => {
    });
    control.disabled = true;
    const key = keyLabel(ctx.status.prefs.key, ctx.status.platform);
    container.append(ctx.hero(page, t(title), subtitle ? t(subtitle, { 0: key }) : null, [], page === "notes"));
    container.append(h("div", { id: "settings-root" }, card(row("pendiente de conectar", null, control))));
  }])
);
export {
  inactivePages,
  renderUnavailable
};
