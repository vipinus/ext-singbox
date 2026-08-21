import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Long enough for a slow mobile link, short enough that a connect attempt
// does not appear to hang.
const TIMEOUT_SECONDS = 20;

let session = null;

function getSession() {
    if (!session) {
        session = new Soup.Session({timeout: TIMEOUT_SECONDS});
        // Some providers vary their response by client; identify honestly.
        session.user_agent = 'gnome-shell-extension-singbox';
    }
    return session;
}

/**
 * GET a URL and hand the body back as text. The callback runs exactly once:
 * either with the body, or with an English error string suitable for wrapping
 * in a translated message.
 */
export function fetchText(url, cancellable, callback) {
    let message;
    try {
        message = Soup.Message.new('GET', url);
    } catch (error) {
        callback(null, error.message);
        return;
    }
    if (!message) {
        callback(null, 'malformed url');
        return;
    }

    getSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
        let bytes;
        try {
            bytes = source.send_and_read_finish(result);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
            callback(null, error.message);
            return;
        }

        const status = message.get_status();
        if (status !== Soup.Status.OK) {
            callback(null, `HTTP ${status} ${message.get_reason_phrase() || ''}`.trim());
            return;
        }

        const data = bytes?.get_data();
        if (!data) {
            callback(null, 'empty response');
            return;
        }
        callback(new TextDecoder().decode(data), null);
    });
}

export function shutdownFetch() {
    session?.abort();
    session = null;
}
