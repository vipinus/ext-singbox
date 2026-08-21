import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    accountOf,
    maskAccount,
    buildSingBoxConfig,
    describeProcessFailure,
    format,
    isValidRemoteConfig,
    parseLinks,
    sortLinks,
} from './lib/config.js';
import {fetchText, shutdownFetch} from './lib/fetch.js';

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
        this._refreshCancellable = null;
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
            this._onChanged();
            return;
        }

        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            GLib.unlink(configPath);
            Main.notify(APP_NAME, format(_('Could not start the sing-box backend: %s'), error.message));
            this._onChanged();
            return;
        }

        this._process = process;
        this.activeLink = link;
        this._onChanged();
        Main.notify(APP_NAME, format(_('Connecting to %s'), link.name));

        process.communicate_utf8_async(null, null, (_source, result) =>
            this._onProcessExited(process, link, result));

        if (link.kind === 'profile') this._refreshProfile(link);
    }

    /**
     * Update a subscription's cached configuration for next time.
     *
     * Deliberately silent: the token behind the URL is only valid for 24 hours
     * by design, so a failed refresh is the expected steady state once it
     * lapses, while the credentials already cached keep working. Warning about
     * it every connect would be a permanent false alarm.
     *
     * The result never touches the running process — a silent reconnect is
     * behaviour no user could explain.
     */
    _refreshProfile(link) {
        this._refreshCancellable?.cancel();
        this._refreshCancellable = new Gio.Cancellable();

        fetchText(link.url, this._refreshCancellable, (text, error) => {
            // cancel() cannot stop a request that already finished and whose
            // callback is sitting in the main loop. Without this guard that
            // callback can still write dconf after destroy(), i.e. after
            // gnome-shell has disabled the extension.
            if (!this._settings) return;
            if (error !== null) return;

            const result = isValidRemoteConfig(text);
            if (!result.ok) return;

            const links = parseLinks(this._settings.get_string('links'));
            const index = links.findIndex(item => item.id === link.id);
            // The entry may have been deleted while the request was in flight.
            if (index === -1) return;

            links[index] = {
                ...links[index],
                config: result.config,
                fetchedAt: GLib.DateTime.new_now_utc().format_iso8601(),
            };
            this._settings.set_string('links', JSON.stringify(links));
        });
    }

    stop() {
        if (!this._process) return;

        // Deliberately does not cancel _refreshCancellable: the refresh is
        // independent of the running process by design, and letting it finish
        // caches a fresher configuration for next time. destroy() does cancel
        // it, because that is the case where gnome-shell itself is going away.
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
        this._refreshCancellable?.cancel();
        this._refreshCancellable = null;
        shutdownFetch();
        // Marks the manager dead for the in-flight refresh callback above.
        this._settings = null;

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
        if (!config) throw new Error(_('This subscription has no cached configuration yet'));

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
            subtitle: _('Off'),
            gicon: icon,
            toggleMode: true,
        });

        this._icon = icon;
        this._extension = extension;
        this._settings = settings;
        this._vpn = vpn;

        this.menu.setHeader(this._icon, APP_NAME, _('Off'));

        this._linksSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._linksSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 只读状态行，对应 tor-ext 菜单里的 Circuit 行。
        // reactive:false 之外还要 can_focus=false：只关掉 reactive 的话它仍会
        // 接收键盘焦点，看上去像个能点却点不动的条目。
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.can_focus = false;
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const preferences = new PopupMenu.PopupMenuItem(_('Preferences…'));
        preferences.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(preferences);

        this._clickedId = this.connect('clicked', () => this._onClicked());

        this.rebuildMenu();
    }

    rebuildMenu() {
        this._linksSection.removeAll();

        const links = sortLinks(parseLinks(this._settings.get_string('links')));
        const active = this._vpn.activeLink;

        // On/Off 是 GNOME 快捷设置磁贴的通用说法（蓝牙、Wi-Fi、tor-ext 都用它），
        // 比原来的 Not connected 更贴合这个控件的语境。
        const status = active ? format(_('On · %s'), active.name) : _('Off');
        this.subtitle = status;
        this.checked = Boolean(active);
        this.menu.setHeader(this._icon, APP_NAME, status);
        this._statusItem.label.text = format(_('Status: %s'), status);

        if (links.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No connections yet, click to import'));
            empty.connect('activate', () => this._openPreferences());
            this._linksSection.addMenuItem(empty);
            return;
        }

        // 服务器收进子菜单，而不是平铺。
        //
        // 最初是平铺的——当时列表里只有两三条，子菜单等于给最常用的操作多加一次
        // 点击。批量导入上线后一次就是 24 条，平铺直接撑出屏幕，看不到底下的
        // 状态行和首选项。这是 tor-ext 用子菜单装 50 个国家的同一个理由。
        const submenu = new PopupMenu.PopupSubMenuMenuItem(
            format(_('Server: %s'), active ? active.name : _('None')));

        // ⚠️ 高度封顶必须连同 _needsScrollbar 一起覆盖。
        // gnome-shell 的 PopupSubMenu._needsScrollbar() 读的是**顶层菜单**的
        // theme node 的 max-height，所以只给子菜单 actor 设 max-height 会被无视，
        // vscrollbar_policy 停在 NEVER，内容照样溢出。改成读子菜单自己的
        // max-height 与内部 box 的自然高度，open() 才会把 ScrollView 切到
        // AUTOMATIC。这段照搬自 tor-ext 的 ui/quickToggle.js，它踩过同一个坑。
        submenu.menu.actor.set_style('max-height: 20em;');
        submenu.menu._needsScrollbar = function () {
            const [, natural] = this.box.get_preferred_height(-1);
            const maxHeight = this.actor.get_theme_node().get_max_height();
            return maxHeight >= 0 && natural >= maxHeight;
        };

        links.forEach(link => {
            const item = new PopupMenu.PopupMenuItem(`${link.flag || '🔗'}  ${link.name}`);
            if (active?.id === link.id) item.setOrnament(PopupMenu.Ornament.CHECK);

            // 每条显示它属于哪个订阅账号。同时用两个账号时，光看地区名分不清
            // 自己连的是谁的额度；打码是因为完整邮箱没必要长期挂在屏幕上。
            // 手工加的分享链接没有缓存配置，取不到账号，就不显示。
            const account = accountOf(link);
            if (account) {
                item.add_child(new St.Label({
                    text: maskAccount(account),
                    style: 'font-size: 0.8em; opacity: 0.55; margin-left: 12px;',
                    x_align: Clutter.ActorAlign.END,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            item.connect('activate', () => this._vpn.toggle(link));
            submenu.menu.addMenuItem(item);
        });

        this._linksSection.addMenuItem(submenu);
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
