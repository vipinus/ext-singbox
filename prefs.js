import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import ExtensionPreferences from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMA = 'org.gnome.shell.extensions.gname-shell-extension-singbox';
const COUNTRY_ORDER = ['🇭🇰', '🇸🇬', '🇯🇵', '🇰🇷', '🇺🇸', '🇬🇧', '🇩🇪', '🇫🇷', '🇨🇦', '🇦🇺'];

function readLinks(settings) {
    try {
        const links = JSON.parse(settings.get_string('links'));
        return Array.isArray(links) ? links : [];
    } catch (_) {
        return [];
    }
}

function saveLinks(settings, links) {
    settings.set_string('links', JSON.stringify(links));
}

const LinkRow = GObject.registerClass(
class LinkRow extends Adw.ActionRow {
    _init(link, onDelete) {
        super._init({title: `${link.flag || '🔗'}  ${link.name}`, subtitle: link.url, activatable: false});
        const deleteButton = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: '删除连接'});
        deleteButton.add_css_class('flat');
        deleteButton.connect('clicked', onDelete);
        this.add_suffix(deleteButton);
    }
});

export default class RingBoxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 640);
        const settings = this.getSettings(SCHEMA);

        const page = new Adw.PreferencesPage({title: 'sing-box', icon_name: 'network-vpn-symbolic'});
        const intro = new Adw.PreferencesGroup({title: '连接列表', description: '通过 URL 或二维码导入 sing-box 连接，列表按国家/地区排序。'});
        const rows = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        rows.add_css_class('boxed-list');
        intro.add(rows);

        const importGroup = new Adw.PreferencesGroup({title: '导入连接'});
        const urlEntry = new Gtk.Entry({placeholder_text: '粘贴 vless://、vmess://、trojan://、ss:// 或 hysteria2://', hexpand: true});
        const nameEntry = new Gtk.Entry({placeholder_text: '名称，例如 Tokyo 01', hexpand: true});
        const flagDrop = new Gtk.DropDown({model: Gtk.StringList.new(COUNTRY_ORDER)});
        flagDrop.set_tooltip_text('选择连接国家或地区');
        const urlRow = new Adw.ActionRow({title: '连接 URL'});
        urlRow.add_suffix(urlEntry);
        const nameRow = new Adw.ActionRow({title: '连接名称'});
        nameRow.add_suffix(nameEntry);
        const flagRow = new Adw.ActionRow({title: '国家/地区'});
        flagRow.add_suffix(flagDrop);
        importGroup.add(urlRow);
        importGroup.add(nameRow);
        importGroup.add(flagRow);

        const importButton = new Gtk.Button({label: '导入 URL', icon_name: 'list-add-symbolic', halign: Gtk.Align.END});
        importButton.add_css_class('suggested-action');
        const qrButton = new Gtk.Button({label: '从二维码图片导入', icon_name: 'camera-photo-symbolic', halign: Gtk.Align.END});
        const buttonRow = new Adw.ActionRow();
        buttonRow.add_suffix(qrButton);
        buttonRow.add_suffix(importButton);
        importGroup.add(buttonRow);

        const backendGroup = new Adw.PreferencesGroup({
            title: 'TUN 后端',
            description: '启动连接时，扩展会生成 sing-box TUN 配置并传给此命令。需要 sing-box 具备创建 TUN 和修改路由的权限。',
        });
        const backendEntry = new Gtk.Entry({text: settings.get_string('backend-command'), hexpand: true});
        backendEntry.connect('changed', entry => settings.set_string('backend-command', entry.text));
        const backendRow = new Adw.ActionRow({title: '启动命令'});
        backendRow.add_suffix(backendEntry);
        backendGroup.add(backendRow);

        const toast = message => window.add_toast(new Adw.Toast({title: message, timeout: 3}));
        const refresh = () => {
            while (rows.get_first_child()) rows.remove(rows.get_first_child());
            const links = readLinks(settings).sort((a, b) => COUNTRY_ORDER.indexOf(a.flag) - COUNTRY_ORDER.indexOf(b.flag));
            links.forEach(link => rows.append(new LinkRow(link, () => {
                saveLinks(settings, readLinks(settings).filter(item => item.id !== link.id));
                refresh();
                toast('连接已删除');
            })));
            if (!links.length) {
                const empty = new Adw.ActionRow({title: '暂无连接', subtitle: '在下方粘贴 URL，或选择二维码图片'});
                rows.append(empty);
            }
        };

        const addUrl = url => {
            const value = url.trim();
            if (!value || !/^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//.test(value)) {
                toast('请输入有效的 sing-box 分享链接');
                return;
            }
            const links = readLinks(settings);
            links.push({id: GLib.uuid_string_random(), name: nameEntry.text.trim() || '未命名连接', flag: COUNTRY_ORDER[flagDrop.selected] || '🔗', url: value});
            saveLinks(settings, links);
            urlEntry.text = '';
            nameEntry.text = '';
            refresh();
            toast('连接已导入');
        };
        importButton.connect('clicked', () => addUrl(urlEntry.text));

        qrButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: '选择二维码图片'});
            dialog.open(window, null, (source, result) => {
                try {
                    const file = source.open_finish(result);
                    const path = file.get_path();
                    const [, stdout, , status] = GLib.spawn_command_line_sync(`zbarimg --quiet ${GLib.shell_quote(path)}`);
                    if (status === 0 && stdout) addUrl(new TextDecoder().decode(stdout).split('\n')[0].replace(/^QR-Code:/, ''));
                    else toast('未检测到二维码，请安装 zbarimg');
                } catch (error) {
                    if (!error.matches?.(Gtk.dialog_error_quark?.() ?? 0, Gtk.DialogError.DISMISSED)) toast('二维码导入已取消');
                }
            });
        });

        page.add(intro);
        page.add(importGroup);
        page.add(backendGroup);
        window.add(page);
        refresh();
    }
}