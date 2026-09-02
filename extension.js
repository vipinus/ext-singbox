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
    format,
    isValidRemoteConfig,
    parseLinks,
    sortLinks,
} from './lib/config.js';
import {fetchText, shutdownFetch} from './lib/fetch.js';
import {SingBoxService, UNIT, removeConfig, writeConfig} from './lib/singboxService.js';

const SCHEMA = 'org.gnome.shell.extensions.gname-shell-extension-singbox';

// 通知与磁贴上的显示名。生成的配置放在哪由 lib/singboxService.js 决定，
// 那个路径是和 systemd 单元之间的契约，与这个标签无关。
const APP_NAME = 'Sing-box';

function loadSingBoxIcon(extensionPath) {
    return new Gio.FileIcon({
        file: Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'icons', 'singbox-symbolic.svg'])),
    });
}

/**
 * 连接的状态机：写配置、启停 systemd 用户单元、把单元状态翻译回菜单。
 *
 * 扩展自己不起任何进程。sing-box 由 systemd 的用户实例托管
 * （systemd/singbox-ext.service，install.sh 装到 ~/.config/systemd/user/），
 * 这里只通过会话总线发 StartUnit/StopUnit，并订阅 ActiveState。
 * 同一时刻只有一条连接，因为只有一个单元、一份配置文件。
 */
class SingBoxVpnManager {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._refreshCancellable = null;
        this.activeLink = null;

        // 切换服务器要重启单元，中间必然经过 deactivating/inactive。那不是
        // 「断开了」，照着报会弹一条莫名其妙的断开通知、磁贴还闪一下。
        // 这个闸门挡住启动期间的中间态，看到 active 或 failed 才落闸；
        // 用户自己点停也会直接把它清掉。
        this._starting = false;
        this._restartInterlude = false;

        this._service = new SingBoxService();
        this._activeChangedId = this._service.connect(
            'active-changed', (_service, state) => this._onUnitState(state));

        this._syncFromUnit();
    }

    /**
     * 扩展重新加载时，单元可能还在跑——后端归 systemd 管，活得比扩展久。
     * 磁贴要如实显示这一点，否则用户看到「Off」而流量其实还在隧道里。
     * 连的是哪一条只能从 last-link-id 还原，那正是它被记下来的原因之一。
     */
    _syncFromUnit() {
        this._service.state().then(state => {
            // destroy() 之后回调才回来：什么都别做。
            if (!this._settings) return;
            if (state !== 'active' && state !== 'activating') return;

            const links = parseLinks(this._settings.get_string('links'));
            const last = this._settings.get_string('last-link-id');
            // 认不出是哪条（条目被删了）时保持 Off——宁可少说，也不要在菜单上
            // 打一个对不上任何条目的勾。用户点一下开关就能收敛。
            this.activeLink = links.find(link => link.id === last) ?? null;
            this._onChanged();
        }).catch(() => {});
    }

    toggle(link) {
        if (this.activeLink?.id === link.id) {
            this.stop();
            return;
        }
        this.start(link);
    }

    start(link) {
        this._start(link).catch(error => {
            this._starting = false;
            this._restartInterlude = false;
            removeConfig();
            Main.notify(APP_NAME, error.message);
            this._onChanged();
        });
    }

    async _start(link) {
        // 单元没装的时候必须说人话：D-Bus 那边只会回一句
        // 「Unit singbox-ext.service not found.」，用户看了不知道该干什么。
        if (!await this._service.isInstalled())
            throw new Error(_('The sing-box backend service is not installed yet: run install.sh from the project once'));

        // A profile carries a whole configuration from the provider; a share
        // link only describes one node, so we generate the rest ourselves.
        const config = link.kind === 'profile' ? link.config : buildSingBoxConfig(link.url);
        if (!config)
            throw new Error(_('This subscription has no cached configuration yet'));

        // isRunning() 而不是「state === active」：换服务器时单元可能正处在
        // activating，那时发 StartUnit 会被并进正在进行的启动任务里，而配置
        // 文件已经被覆盖成新的一条——跑着的是旧节点，界面显示的是新节点。
        const running = await this._service.isRunning();
        try {
            writeConfig(config);
        } catch (error) {
            throw new Error(format(_('Could not generate the configuration: %s'), error.message));
        }

        this._starting = true;
        // RestartUnit 必然经过一次 inactive，那是中间态不是「断开了」。
        // 只放过这一次：之后再看到 inactive 就是后端自己退了，得如实报出去，
        // 否则磁贴会卡在 On 上。用「发的是哪个动词」来判定，比事后回查状态确定。
        this._restartInterlude = running;
        try {
            // 已经在跑就得重启：配置是同一个文件路径，sing-box 只在启动时读一次。
            await (running ? this._service.restart() : this._service.start());
        } catch (error) {
            throw new Error(format(_('Could not start the sing-box backend: %s'), error.message));
        }

        this.activeLink = link;
        // 记下这次连的是哪条：磁贴开关在未连接时要连回它，扩展重新加载后也靠它
        // 认出还在跑的是哪条。写在这里而不是 toggle()：只有真发出了启动请求才算。
        this._settings?.set_string('last-link-id', link.id);
        this._onChanged();
        Main.notify(APP_NAME, format(_('Connecting to %s'), link.name));

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
     * The result never touches the running service — a silent reconnect is
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
        // Deliberately does not cancel _refreshCancellable: the refresh is
        // independent of the running service by design, and letting it finish
        // caches a fresher configuration for next time. destroy() does cancel
        // it, because that is the case where gnome-shell itself is going away.
        const stopped = this.activeLink;
        if (!stopped) return;

        this._starting = false;
        this._restartInterlude = false;
        this.activeLink = null;
        this._onChanged();

        this._service.stop().then(() => {
            removeConfig();
            Main.notify(APP_NAME, format(_('%s disconnected'), stopped.name));
        }).catch(error => {
            Main.notify(APP_NAME,
                format(_('Could not stop the sing-box backend: %s'), error.message));
        });
    }

    /**
     * 单元自己变了状态。
     *
     * A backend that dies on its own is either a clean shutdown or a startup
     * failure; the latter has to reach the user, because the only other trace
     * of it is the journal.
     */
    _onUnitState(state) {
        if (this._starting) {
            if (state === 'active') {
                this._starting = false;
                this._restartInterlude = false;
            } else if (state === 'failed') {
                this._onStopped(true);
            } else if (state === 'inactive') {
                // 换服务器时 RestartUnit 的那一次中间态，放过；再有一次就是
                // 后端自己退了。
                if (this._restartInterlude) this._restartInterlude = false;
                else this._onStopped(false);
            }
            return;
        }

        if (state === 'failed') this._onStopped(true);
        else if (state === 'inactive') this._onStopped(false);
    }

    _onStopped(failed) {
        this._starting = false;
        this._restartInterlude = false;

        // stop() 已经清过场并会自己发通知，这里就没事可做了。
        const link = this.activeLink;
        if (!link) return;

        this.activeLink = null;
        removeConfig();
        this._onChanged();

        if (!failed) {
            Main.notify(APP_NAME, format(_('%s disconnected'), link.name));
            return;
        }

        // 拿不到 sing-box 的 stderr 了——它现在是 systemd 的子进程，日志进了
        // journal。与其猜，不如把查日志的那条命令原样给出来。
        Main.notify(APP_NAME, format(
            _('%s stopped unexpectedly. Run journalctl --user -u %s to see why'),
            link.name, UNIT));
    }

    destroy() {
        this._refreshCancellable?.cancel();
        this._refreshCancellable = null;
        shutdownFetch();
        // Marks the manager dead for the in-flight refresh callback above.
        this._settings = null;

        if (this._activeChangedId) {
            this._service.disconnect(this._activeChangedId);
            this._activeChangedId = 0;
        }
        // 刻意不停单元、也不删配置：后端归 systemd 管，禁用扩展或重启
        // gnome-shell 不该掐掉用户正在用的连接（还在跑的 sing-box 也不需要
        // 配置文件被抽走）。要断开就点磁贴，或者
        // systemctl --user stop singbox-ext.service。
        this._service.destroy();
        this._service = null;
        this.activeLink = null;
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
        // 标题显示的是「点磁贴会连哪条」：连接中就是当前那条，未连接则是上次那条。
        // 未连接时显示「未选择」是不诚实的——磁贴明明有确定的目标。
        const target = active || this._preferredLink(links);
        const submenu = new PopupMenu.PopupSubMenuMenuItem(
            format(_('Server: %s'), target ? target.name : _('None')));

        // ⚠️ 高度封顶必须连同 _needsScrollbar 一起覆盖。
        // gnome-shell 的 PopupSubMenu._needsScrollbar() 读的是**顶层菜单**的
        // theme node 的 max-height，所以只给子菜单 actor 设 max-height 会被无视，
        // vscrollbar_policy 停在 NEVER，内容照样溢出。改成读子菜单自己的
        // max-height 与内部 box 的自然高度，open() 才会把 ScrollView 切到
        // AUTOMATIC。这段照搬自 tor-ext 的 ui/quickToggle.js，它踩过同一个坑。
        submenu.menu._needsScrollbar = function () {
            const [, natural] = this.box.get_preferred_height(-1);
            const maxHeight = this.actor.get_theme_node().get_max_height();
            return maxHeight >= 0 && natural >= maxHeight;
        };

        // 高度按屏幕实际可用空间算，而不是写死一个 em 值。
        //
        // 写死 20em 在这台屏幕上仍然溢出：可用高度取决于分辨率、缩放、面板与
        // dock 占掉多少，以及这个菜单被拉开时它自己在屏幕上的位置——没有哪个
        // 常数能同时满足这些。改成量「这一行下沿到工作区底边」还剩多少。
        this._fitSubmenu(submenu);
        // rebuildMenu 每次改动都会重跑，旧的信号必须先断开：否则每次重建都多挂
        // 一个回调，而它们还各自抓着已经销毁的 submenu 不放。
        if (this._submenuOpenId) this.menu.disconnect(this._submenuOpenId);
        this._submenuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._fitSubmenu(submenu);
        });

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

    /**
     * 给服务器子菜单定一个不会溢出屏幕的高度上限。
     *
     * 量的是「子菜单那一行的下沿」到「工作区底边」之间还剩多少，再留一点边距。
     * 工作区而非屏幕高度：面板和 dock 占掉的部分不能算进去。
     *
     * 拿不到位置时（菜单还没分配布局）退回一个保守的固定值——宁可短一点，
     * 也不要溢出到屏幕外让用户看不到底下的条目。
     */
    _fitSubmenu(submenu) {
        const FALLBACK = 320;
        const MARGIN = 24;
        const MIN = 120;

        let available = FALLBACK;
        try {
            const actor = submenu.actor ?? submenu;
            const [, y] = actor.get_transformed_position();
            const monitor = Main.layoutManager.findMonitorForActor(actor)
                ?? Main.layoutManager.primaryMonitor;
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            const rowHeight = actor.get_height() || 0;
            const bottom = workArea.y + workArea.height;
            // Number.isFinite 挡住未分配布局时的 NaN——那会让 max-height 变成
            // "NaNpx"，St 解析失败后等于没有上限，症状正是溢出。
            const computed = bottom - y - rowHeight - MARGIN;
            if (Number.isFinite(computed)) available = computed;
        } catch (_error) {
            // 量不到就用保守值，不让这里的异常影响菜单本身
        }

        submenu.menu.actor.set_style(`max-height: ${Math.max(MIN, Math.round(available))}px;`);
    }

    /**
     * 点磁贴开关时该连哪条：上次连过的那条，其次才是列表第一条。
     *
     * 没有这个的话，导入 24 个地区之后点磁贴永远连排序最靠前的那个（澳大利亚），
     * 而用户想要的几乎总是上次那条。记住的条目被删掉时自动回落。
     */
    _preferredLink(links) {
        const last = this._settings.get_string('last-link-id');
        return links.find(link => link.id === last) || links[0] || null;
    }

    _onClicked() {
        if (this._vpn.activeLink) {
            this._vpn.stop();
            return;
        }

        const links = sortLinks(parseLinks(this._settings.get_string('links')));
        const target = this._preferredLink(links);
        if (target) {
            this._vpn.start(target);
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
        if (this._submenuOpenId) {
            this.menu.disconnect(this._submenuOpenId);
            this._submenuOpenId = 0;
        }
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
