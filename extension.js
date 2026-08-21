import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    buildSingBoxConfig,
    describeProcessFailure,
    format,
    parseLinks,
    sortLinks,
} from './lib/config.js';

const SCHEMA = 'org.gnome.shell.extensions.gname-shell-extension-singbox';

// Display name. The cache directory below deliberately keeps upstream's
// lowercase spelling, because it is a path rather than a label.
const APP_NAME = 'Sing-box';

function loadSingBoxIcon(extensionPath) {
    return new Gio.FileIcon({
        file: Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'icons', 'singbox-symbolic.svg'])),
    });
}

/**
 * Owns the sing-box child process and the generated configuration that
 * belongs to it. At most one connection is active at a time.
 */
class SingBoxVpnManager {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._process = null;
        this.activeLink = null;
    }

    toggle(link) {
        if (this.activeLink?.id === link.id) {
            this.stop();
            return;
        }
        this.start(link);
    }

    start(link) {
        this.stop();

        let argv;
        let configPath;
        try {
            const [, command] = GLib.shell_parse_argv(this._settings.get_string('backend-command'));
            configPath = this._writeConfig(link);
            argv = [...command, configPath];
        } catch (error) {
            if (configPath) GLib.unlink(configPath);
            Main.notify(APP_NAME, format(_('Could not generate the configuration: %s'), error.message));
            return;
        }

        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            GLib.unlink(configPath);
            Main.notify(APP_NAME, format(_('Could not start the sing-box backend: %s'), error.message));
            return;
        }

        this._process = process;
        this.activeLink = link;
        this._onChanged();
        Main.notify(APP_NAME, format(_('Connecting to %s'), link.name));

        process.communicate_utf8_async(null, null, (_source, result) =>
            this._onProcessExited(process, link, result));
    }

    stop() {
        if (!this._process) return;

        const stoppedLink = this.activeLink;
        try {
            this._process.send_signal(15);
        } catch (_error) {
            // The process is already gone.
        }
        this._process = null;
        this.activeLink = null;
        if (stoppedLink) this._removeConfig(stoppedLink);
        this._onChanged();
    }

    destroy() {
        if (this._process) {
            try {
                this._process.force_exit();
            } catch (_error) {
                // The process is already gone.
            }
        }
        if (this.activeLink) this._removeConfig(this.activeLink);
        this._process = null;
        this.activeLink = null;
    }

    _writeConfig(link) {
        const directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'sing-box']);
        GLib.mkdir_with_parents(directory, 0o700);
        const path = GLib.build_filenamev([directory, `${link.id}.json`]);

        // A profile carries a whole configuration from the provider; a share
        // link only describes one node, so we generate the rest ourselves.
        const config = link.kind === 'profile' ? link.config : buildSingBoxConfig(link.url);
        if (!config) throw new Error('This subscription has no cached configuration yet');

        GLib.file_set_contents(path, JSON.stringify(config, null, 2));
        GLib.chmod(path, 0o600);
        return path;
    }

    _removeConfig(link) {
        GLib.unlink(GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'sing-box', `${link.id}.json`]));
    }

    /**
     * A backend that dies on its own is either a clean shutdown or a startup
     * failure; the latter has to reach the user, because the only other trace
     * of it is the journal.
     */
    _onProcessExited(process, link, result) {
        let stderr = '';
        try {
            [, , stderr] = process.communicate_utf8_finish(result);
        } catch (_error) {
            // Reading the output failed; the exit status still tells us enough.
        }

        // stop() already cleaned up and notified for a user-requested shutdown.
        if (this._process !== process) return;

        this._process = null;
        this.activeLink = null;
        this._removeConfig(link);
        this._onChanged();

        if (process.get_successful()) {
            Main.notify(APP_NAME, format(_('%s disconnected'), link.name));
            return;
        }

        Main.notify(
            APP_NAME,
            format(_('%s stopped: %s'),
                link.name,
                describeProcessFailure(stderr, _('sing-box exited unexpectedly'))));
    }
}

const SingBoxToggle = GObject.registerClass(
class SingBoxToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, settings, vpn) {
        const icon = loadSingBoxIcon(extension.path);
        super._init({
            title: APP_NAME,
            subtitle: _('Not connected'),
            gicon: icon,
            toggleMode: true,
        });

        this._icon = icon;
        this._extension = extension;
        this._settings = settings;
        this._vpn = vpn;

        this.menu.setHeader(this._icon, APP_NAME, _('Not connected'));

        this._linksSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._linksSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const preferences = new PopupMenu.PopupMenuItem(_('Open control panel'));
        preferences.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(preferences);

        this._clickedId = this.connect('clicked', () => this._onClicked());

        this.rebuildMenu();
    }

    rebuildMenu() {
        this._linksSection.removeAll();

        const links = sortLinks(parseLinks(this._settings.get_string('links')));
        const active = this._vpn.activeLink;

        this.subtitle = active ? active.name : _('Not connected');
        this.checked = Boolean(active);
        this.menu.setHeader(this._icon, APP_NAME, this.subtitle);

        if (links.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No connections yet, click to import'));
            empty.connect('activate', () => this._openPreferences());
            this._linksSection.addMenuItem(empty);
            return;
        }

        links.forEach(link => {
            const item = new PopupMenu.PopupMenuItem(`${link.flag || '🔗'}  ${link.name}`);
            if (active?.id === link.id) item.setOrnament(PopupMenu.Ornament.CHECK);
            item.connect('activate', () => this._vpn.toggle(link));
            this._linksSection.addMenuItem(item);
        });
    }

    _onClicked() {
        if (this._vpn.activeLink) {
            this._vpn.stop();
            return;
        }

        const links = sortLinks(parseLinks(this._settings.get_string('links')));
        if (links.length > 0) {
            this._vpn.start(links[0]);
            return;
        }

        Main.notify(APP_NAME, _('No connections available, import one first'));
        this._openPreferences();
    }

    _openPreferences() {
        this._extension.openPreferences();
        Main.panel.statusArea.quickSettings.menu.close();
    }

    destroy() {
        if (this._clickedId) {
            this.disconnect(this._clickedId);
            this._clickedId = 0;
        }
        super.destroy();
    }
});

const SingBoxIndicator = GObject.registerClass(
class SingBoxIndicator extends QuickSettings.SystemIndicator {
    _init(extension, settings, vpn) {
        super._init();

        this._topIcon = this._addIndicator();
        this._topIcon.gicon = loadSingBoxIcon(extension.path);
        this._topIcon.visible = false;

        this._toggle = new SingBoxToggle(extension, settings, vpn);
        this.quickSettingsItems.push(this._toggle);

        this._syncIndicator();
        this._notifyCheckedId = this._toggle.connect(
            'notify::checked', () => this._syncIndicator());
    }

    rebuildMenu() {
        this._toggle.rebuildMenu();
        this._syncIndicator();
    }

    _syncIndicator() {
        this._topIcon.visible = this._toggle.checked;
    }

    destroy() {
        if (this._notifyCheckedId) {
            this._toggle.disconnect(this._notifyCheckedId);
            this._notifyCheckedId = 0;
        }
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});

export default class SingBoxExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA);
        this._vpn = new SingBoxVpnManager(this._settings, () => this._indicator?.rebuildMenu());
        this._indicator = new SingBoxIndicator(this, this._settings, this._vpn);

        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._settingsChangedId = this._settings.connect(
            'changed::links', () => this._indicator?.rebuildMenu());
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;

        this._vpn?.destroy();
        this._vpn = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}
