// Aninux additions, mixed into the NotchNux actor (see installAninux).
//
//   - Hide on fullscreen: with a fullscreen or vertically maximized window on
//     the primary monitor (or the overview open) the notch fades out; resting
//     the pointer at the top centre brings it back until the pointer leaves.
//     A poll re-checks the windows, so the notch never stays hidden on a stale
//     state (e.g. right after login, when no window signal arrives).
//   - Stop-recording button: GNOME's screencast indicator lives in the top
//     bar, which is hidden when the notch replaces it; a red button next to
//     the notch stops the recording instead.
//   - Banners above the notch: GNOME's own banners (critical notifications…)
//     are stacked above the notch and pushed just below it, otherwise the
//     notch covers them and steals their clicks.
//
// Other extensions can keep the notch visible while hidden-on-fullscreen by
// setting `notch._externalHold = () => bool` (the robottino does this while
// its menu is open).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FS_POLL_MS = 120;
const BANNER_OFFSET = 54;

const AninuxFeatures = {
    _initAninux() {
        this._fsHidden = false;
        this._fsShown = false;
        this._fsPoll = 0;
        let fs = () => this._fsUpdate();
        this._fsConns = [
            [global.display, global.display.connect('in-fullscreen-changed', fs)],
            [global.display, global.display.connect('notify::focus-window', fs)],
            [global.window_manager, global.window_manager.connect('size-changed', fs)],
            [global.window_manager, global.window_manager.connect('minimize', fs)],
            [global.window_manager, global.window_manager.connect('unminimize', fs)],
            [global.window_manager, global.window_manager.connect('destroy', fs)],
            [global.window_manager, global.window_manager.connect('map', fs)],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', fs)],
            [Main.overview, Main.overview.connect('showing', fs)],
            [Main.overview, Main.overview.connect('hiding', fs)],
            [Main.overview, Main.overview.connect('hidden', fs)],
        ];
        if (Main.screenshotUI)
            this._recId = Main.screenshotUI.connect('notify::screencast-in-progress', () => this._recUpdate());
        this._panelVisAninuxId = Main.layoutManager.panelBox.connect('notify::visible', () => {
            this._recUpdate();
            this._bannerUpdate();
        });
        this._bannerMargin = Main.messageTray?._bannerBin?.translation_y ?? 0;
        this._bannerUpdate();
        this._recUpdate();
        this._fsUpdate();
    },

    _destroyAninux() {
        for (let [obj, id] of this._fsConns ?? []) {
            try { obj.disconnect(id); } catch (e) {}
        }
        this._fsConns = null;
        this._fsRestore();
        if (this._recId) {
            Main.screenshotUI.disconnect(this._recId);
            this._recId = 0;
        }
        this._recRemove();
        if (this._panelVisAninuxId) {
            Main.layoutManager.panelBox.disconnect(this._panelVisAninuxId);
            this._panelVisAninuxId = 0;
        }
        if (Main.messageTray?._bannerBin)
            Main.messageTray._bannerBin.translation_y = this._bannerMargin ?? 0;
    },

    _onAninuxFeatureToggled(id) {
        if (id === 'hideOnFullscreen')
            this._fsUpdate();
        else if (id === 'stopRecButton')
            this._recUpdate();
    },

    // ---------------------------------------------------------------- fullscreen

    // Is there really a fullscreen / vertically maximized window (or the overview)?
    _fsIsFull() {
        if (this._destroyed || !this._config.isFeatureEnabled('hideOnFullscreen'))
            return false;
        if (Main.overview.visible)
            return true;
        let m = Main.layoutManager.primaryMonitor;
        if (!m)
            return false;
        let mi = Main.layoutManager.primaryIndex;
        let ws = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().some(a => {
            let w = a.meta_window;
            return w && !w.minimized && w.get_monitor() === mi &&
                w.located_on_workspace(ws) &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                (w.is_fullscreen() || w.maximized_vertically);
        });
    },

    _fsUpdate() {
        let full = this._fsIsFull();
        if (full && !this._fsHidden) {
            this._fsHidden = true;
            this._fsShown = false;
            this._fsReactive = this.reactive;
            this._fsSet(false);
            this._fsPoll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FS_POLL_MS, () => {
                this._fsTick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!full && this._fsHidden) {
            this._fsRestore();
        }
    },

    _fsSet(show) {
        this._fsShown = show;
        this.remove_transition('opacity');
        this.ease({ opacity: show ? 255 : 0, duration: show ? 160 : 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this.reactive = show ? this._fsReactive : false;
    },

    _fsTick() {
        // Nothing fullscreen any more (a signal may never arrive, e.g. at
        // login): come back right away.
        if (!this._fsIsFull()) {
            this._fsRestore();
            return;
        }
        // Notifications and alerts keep the notch visible and clickable.
        if (this._peekActive || this._alertShowing || this.isExpanded) {
            if (!this._fsShown || !this.reactive)
                this._fsSet(true);
            return;
        }
        let [px, py] = global.get_pointer();
        let cx = this.x + this.width / 2;
        let near = Math.abs(px - cx) <= Math.max(this.width / 2, 120) + 40;
        let held = false;
        try { held = !!this._externalHold?.(); } catch (e) {}
        if (!this._fsShown) {
            if (py <= 2 && near && !Main.overview.visible)
                this._fsSet(true);
        } else if (Main.overview.visible ||
                   (!held && (py > this.y + this.height + 40 || !near))) {
            this._fsSet(false);
        }
    },

    _fsRestore() {
        if (this._fsPoll) {
            GLib.source_remove(this._fsPoll);
            this._fsPoll = 0;
        }
        if (this._fsHidden) {
            this.remove_transition('opacity');
            this.ease({ opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            this.reactive = this._fsReactive ?? true;
        }
        this._fsHidden = false;
        this._fsShown = false;
    },

    // ---------------------------------------------------------------- stop recording

    _recUpdate() {
        let on = !this._destroyed && this._config.isFeatureEnabled('stopRecButton') &&
            Main.screenshotUI?.screencast_in_progress && !Main.layoutManager.panelBox.visible;
        if (on && !this._recBtn) {
            this._recBtn = new St.Button({
                style_class: 'notchnux-rec-stop', reactive: true, can_focus: true, track_hover: true,
                label: '⏹  Stop registrazione',
            });
            this._recBtn.connect('clicked', () => Main.screenshotUI.stopScreencast());
            Main.layoutManager.addTopChrome(this._recBtn, { trackFullscreen: false });
            this._recTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._recPlace();
                return GLib.SOURCE_CONTINUE;
            });
            this._recPlace();
        } else if (!on && this._recBtn) {
            this._recRemove();
        }
    },

    _recPlace() {
        let b = this._recBtn, m = Main.layoutManager.primaryMonitor;
        if (!b || !m)
            return;
        let x = this.x + this.width + 8;
        b.set_position(Math.round(Math.min(x, m.x + m.width - b.width - 4)), m.y + 6);
        Main.layoutManager.uiGroup.set_child_above_sibling(b, null);
    },

    _recRemove() {
        if (this._recTimer) {
            GLib.source_remove(this._recTimer);
            this._recTimer = 0;
        }
        if (this._recBtn) {
            Main.layoutManager.removeChrome(this._recBtn);
            this._recBtn.destroy();
            this._recBtn = null;
        }
    },

    // ---------------------------------------------------------------- banners

    // With the top bar hidden the notch sits where GNOME's banners appear:
    // push them just below it. Restored when the bar comes back.
    _bannerUpdate() {
        let bin = Main.messageTray?._bannerBin;
        if (!bin)
            return;
        bin.translation_y = Main.layoutManager.panelBox.visible
            ? (this._bannerMargin ?? 0) : BANNER_OFFSET;
    },

    // Called from _raiseToTop: keep the message tray right above the notch.
    _bannerAbove() {
        let tray = Main.messageTray;
        let parent = this.get_parent();
        if (tray && parent && tray.get_parent() === parent)
            parent.set_child_above_sibling(tray, this);
    },
};

export function installAninux(proto) {
    for (let [name, fn] of Object.entries(AninuxFeatures))
        proto[name] = fn;
}
