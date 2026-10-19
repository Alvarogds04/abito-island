// Abito window context — GNOME Shell extension (#487).
//
// Adapted in purpose from Coucou NotchBuddy/Sources/App/WindowContextCapture.swift @71b773f,
// Copyright (c) 2026 Louis Raillé, MIT. Original code, no Coucou files copied.
//
// Exposes on the SESSION bus (name org.abito.Context):
//   GetRecentWindows() -> a(sss)   (app id, app name, title), most recently focused first.
// Read-only: it never focuses, moves or closes anything and exposes no window ids, pids or
// content. Abito calls it only on demand (once, when the chat opens with the setting on).
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.abito.Context';
const OBJECT_PATH = '/org/abito/Context';
const MAX_HISTORY = 8;

const IFACE = `<node>
  <interface name="org.abito.Context">
    <method name="GetRecentWindows">
      <arg type="a(sss)" direction="out" name="windows"/>
    </method>
  </interface>
</node>`;

export default class AbitoContextExtension extends Extension {
    enable() {
        this._history = []; // Meta.Window, most recent first
        this._unmanaged = new Map(); // window -> signal id
        this._focusId = global.display.connect('notify::focus-window', () => this._remember(global.display.focus_window));
        this._remember(global.display.focus_window);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._ownerId) Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
        this._dbus?.unexport();
        this._dbus = null;
        if (this._focusId) global.display.disconnect(this._focusId);
        this._focusId = 0;
        for (const [win, id] of this._unmanaged) win.disconnect(id);
        this._unmanaged.clear();
        this._history = [];
    }

    _remember(win) {
        if (!win || win.is_skip_taskbar()) return;
        this._history = this._history.filter(w => w !== win);
        this._history.unshift(win);
        this._history.length = Math.min(this._history.length, MAX_HISTORY);
        if (!this._unmanaged.has(win)) {
            this._unmanaged.set(win, win.connect('unmanaged', () => {
                this._unmanaged.delete(win);
                this._history = this._history.filter(w => w !== win);
            }));
        }
    }

    GetRecentWindows() {
        const tracker = Shell.WindowTracker.get_default();
        const rows = this._history.map(win => {
            const app = tracker.get_window_app(win);
            return [app?.get_id() ?? win.get_wm_class() ?? '', app?.get_name() ?? win.get_wm_class() ?? '', win.get_title() ?? ''];
        });
        return [rows]; // wrapJSObject wants the out args as a tuple
    }
}
