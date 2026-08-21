import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SCHEMA = 'org.gnome.shell.extensions.gname-shell-extension-singbox';

const COUNTRY_ORDER = ['🇭🇰', '🇸🇬', '🇯🇵', '🇰🇷', '🇺🇸', '🇬🇧', '🇩🇪', '🇫🇷', '🇨🇦', '🇦🇺'];

function decodeBase64(value) {
    return new TextDecoder().decode(GLib.base64_decode(value.replace(/-/g, '+').replace(/_/g, '/')));
}

function buildSingBoxConfig(uri) {
    const parsed = new URL(uri);
    const server = parsed.hostname;
    const serverPort = Number(parsed.port || 443);
    const tls = parsed.searchParams.get('security') === 'tls' || parsed.protocol === 'trojan:' || parsed.protocol === 'hysteria2:' || parsed.protocol === 'hy2:';
    const tlsConfig = tls ? {enabled: true, server_name: parsed.searchParams.get('sni') || server, insecure: parsed.searchParams.get('allowInsecure') === '1'} : undefined;
    let outbound;

    if (parsed.protocol === 'vless:') {
        outbound = {type: 'vless', tag: 'proxy', server, server_port: serverPort, uuid: decodeURIComponent(parsed.username)};
        if (tlsConfig) outbound.tls = tlsConfig;
    } else if (parsed.protocol === 'trojan:') {
        outbound = {type: 'trojan', tag: 'proxy', server, server_port: serverPort, password: decodeURIComponent(parsed.username), tls: tlsConfig};
    } else if (parsed.protocol === 'hysteria2:' || parsed.protocol === 'hy2:') {
        outbound = {type: 'hysteria2', tag: 'proxy', server, server_port: serverPort, password: decodeURIComponent(parsed.username), tls: tlsConfig};
    } else if (parsed.protocol === 'ss:') {
        const credentials = parsed.password
            ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
            : decodeBase64(parsed.username || parsed.pathname.slice(1));
        const separator = credentials.indexOf(':');
        if (separator < 1) throw new Error('SS 链接缺少加密方式或密码');
        outbound = {type: 'shadowsocks', tag: 'proxy', server, server_port: serverPort, method: credentials.slice(0, separator), password: credentials.slice(separator + 1)};
    } else if (parsed.protocol === 'vmess:') {
        const data = JSON.parse(decodeBase64(parsed.pathname.slice(1)));
        outbound = {type: 'vmess', tag: 'proxy', server: data.add, server_port: Number(data.port), uuid: data.id, security: data.scy || 'auto'};
        if (data.tls === 'tls') outbound.tls = {enabled: true, server_name: data.sni || data.host || data.add};
        if (data.net === 'ws') outbound.transport = {type: 'ws', path: data.path || '/', headers: data.host ? {Host: data.host} : undefined};
    } else {
        throw new Error('暂不支持此分享链接格式');
    }

    return {
        log: {level: 'warn'},
        dns: {servers: [{tag: 'remote', address: 'https://1.1.1.1/dns-query', detour: 'proxy'}], final: 'remote', strategy: 'prefer_ipv4'},
        inbounds: [{type: 'tun', tag: 'tun-in', interface_name: 'singbox0', address: ['172.19.0.1/30'], auto_route: true, strict_route: true, stack: 'mixed'}],
        outbounds: [outbound, {type: 'direct', tag: 'direct'}, {type: 'block', tag: 'block'}],
        route: {auto_detect_interface: true, final: 'proxy', rules: [{action: 'sniff'}, {protocol: 'dns', action: 'hijack-dns'}]},
    };
}

function parseLinks(raw) {
    try {
        const links = JSON.parse(raw);
        return Array.isArray(links) ? links.filter(link => link && link.url) : [];
    } catch (_) {
        return [];
    }
}

function flagRank(flag) {
    const index = COUNTRY_ORDER.indexOf(flag);
    return index === -1 ? COUNTRY_ORDER.length : index;
}

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
            const [, parsed] = GLib.shell_parse_argv(this._settings.get_string('backend-command'));
            const configDirectory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'sing-box']);
            GLib.mkdir_with_parents(configDirectory, 0o700);
            configPath = GLib.build_filenamev([configDirectory, `${link.id}.json`]);
            GLib.file_set_contents(configPath, JSON.stringify(buildSingBoxConfig(link.url), null, 2));
            GLib.chmod(configPath, 0o600);
            argv = [...parsed, configPath];
        } catch (error) {
            if (configPath) GLib.unlink(configPath);
            Main.notify('sing-box', `后端命令无效：${error.message}`);
            return;
        }

        try {
            const process = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.NONE,
            });
            this._process = process;
            process.wait_async(null, (_process, result) => {
                try {
                    process.wait_finish(result);
                    if (this._process !== process) return;
                    const stoppedLink = this.activeLink;
                    this._process = null;
                    this.activeLink = null;
                    if (stoppedLink) this._removeConfig(stoppedLink);
                    this._onChanged();
                    if (stoppedLink) Main.notify('sing-box', `${stoppedLink.name} 已断开`);
                } catch (_) {
                    // The process was intentionally stopped during extension shutdown.
                }
            });
            this.activeLink = link;
            this._onChanged();
            Main.notify('sing-box', `正在连接 ${link.name}`);
        } catch (error) {
            if (configPath) GLib.unlink(configPath);
            this._process = null;
            Main.notify('sing-box', `无法启动 TUN 后端：${error.message}`);
        }
    }

    stop() {
        if (!this._process) return;
        const stoppedLink = this.activeLink;
        this._process.send_signal(15);
        this._process = null;
        this.activeLink = null;
        if (stoppedLink) this._removeConfig(stoppedLink);
        this._onChanged();
    }

    _removeConfig(link) {
        GLib.unlink(GLib.build_filenamev([GLib.get_user_cache_dir(), 'sing-box', `${link.id}.json`]));
    }

    destroy() {
        if (this._process) this._process.force_exit();
        if (this.activeLink) this._removeConfig(this.activeLink);
        this._process = null;
        this.activeLink = null;
    }
}

const RingBoxIndicator = GObject.registerClass(
class RingBoxIndicator extends PanelMenu.Button {
    _init(settings, vpn) {
        super._init(0.5, 'sing-box');
        this._settings = settings;
        this._vpn = vpn;
        this._settings.connect('changed::links', () => this._rebuildMenu());

        this._icon = new St.Icon({icon_name: 'network-vpn-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);
        this._rebuildMenu();
    }

    _links() {
        return parseLinks(this._settings.get_string('links')).sort((a, b) =>
            flagRank(a.flag) - flagRank(b.flag) || a.name.localeCompare(b.name));
    }

    _rebuildMenu() {
        this.menu.removeAll();
        const links = this._links();
        const header = new PopupMenu.PopupMenuItem('sing-box  ·  %d 个连接'.replace('%d', links.length), {reactive: false});
        header.label.add_style_class_name('singbox-menu-header');
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (!links.length) {
            const empty = new PopupMenu.PopupMenuItem('还没有连接，请在设置中导入', {reactive: false});
            empty.label.add_style_class_name('singbox-empty');
            this.menu.addMenuItem(empty);
        } else {
            const gridItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const grid = new St.BoxLayout({vertical: true, style_class: 'singbox-tile-grid'});
            for (let index = 0; index < links.length; index += 2) {
                const row = new St.BoxLayout({style_class: 'singbox-tile-row'});
                links.slice(index, index + 2).forEach(link => {
                    const tile = new St.Button({
                        style_class: `singbox-tile${this._vpn.activeLink?.id === link.id ? ' active' : ''}`,
                        can_focus: true,
                        track_hover: true,
                        accessible_name: link.name,
                    });
                    const content = new St.BoxLayout({vertical: true, style_class: 'singbox-tile-content'});
                    content.add_child(new St.Label({text: link.flag || '🔗', style_class: 'singbox-tile-flag'}));
                    content.add_child(new St.Label({text: link.name, style_class: 'singbox-tile-name'}));
                    tile.set_child(content);
                    tile.connect('clicked', () => this._openLink(link));
                    row.add_child(tile);
                });
                grid.add_child(row);
            }
            gridItem.add_child(grid);
            this.menu.addMenuItem(gridItem);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem('管理连接');
        prefs.connect('activate', () => {
            const app = Gio.AppInfo.get_default_for_uri_scheme('settings');
            app?.launch_uris(['settings://org.gnome.shell.extensions.gname-shell-extension-singbox'], null);
        });
        this.menu.addMenuItem(prefs);

        if (this._vpn.activeLink) {
            const stop = new PopupMenu.PopupMenuItem(`停止 ${this._vpn.activeLink.name}`);
            stop.connect('activate', () => this._vpn.stop());
            this.menu.addMenuItem(stop);
        }
    }

    _openLink(link) { this._vpn.toggle(link); }
});

export default class RingBoxExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA);
        this._vpn = new SingBoxVpnManager(this._settings, () => this._indicator?._rebuildMenu());
        this._indicator = new RingBoxIndicator(this._settings, this._vpn);
        Main.panel.addToStatusArea('singbox', this._indicator, 1, 'right');
    }

    disable() {
        this._vpn?.destroy();
        this._indicator?.destroy();
        this._indicator = null;
        this._vpn = null;
    }
}