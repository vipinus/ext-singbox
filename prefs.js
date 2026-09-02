import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    REGIONS,
    regionLabel,
    format,
    isRemoteProfileUrl,
    isSupportedUrl,
    isValidRemoteConfig,
    accountInConfig,
    accountOf,
    localeTag,
    maskAccount,
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

/**
 * 换账号确认框。
 *
 * ⚠️ 用能力探测而不是直接用 Adw.AlertDialog：metadata.json 声明支持 GNOME 45，
 * 而 AlertDialog 是 libadwaita 1.5（GNOME 46）才有的。写死它会让 45 上一点按钮
 * 就抛异常——而首选项窗口的异常不会显示给用户，表现成「点了没反应」。
 */
function confirmReplace(window, others, incoming, onConfirm, onCancel) {
    const REPLACE = 'replace';
    const heading = _('These subscriptions belong to a different account');
    const body = format(
        _('The %s subscriptions already here belong to %s, but this import belongs to %s. Replace them?'),
        String(others.length), maskAccount(accountOf(others[0])), maskAccount(incoming));

    if (Adw.AlertDialog) {
        const dialog = new Adw.AlertDialog({heading, body});
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response(REPLACE, _('Replace'));
        dialog.set_response_appearance(REPLACE, Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) =>
            response === REPLACE ? onConfirm() : onCancel());
        dialog.present(window);
        return;
    }

    const dialog = new Adw.MessageDialog({transient_for: window, modal: true, heading, body});
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response(REPLACE, _('Replace'));
    dialog.set_response_appearance(REPLACE, Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) =>
        response === REPLACE ? onConfirm() : onCancel());
    dialog.present();
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

        // 所属订阅账号，摆在右侧——与快捷设置菜单里的位置一致，
        // 两处看到的是同一个信息、同一个位置。手工加的分享链接没有缓存
        // 配置、取不到账号，就不显示这一块（而不是显示一个空标签占位）。
        const account = accountOf(link);
        if (account) {
            const tag = new Gtk.Label({
                label: maskAccount(account),
                valign: Gtk.Align.CENTER,
            });
            tag.add_css_class('dim-label');
            tag.add_css_class('caption');
            this.add_suffix(tag);
        }

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
            model: Gtk.StringList.new(REGIONS.map(regionLabel)),
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
                    flag: profile.flag || REGIONS[flagRow.selected]?.flag || '🔗',
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
                name: nameRow.text.trim() ||
                    REGIONS[flagRow.selected]?.name || _('Unnamed connection'),
                flag: REGIONS[flagRow.selected]?.flag || '🔗',
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
            // 深链之外，也接受直接粘贴的配置 URL：用户手里明明已经有令牌，
            // 却因为格式不是深链而被挡回去，说不通。
            if (!configUrl && typed.startsWith('https://') && /[?&]token=/.test(typed))
                configUrl = typed;

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

                // 先抓一份配置，探出这批订阅属于哪个账号。
                //
                // 多花一次请求，换来的是「换账号时不会静默用错凭据」。不做这件事的
                // 后果用户完全看不出来：令牌取自列表里第一条订阅（可能是旧账号），
                // 或者就算令牌对了，按地区去重也会让 24 个地区全被跳过，界面显示
                // 「无需导入」而实际连的还是旧账号——直到过期才发现，且无从排查。
                //
                // 这次探测同时也验证了令牌确实有效，失败在这里就能说清楚。
                bulkButton.label = _('Checking the account…');
                fetchText(list[0].url, importCancellable, (probeBody, probeError) => {
                    if (probeError !== null) {
                        finish(format(_('Could not fetch the region list: %s'), probeError));
                        return;
                    }
                    const probe = isValidRemoteConfig(probeBody);
                    if (!probe.ok) {
                        finish(format(_('The subscription did not return a usable configuration: %s'),
                            probe.error));
                        return;
                    }

                    const incoming = accountInConfig(probe.config);
                    const others = readLinks(settings).filter(link =>
                        link.kind === 'profile' && accountOf(link) && accountOf(link) !== incoming);

                    if (incoming && others.length > 0) {
                        confirmReplace(window, others, incoming,
                            () => run(others),
                            () => finish(_('Import cancelled')));
                        return;
                    }
                    run([]);
                });

                function run(toRemove) {
                    const removed = new Set(toRemove.map(link => link.id));
                    const remaining = readLinks(settings).filter(link => !removed.has(link.id));

                    // 按地区去重，而不是按 URL——令牌每 24 小时轮换，
                    // 按 URL 比对会让每次批量导入都多出一整套地区。
                    const known = new Set(remaining.map(regionKeyOf).filter(Boolean));
                    const wanted = list.filter(entry =>
                        entry && entry.url && !known.has(String(entry.region || '').toLowerCase()));

                    const skipped = list.length - wanted.length;
                    if (wanted.length === 0) {
                        // 确认过替换的话，旧账号的条目仍然要删掉
                        if (toRemove.length > 0) saveLinks(settings, remaining);
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
                            if (added.length > 0 || toRemove.length > 0)
                                saveLinks(settings, [...remaining, ...added]);
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
                }
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
        qrButton.connect('clicked', () =>
            this._importFromQrImage(window, addUrl, toast, importCancellable));

        const buttonRow = new Adw.ActionRow();
        buttonRow.add_suffix(qrButton);
        buttonRow.add_suffix(importButton);
        importGroup.add(buttonRow);

        // 后端一栏被整个删掉了：那里原来是一个可编辑的「启动命令」输入框，
        // 扩展再把它 shell_parse_argv 出来执行。EGO 的审查规则不允许扩展执行
        // 来自设置的命令——一个文本框就是一条任意命令执行的路径。现在后端固定
        // 由 systemd 用户单元 singbox-ext.service 托管，装在哪、怎么起都由
        // 项目的 install.sh 决定，设置里不再存任何可执行的东西。
        const backendGroup = new Adw.PreferencesGroup({
            title: _('TUN backend'),
            description: _('sing-box runs as the systemd user service singbox-ext.service, which the install.sh script in the project sets up. Run it once before connecting; the extension only starts and stops that service.'),
        });

        page.add(listGroup);
        page.add(importGroup);
        page.add(backendGroup);
        window.add(page);
        refresh();
    }

    _importFromQrImage(window, addUrl, toast, cancellable) {
        // 解析出绝对路径而不是让 exec 去查 PATH：argv[0] 写成裸名字的话，跑起来
        // 的是首选项进程环境里 PATH 最前面的那个 zbarimg，那是外面能左右的东西。
        const zbarimg = GLib.find_program_in_path('zbarimg');
        if (!zbarimg) {
            // The zbar library alone is not enough; the command line tool ships
            // separately (zbar-tools on Debian and Ubuntu, zbar elsewhere).
            toast(_('QR images need the zbarimg tool: install the zbar-tools package'));
            return;
        }

        const dialog = new Gtk.FileDialog({title: _('Choose a QR code image')});
        dialog.open(window, cancellable, (source, result) => {
            let path;
            try {
                path = source.open_finish(result).get_path();
            } catch (_error) {
                return; // The user dismissed the dialog.
            }
            this._readQrCode(zbarimg, path, addUrl, toast, cancellable);
        });
    }

    /**
     * 唯一一处起子进程的地方：用户自己点了「从二维码图片导入」才会走到，
     * 命令写死在代码里、不来自任何设置，读完一张图就退出。
     * 跟着窗口的 cancellable 走——窗口关了就不该再有回调去碰它的控件。
     */
    _readQrCode(zbarimg, path, addUrl, toast, cancellable) {
        let process;
        try {
            process = Gio.Subprocess.new(
                [zbarimg, '--quiet', '--raw', path], Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (error) {
            toast(format(_('Could not run zbarimg: %s'), error.message));
            return;
        }

        process.communicate_utf8_async(null, cancellable, (proc, result) => {
            let stdout = '';
            try {
                [, stdout] = proc.communicate_utf8_finish(result);
            } catch (error) {
                // 取消是窗口关了，这时候 toast 无处可去（控件已经没了）。
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
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
