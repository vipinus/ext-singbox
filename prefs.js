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
    parseRemoteProfileLink,
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
    // an edge case we did not anticipate; fall back to the raw URL rather
    // than breaking the whole list over one bad subtitle.
    static _hostOf(url) {
        try {
            return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host();
        } catch (_error) {
            return url || '';
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
        importGroup.add(urlRow);
        importGroup.add(nameRow);
        importGroup.add(flagRow);

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

            toast(_('Fetching the subscription…'));
            fetchText(profile.url, null, (text, error) => {
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
