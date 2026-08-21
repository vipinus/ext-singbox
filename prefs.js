import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    COUNTRY_ORDER,
    format,
    isRemoteProfileUrl,
    isSupportedUrl,
    isValidRemoteConfig,
    localeTag,
    parseRemoteProfileLink,
    regionKeyOf,
    subscriptionsUrl,
    sortLinks,
} from './lib/config.js';
import {fetchText} from './lib/fetch.js';

const SCHEMA = 'org.gnome.shell.extensions.gname-shell-extension-singbox';
const APP_NAME = 'Sing-box';

function readLinks(settings) {
    try {
        const links = JSON.parse(settings.get_string('links'));
        return Array.isArray(links) ? links : [];
    } catch (_error) {
        return [];
    }
}

function saveLinks(settings, links) {
    settings.set_string('links', JSON.stringify(links));
}

const LinkRow = GObject.registerClass(
class LinkRow extends Adw.ActionRow {
    // A stored profile URL is expected to be well-formed (it was fetched
    // successfully before being saved), but GLib.Uri.parse can still throw on
    // an edge case we did not anticipate; fall back to an empty subtitle
    // rather than breaking the whole list over one bad row.
    static _hostOf(url) {
        try {
            return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host();
        } catch (_error) {
            // A subscription URL carries a bearer token in its query string;
            // falling back to the raw URL would put that token on screen.
            return '';
        }
    }

    _init(link, onDelete) {
        const isProfile = link.kind === 'profile';
        const subtitle = isProfile
            ? `${_('Subscription')} · ${LinkRow._hostOf(link.url)}`
            : link.url || '';

        super._init({
            title: GLib.markup_escape_text(`${link.flag || '🔗'}  ${link.name}`, -1),
            subtitle: GLib.markup_escape_text(subtitle, -1),
            subtitle_lines: 1,
            activatable: false,
        });

        const deleteButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Delete this connection'),
        });
        deleteButton.add_css_class('flat');
        deleteButton.connect('clicked', onDelete);
        this.add_suffix(deleteButton);
    }
});

export default class SingBoxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 640);

        // A subscription fetch can take up to 20 seconds. Without this the
        // callback still runs after the window is gone, touching widgets that
        // no longer exist. fetchText() drops the callback entirely on
        // cancellation, so cancelling here is enough.
        const importCancellable = new Gio.Cancellable();
        // Returning false lets the close proceed; true would block it.
        window.connect('close-request', () => {
            importCancellable.cancel();
            return false;
        });

        const settings = this.getSettings(SCHEMA);
        const toast = message => window.add_toast(new Adw.Toast({title: message, timeout: 3}));

        const page = new Adw.PreferencesPage({
            title: APP_NAME,
            icon_name: 'network-vpn-symbolic',
        });

        const listGroup = new Adw.PreferencesGroup({
            title: _('Connections'),
            description: _('Import sing-box connections from a URL or a QR code. The list is ordered by country.'),
        });
        const rows = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        rows.add_css_class('boxed-list');
        listGroup.add(rows);

        const refresh = () => {
            while (rows.get_first_child())
                rows.remove(rows.get_first_child());

            const links = sortLinks(readLinks(settings));
            links.forEach(link => rows.append(new LinkRow(link, () => {
                saveLinks(settings, readLinks(settings).filter(item => item.id !== link.id));
                refresh();
                toast(_('Connection deleted'));
            })));

            if (links.length === 0) {
                rows.append(new Adw.ActionRow({
                    title: _('No connections yet'),
                    subtitle: _('Paste a URL below, or pick a QR code image'),
                }));
            }
        };

        const importGroup = new Adw.PreferencesGroup({title: _('Import a connection')});

        const urlRow = new Adw.EntryRow({title: _('Connection URL')});
        const nameRow = new Adw.EntryRow({title: _('Connection name')});
        const flagRow = new Adw.ComboRow({
            title: _('Country or region'),
            model: Gtk.StringList.new(COUNTRY_ORDER),
        });

        const storeLink = entry => {
            saveLinks(settings, [...readLinks(settings), entry]);
            urlRow.text = '';
            nameRow.text = '';
            refresh();
            toast(_('Connection imported'));
        };

        // A profile is only stored once it has been fetched successfully:
        // otherwise the user keeps an entry that has never been proven to work
        // and only discovers the problem the first time they try to connect.
        const importRemoteProfile = value => {
            let profile;
            try {
                profile = parseRemoteProfileLink(value);
            } catch (error) {
                toast(format(_('That subscription link is malformed: %s'), error.message));
                return;
            }

            // A subscription URL carries a bearer token in its query string,
            // and the shell process fetches it on every connect. Cleartext is
            // not a tradeoff worth offering.
            if (!profile.url.startsWith('https://')) {
                toast(_('A subscription URL must use https'));
                return;
            }

            toast(_('Fetching the subscription…'));
            fetchText(profile.url, importCancellable, (text, error) => {
                if (error !== null) {
                    toast(format(_('Could not fetch the subscription: %s'), error));
                    return;
                }

                const result = isValidRemoteConfig(text);
                if (!result.ok) {
                    toast(format(_('The subscription did not return a usable configuration: %s'),
                        result.error));
                    return;
                }

                storeLink({
                    id: GLib.uuid_string_random(),
                    kind: 'profile',
                    // The deep link carries its own label; the form fields are
                    // only a fallback for links that do not.
                    name: profile.name || nameRow.text.trim() || _('Unnamed subscription'),
                    flag: profile.flag || COUNTRY_ORDER[flagRow.selected] || '🔗',
                    url: profile.url,
                    config: result.config,
                    fetchedAt: GLib.DateTime.new_now_utc().format_iso8601(),
                });
            });
        };

        const addUrl = url => {
            const value = (url || '').trim();
            if (!value || !isSupportedUrl(value)) {
                toast(_('That is not a supported sing-box share link'));
                return;
            }

            if (isRemoteProfileUrl(value)) {
                importRemoteProfile(value);
                return;
            }

            storeLink({
                id: GLib.uuid_string_random(),
                name: nameRow.text.trim() || _('Unnamed connection'),
                flag: COUNTRY_ORDER[flagRow.selected] || '🔗',
                url: value,
            });
        };

        // 从 anyfq.com 批量导入：一次把全部地区拉下来，已有的按地区跳过。
        //
        // 令牌的来源顺序是：输入框里刚粘的订阅链接 → 任何一个已有的订阅条目。
        // 后者意味着导过一次之后，批量导入不需要用户再提供任何东西——而这正是
        // 常见场景：先扫一个码试通了，再想把其余地区补齐。
        const bulkButton = new Gtk.Button({
            label: _('Import'),
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
        });

        const bulkImport = () => {
            let configUrl = null;

            const typed = urlRow.text.trim();
            if (typed && isRemoteProfileUrl(typed)) {
                try {
                    configUrl = parseRemoteProfileLink(typed).url;
                } catch (_error) {
                    // 链接坏了就当没提供，下面会退回已有条目
                }
            }
            if (!configUrl) {
                const existing = readLinks(settings).find(link => link.kind === 'profile' && link.url);
                if (existing) configUrl = existing.url;
            }
            if (!configUrl) {
                toast(_('Import one subscription first, or paste a subscription link above'));
                return;
            }

            let listUrl;
            try {
                listUrl = subscriptionsUrl(configUrl, localeTag());
            } catch (error) {
                toast(format(_('Could not build the region list URL: %s'), error.message));
                return;
            }

            const finish = message => {
                bulkButton.sensitive = true;
                bulkButton.label = _('Import');
                refresh();
                toast(message);
            };

            bulkButton.sensitive = false;
            bulkButton.label = _('Fetching the region list…');

            fetchText(listUrl, importCancellable, (text, error) => {
                if (error !== null) {
                    // 令牌过期是这里最常见的失败，且用户完全可以自己解决，
                    // 所以把原因原样带出来，不要只说「失败了」。
                    finish(format(_('Could not fetch the region list: %s'), error));
                    return;
                }

                let list;
                try {
                    list = JSON.parse(text);
                } catch (parseError) {
                    finish(format(_('The region list is not valid JSON: %s'), parseError.message));
                    return;
                }
                if (!Array.isArray(list) || list.length === 0) {
                    finish(_('The region list came back empty'));
                    return;
                }

                // 按地区去重，而不是按 URL——令牌每 24 小时轮换，
                // 按 URL 比对会让每次批量导入都多出一整套地区。
                const known = new Set(readLinks(settings).map(regionKeyOf).filter(Boolean));
                const wanted = list.filter(entry =>
                    entry && entry.url && !known.has(String(entry.region || '').toLowerCase()));

                const skipped = list.length - wanted.length;
                if (wanted.length === 0) {
                    finish(format(_('Nothing to import: all %s regions are already here'),
                        String(list.length)));
                    return;
                }

                const added = [];
                let failed = 0;

                // 串行抓取。并行会同时开 24 条 TLS 连接去打同一台机器，
                // 对一个一次性操作来说没必要，也更难在中途报进度。
                const step = index => {
                    if (index >= wanted.length) {
                        if (added.length > 0)
                            saveLinks(settings, [...readLinks(settings), ...added]);
                        finish(format(_('Imported %s, skipped %s, failed %s'),
                            String(added.length), String(skipped), String(failed)));
                        return;
                    }

                    const entry = wanted[index];
                    bulkButton.label = format(_('Importing… %s/%s'),
                        String(index + 1), String(wanted.length));

                    fetchText(entry.url, importCancellable, (body, fetchError) => {
                        // 单个地区失败不该让整批停下：换个地区往往就好了，
                        // 而已经抓到的那些对用户是有价值的。
                        if (fetchError !== null) {
                            failed += 1;
                            step(index + 1);
                            return;
                        }
                        const result = isValidRemoteConfig(body);
                        if (!result.ok) {
                            failed += 1;
                            step(index + 1);
                            return;
                        }
                        added.push({
                            id: GLib.uuid_string_random(),
                            kind: 'profile',
                            name: entry.name || String(entry.region || '').toUpperCase(),
                            flag: entry.flag || '🔗',
                            url: entry.url,
                            config: result.config,
                            fetchedAt: GLib.DateTime.new_now_utc().format_iso8601(),
                        });
                        step(index + 1);
                    });
                };

                step(0);
            });
        };

        bulkButton.connect('clicked', bulkImport);
        bulkButton.add_css_class('suggested-action');

        const bulkRow = new Adw.ActionRow({
            title: _('Import all from anyfq.com'),
            subtitle: _('Fetches every region at once, skipping the ones you already have'),
        });
        bulkRow.add_suffix(bulkButton);
        // 整行可点，不用非得瞄准按钮
        bulkRow.activatable_widget = bulkButton;
        importGroup.add(bulkRow);
        importGroup.add(urlRow);
        importGroup.add(nameRow);
        importGroup.add(flagRow);

        const importButton = new Gtk.Button({
            label: _('Import URL'),
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
        });
        importButton.add_css_class('suggested-action');
        importButton.connect('clicked', () => addUrl(urlRow.text));
        urlRow.connect('entry-activated', () => addUrl(urlRow.text));

        const qrButton = new Gtk.Button({
            label: _('Import from a QR image'),
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
        });
        qrButton.connect('clicked', () => this._importFromQrImage(window, addUrl, toast));

        const buttonRow = new Adw.ActionRow();
        buttonRow.add_suffix(qrButton);
        buttonRow.add_suffix(importButton);
        importGroup.add(buttonRow);

        const backendGroup = new Adw.PreferencesGroup({
            title: _('TUN backend'),
            description: _('The generated sing-box TUN configuration is passed to this command. sing-box needs permission to create a TUN device and change routes.'),
        });
        const backendRow = new Adw.EntryRow({
            title: _('Start command'),
            text: settings.get_string('backend-command'),
            show_apply_button: true,
        });
        // Applied on Enter or via the apply button, so a half-typed command is
        // never written to GSettings.
        backendRow.connect('apply', row => {
            settings.set_string('backend-command', row.text.trim());
            toast(_('Start command saved'));
        });
        backendGroup.add(backendRow);

        page.add(listGroup);
        page.add(importGroup);
        page.add(backendGroup);
        window.add(page);
        refresh();
    }

    _importFromQrImage(window, addUrl, toast) {
        if (!GLib.find_program_in_path('zbarimg')) {
            // The zbar library alone is not enough; the command line tool ships
            // separately (zbar-tools on Debian and Ubuntu, zbar elsewhere).
            toast(_('QR images need the zbarimg tool: install the zbar-tools package'));
            return;
        }

        const dialog = new Gtk.FileDialog({title: _('Choose a QR code image')});
        dialog.open(window, null, (source, result) => {
            let path;
            try {
                path = source.open_finish(result).get_path();
            } catch (_error) {
                return; // The user dismissed the dialog.
            }
            this._readQrCode(path, addUrl, toast);
        });
    }

    _readQrCode(path, addUrl, toast) {
        let process;
        try {
            process = Gio.Subprocess.new(
                ['zbarimg', '--quiet', '--raw', path], Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (error) {
            toast(format(_('Could not run zbarimg: %s'), error.message));
            return;
        }

        process.communicate_utf8_async(null, null, (proc, result) => {
            let stdout = '';
            try {
                [, stdout] = proc.communicate_utf8_finish(result);
            } catch (error) {
                toast(format(_('Could not read the QR image: %s'), error.message));
                return;
            }

            const payload = (stdout || '').split('\n')[0].trim();
            if (!payload) {
                toast(_('No QR code was found in that image'));
                return;
            }
            addUrl(payload);
        });
    }
}
