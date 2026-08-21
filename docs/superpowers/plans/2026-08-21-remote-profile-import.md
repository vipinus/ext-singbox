# Remote Profile Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the extension import `sing-box://import-remote-profile` deep links from anyfq.com, storing the fetched configuration and connecting from it.

**Architecture:** A profile is a new kind of entry in the existing `links` array. Parsing and validation are pure functions in `lib/config.js`, tested under `gjs`. Fetching lives in a thin `lib/fetch.js` wrapper over libsoup that is deliberately not unit-tested. Connecting reads the cached configuration and starts immediately; a background refresh updates the cache for next time without touching the running process.

**Tech Stack:** GJS (GNOME Shell 45+ ESM extensions), libsoup 3 via `gi://Soup`, GLib/Gio, `gjs` test harness in `tests/`, real `sing-box check` validation.

**Spec:** `docs/superpowers/specs/2026-08-21-remote-profile-import-design.md`

## Global Constraints

- Target GNOME Shell 45–50; extension modules are ESM with relative imports.
- Pure logic goes in `lib/`, is exported, and is tested in `tests/config-test.js`. Network code stays in `lib/fetch.js` and is NOT unit-tested.
- Source strings are English and wrapped in `_()`. After adding any string, regenerate `po/gname-shell-extension-singbox.pot` and update `po/zh_CN.po`; CI fails on a stale template.
- Existing entries in `links` have no `kind` field and MUST keep working as `'link'`.
- Every task ends with `./tests/run.sh` passing (exit 0).
- Never store a profile that has not been fetched successfully at least once.
- Background refresh writes only to GSettings. It MUST NOT restart or signal the running sing-box process.
- Do not add a manual refresh button, a scheduled updater, multi-outbound selection UI, or a configuration migration layer. These are explicitly out of scope.
- The deep link scheme is exactly `sing-box://import-remote-profile`; the inner URL is percent-encoded in the `url` query parameter and the display label is in the fragment.

---

### Task 1: Parse the remote profile deep link

**Files:**
- Modify: `lib/config.js` (add exports near `isSupportedUrl`, line 7)
- Test: `tests/config-test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isRemoteProfileUrl(value: string) -> boolean`
  - `parseRemoteProfileLink(value: string) -> {url: string, name: string, flag: string}` — throws `Error` when the link is malformed or carries no `url` parameter.

The fragment on anyfq.com links looks like `🇬🇧 英国`. The leading flag emoji becomes `flag` and the rest becomes `name`. A regional indicator pair is two code points in the range U+1F1E6–U+1F1FF, so it cannot be matched with a plain `[a-z]`-style class.

- [ ] **Step 1: Write the failing test**

Add to `tests/config-test.js`, immediately before `suite('link list handling');`:

```javascript
suite('remote profile links');

const PROFILE_LINK =
    'sing-box://import-remote-profile?url=' +
    encodeURIComponent('https://www.anyfq.com/api/v1/singbox/config?token=abc&region=uk') +
    '#' + encodeURIComponent('🇬🇧 英国');

test('the deep link scheme is recognised', () => {
    assert(isRemoteProfileUrl(PROFILE_LINK), 'anyfq deep links must be recognised');
    assert(!isRemoteProfileUrl('hysteria2://a@b:443'), 'share links are not profiles');
    assert(!isRemoteProfileUrl('https://example.com/config'), 'a bare url is not a deep link');
});

test('the inner url survives its own query string intact', () => {
    const parsed = parseRemoteProfileLink(PROFILE_LINK);
    assertEqual(parsed.url,
        'https://www.anyfq.com/api/v1/singbox/config?token=abc&region=uk');
});

test('the fragment splits into a flag and a name', () => {
    const parsed = parseRemoteProfileLink(PROFILE_LINK);
    assertEqual(parsed.flag, '🇬🇧');
    assertEqual(parsed.name, '英国');
});

test('a fragment without a flag becomes the name alone', () => {
    const link = 'sing-box://import-remote-profile?url=' +
        encodeURIComponent('https://example.com/c') + '#' + encodeURIComponent('London');
    const parsed = parseRemoteProfileLink(link);
    assertEqual(parsed.flag, '');
    assertEqual(parsed.name, 'London');
});

test('a missing fragment yields empty name and flag rather than throwing', () => {
    const parsed = parseRemoteProfileLink(
        'sing-box://import-remote-profile?url=' + encodeURIComponent('https://example.com/c'));
    assertEqual(parsed.flag, '');
    assertEqual(parsed.name, '');
});

test('a deep link with no url parameter is rejected', () => {
    assertThrows(() => parseRemoteProfileLink('sing-box://import-remote-profile#x'));
});

test('remote profile links are importable', () => {
    assert(isSupportedUrl(PROFILE_LINK), 'the import field must accept deep links');
});
```

Add `isRemoteProfileUrl` and `parseRemoteProfileLink` to the import list at the top of `tests/config-test.js`, keeping it alphabetical:

```javascript
import {
    buildSingBoxConfig,
    describeProcessFailure,
    format,
    flagRank,
    isRemoteProfileUrl,
    isSupportedUrl,
    parseLinks,
    parseProxyUrl,
    parseRemoteProfileLink,
    sortLinks,
} from '../lib/config.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `gjs -m tests/config-test.js`
Expected: FAIL with `SyntaxError: ... doesn't provide an export named: 'isRemoteProfileUrl'`.

An import error is not a proper red. Add stubs to `lib/config.js` so the tests fail on assertions instead:

```javascript
export function isRemoteProfileUrl(_value) {
    return false;
}

export function parseRemoteProfileLink(_value) {
    return {url: '', name: '', flag: ''};
}
```

Re-run. Expected: 6 assertion failures in `remote profile links`, and `remote profile links are importable` also failing.

- [ ] **Step 3: Write minimal implementation**

Replace the stubs in `lib/config.js`:

```javascript
const REMOTE_PROFILE_PREFIX = 'sing-box://import-remote-profile';

// A flag emoji is a pair of regional indicator symbols, so it is two code
// points rather than one character.
const FLAG_PATTERN = /^([\u{1F1E6}-\u{1F1FF}]{2})\s*/u;

export function isRemoteProfileUrl(value) {
    return typeof value === 'string' && value.startsWith(REMOTE_PROFILE_PREFIX);
}

/**
 * Pull the inner configuration URL and the display label out of an
 * import-remote-profile deep link.
 */
export function parseRemoteProfileLink(value) {
    if (!isRemoteProfileUrl(value)) throw new Error('Not a remote profile link');

    const rest = value.slice(REMOTE_PROFILE_PREFIX.length);
    const hashIndex = rest.indexOf('#');
    const query = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : decodeURIComponent(rest.slice(hashIndex + 1));

    const url = parseQuery(query.replace(/^\?/, '')).url || '';
    if (!url) throw new Error('Remote profile link carries no url');

    const match = fragment.match(FLAG_PATTERN);
    return {
        url,
        flag: match ? match[1] : '',
        name: match ? fragment.slice(match[0].length).trim() : fragment.trim(),
    };
}
```

Then widen `isSupportedUrl` so the import field accepts the deep link:

```javascript
export function isSupportedUrl(value) {
    if (isRemoteProfileUrl(value)) return true;
    return new RegExp(`^(${SUPPORTED_SCHEMES.join('|')}):\\/\\/`).test(value);
}
```

`parseQuery` already exists in `lib/config.js` (line 36) and already percent-decodes values, so the inner URL's own query string comes back intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/run.sh`
Expected: all checks pass, exit 0, 45 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js tests/config-test.js
git commit -m "Parse sing-box import-remote-profile deep links"
```

---

### Task 2: Validate a fetched configuration

**Files:**
- Modify: `lib/config.js`
- Create: `tests/fixtures/anyfq-uk.json`
- Test: `tests/config-test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `isValidRemoteConfig(text: string) -> {ok: boolean, config: object|null, error: string}` — parses JSON and checks it looks like a runnable sing-box configuration. `error` is an English, untranslated diagnostic; callers wrap it for display.

The fixture is a sanitised copy of a real anyfq.com response: real structure, fake credentials. It exists so the suite proves the shape we actually receive still passes `sing-box check`.

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures/anyfq-uk.json` with exactly this content:

```json
{
  "log": { "level": "warn", "timestamp": true },
  "dns": {
    "servers": [
      { "tag": "remote", "type": "udp", "server": "1.1.1.1", "detour": "proxy" },
      { "tag": "local", "type": "udp", "server": "223.5.5.5", "detour": "direct" }
    ],
    "final": "remote",
    "strategy": "ipv4_only"
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.19.0.1/30"],
      "auto_route": true,
      "strict_route": true,
      "stack": "mixed"
    }
  ],
  "outbounds": [
    {
      "type": "hysteria2",
      "tag": "proxy",
      "server": "uk.fanq.in",
      "server_port": 8443,
      "server_ports": ["45000:49999"],
      "hop_interval": "30s",
      "password": "fake@user.example:fakepassword",
      "obfs": { "type": "salamander", "password": "fake-obfs-password" },
      "up_mbps": 100,
      "down_mbps": 500,
      "tls": { "enabled": true, "server_name": "uk.fanq.in", "insecure": true }
    },
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "rules": [
      { "action": "sniff" },
      { "protocol": "dns", "action": "hijack-dns" },
      { "ip_is_private": true, "outbound": "direct" }
    ],
    "final": "proxy",
    "auto_detect_interface": true,
    "default_domain_resolver": { "server": "local" }
  }
}
```

Add to `tests/config-test.js`, immediately after the `remote profile links` suite:

```javascript
suite('remote configuration validation');

function fixture(name) {
    const path = GLib.build_filenamev([
        GLib.path_get_dirname(import.meta.url.replace('file://', '')), 'fixtures', name]);
    return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
}

test('a real anyfq response is accepted', () => {
    const result = isValidRemoteConfig(fixture('anyfq-uk.json'));
    assert(result.ok, `expected the fixture to validate, got: ${result.error}`);
    assertEqual(result.config.outbounds[0].type, 'hysteria2');
});

test('the anyfq response shape still passes sing-box check', () => {
    assertValidSingBoxConfig(isValidRemoteConfig(fixture('anyfq-uk.json')).config,
        'the configuration we actually receive must be runnable');
});

test('text that is not json is rejected', () => {
    const result = isValidRemoteConfig('<html>login required</html>');
    assert(!result.ok, 'an html error page is not a configuration');
    assert(result.error.length > 0, 'a diagnostic is always needed');
});

test('json without outbounds is rejected', () => {
    assert(!isValidRemoteConfig('{"log":{"level":"warn"}}').ok,
        'a configuration with nowhere to send traffic is useless');
});

test('an empty outbounds array is rejected', () => {
    assert(!isValidRemoteConfig('{"outbounds":[]}').ok, 'no outbounds means no proxy');
});

test('a json array is rejected', () => {
    assert(!isValidRemoteConfig('[]').ok, 'the response must be an object');
});
```

Add `isValidRemoteConfig` to the import list in `tests/config-test.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `gjs -m tests/config-test.js`
Expected: `SyntaxError ... doesn't provide an export named: 'isValidRemoteConfig'`.

Add a stub to `lib/config.js` so it fails on assertions:

```javascript
export function isValidRemoteConfig(_text) {
    return {ok: false, config: null, error: ''};
}
```

Re-run. Expected: `a real anyfq response is accepted` fails with `expected the fixture to validate, got: `; `the anyfq response shape still passes sing-box check` fails; `text that is not json is rejected` fails on the diagnostic assertion.

- [ ] **Step 3: Write minimal implementation**

Replace the stub in `lib/config.js`:

```javascript
/**
 * Check that a fetched response really is a runnable sing-box configuration.
 * Servers behind a login wall answer with HTML, and an expired token answers
 * with a small JSON error object; both must be rejected before we cache them.
 */
export function isValidRemoteConfig(text) {
    let config;
    try {
        config = JSON.parse(text);
    } catch (error) {
        return {ok: false, config: null, error: `response is not JSON: ${error.message}`};
    }

    if (config === null || typeof config !== 'object' || Array.isArray(config))
        return {ok: false, config: null, error: 'response is not a configuration object'};

    if (!Array.isArray(config.outbounds) || config.outbounds.length === 0)
        return {ok: false, config: null, error: 'configuration has no outbounds'};

    return {ok: true, config, error: ''};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/run.sh`
Expected: all checks pass, exit 0, 51 passing. The `sing-box check` on the fixture proves the shape we receive is runnable.

- [ ] **Step 5: Commit**

```bash
git add lib/config.js tests/config-test.js tests/fixtures/anyfq-uk.json
git commit -m "Validate fetched sing-box configurations before caching them"
```

---

### Task 3: Fetch a configuration over HTTP

**Files:**
- Create: `lib/fetch.js`
- Modify: `install.sh` (copy `lib/fetch.js`), `meson.build` (install `lib/fetch.js`), `tests/run.sh` (syntax-check `lib/fetch.js`)

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchText(url: string, cancellable: Gio.Cancellable|null, callback: (text: string|null, error: string|null) => void) -> void` — performs one GET and calls back exactly once on the main loop.

This file is deliberately thin and has no unit tests: it is the only part of the feature that cannot run outside a session, and every decision it could get wrong has been pushed into the pure functions from Tasks 1 and 2.

- [ ] **Step 1: Write the implementation**

There is no test for this task; the deliverable is the wrapper plus its packaging. Create `lib/fetch.js`:

```javascript
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
```

- [ ] **Step 2: Add it to packaging and the syntax check**

In `install.sh`, extend the `lib` copy line:

```sh
cp "$PROJECT_DIR/lib/config.js" "$PROJECT_DIR/lib/fetch.js" "$INSTALL_DIR/lib/"
```

In `meson.build`, replace the `lib/config.js` install with:

```meson
install_data('lib/config.js', 'lib/fetch.js',
  install_dir: join_paths(extensiondir, 'lib'))
```

In `tests/run.sh`, add `lib/fetch.js` to the syntax-check file list:

```sh
    for file in extension.js prefs.js lib/config.js lib/fetch.js tests/harness.js tests/config-test.js; do
```

- [ ] **Step 3: Run the suite to verify nothing regressed**

Run: `./tests/run.sh`
Expected: `parsed 6 files`, all checks pass, exit 0, 51 passing.

- [ ] **Step 4: Verify the module loads under gjs**

Run: `gjs -c "import('./lib/fetch.js').then(m => print(Object.keys(m).join(', ')))"`
Expected: `fetchText, shutdownFetch`. This catches a bad `gi://Soup` version string, which the syntax check cannot.

- [ ] **Step 5: Commit**

```bash
git add lib/fetch.js install.sh meson.build tests/run.sh
git commit -m "Add a thin libsoup wrapper for fetching remote configurations"
```

---

### Task 4: Import a remote profile from the preferences window

**Files:**
- Modify: `prefs.js:98-116` (the `addUrl` closure), `prefs.js:26-45` (`LinkRow`)
- Modify: `po/gname-shell-extension-singbox.pot`, `po/zh_CN.po`

**Interfaces:**
- Consumes: `isRemoteProfileUrl`, `parseRemoteProfileLink`, `isValidRemoteConfig` from `lib/config.js`; `fetchText` from `lib/fetch.js`.
- Produces: entries in `links` with `kind: 'profile'`, shaped `{id, kind, name, flag, url, config, fetchedAt}`.

- [ ] **Step 1: Split the import path**

In `prefs.js`, extend the imports:

```javascript
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
```

Replace the body of `addUrl` (currently `prefs.js:98-116`) with:

```javascript
        const storeLink = entry => {
            saveLinks(settings, [...readLinks(settings), entry]);
            urlRow.text = '';
            nameRow.text = '';
            refresh();
            toast(_('Connection imported'));
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
```

`importRemoteProfile` is referenced by `addUrl` before its `const` declaration is
evaluated, so move the `importRemoteProfile` definition **above** `addUrl`.

- [ ] **Step 2: Show subscriptions differently in the list**

Replace the `LinkRow` `_init` subtitle line (`prefs.js:31`) so a profile shows its
host rather than a long tokenised URL:

```javascript
        const isProfile = link.kind === 'profile';
        const subtitle = isProfile
            ? `${_('Subscription')} · ${GLib.Uri.parse(link.url, GLib.UriFlags.NONE).get_host()}`
            : link.url || '';

        super._init({
            title: GLib.markup_escape_text(`${link.flag || '🔗'}  ${link.name}`, -1),
            subtitle: GLib.markup_escape_text(subtitle, -1),
            subtitle_lines: 1,
            activatable: false,
        });
```

- [ ] **Step 3: Update the translations**

Run:

```bash
xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
  --package-name="sing-box Link Manager" --package-version=1 \
  --copyright-holder="sing-box Link Manager contributors" \
  --msgid-bugs-address="https://github.com/gname/gname-shell-extension-singbox/issues" \
  -f po/POTFILES.in -o po/gname-shell-extension-singbox.pot
msgmerge --quiet --update --backup=none po/zh_CN.po po/gname-shell-extension-singbox.pot
```

Then fill in the new `msgstr` values in `po/zh_CN.po`, removing any `#, fuzzy` marker on them:

| msgid | msgstr |
|---|---|
| `That subscription link is malformed: %s` | `订阅链接格式有误：%s` |
| `Fetching the subscription…` | `正在获取订阅…` |
| `Could not fetch the subscription: %s` | `无法获取订阅：%s` |
| `The subscription did not return a usable configuration: %s` | `订阅返回的配置不可用：%s` |
| `Unnamed subscription` | `未命名订阅` |
| `Subscription` | `订阅` |

Verify: `msgfmt --check --statistics po/zh_CN.po -o /dev/null`
Expected: `40 translated messages.` with no fuzzy and no untranslated.

- [ ] **Step 4: Verify the preferences window still builds**

Run:

```bash
./tests/run.sh
UUID='gname-shell-extension-singbox@gnome-shell-extension'
D="$HOME/.local/share/gnome-shell/extensions/$UUID"
cp prefs.js lib/config.js lib/fetch.js "$D/" 2>/dev/null; cp lib/*.js "$D/lib/"; cp prefs.js "$D/"
gnome-extensions prefs "$UUID"
sleep 5
journalctl --user -b --since "-30s" --no-pager | grep -iE "JS ERROR|singbox" | head
```

Expected: `./tests/run.sh` exits 0; the journal shows no `JS ERROR`. Close the window afterwards.

- [ ] **Step 5: Commit**

```bash
git add prefs.js po/
git commit -m "Import remote profiles from the preferences window"
```

---

### Task 5: Connect from a cached profile

**Files:**
- Modify: `extension.js:46-77` (`start`), `extension.js:107-114` (`_writeConfig`)

**Interfaces:**
- Consumes: `fetchText` from `lib/fetch.js`; `isValidRemoteConfig` from `lib/config.js`.
- Produces: no new exports. `SingBoxVpnManager.start(link)` now accepts entries with `kind: 'profile'`.

Connecting from a profile must not block on the network. The cached configuration is written straight to disk and sing-box starts immediately, exactly as it does for a share link.

- [ ] **Step 1: Write the configuration from either source**

No import changes are needed in this task; `buildSingBoxConfig` is already imported.
Replace `_writeConfig` (`extension.js:107-114`) with:

```javascript
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
```

- [ ] **Step 2: Verify a profile connects from cache**

There is no unit test for this: it needs a running shell. Verify by hand with a
throwaway entry that points at the fixture, so no credentials are involved.

```bash
UUID='gname-shell-extension-singbox@gnome-shell-extension'
D="$HOME/.local/share/gnome-shell/extensions/$UUID"
SCHEMADIR="$D/schemas"
cp extension.js "$D/"; cp lib/*.js "$D/lib/"
BACKUP=$(GSETTINGS_SCHEMA_DIR="$SCHEMADIR" gsettings get org.gnome.shell.extensions.gname-shell-extension-singbox links)
echo "$BACKUP" > /tmp/links-backup.txt
python3 -c "
import json
cfg = json.load(open('tests/fixtures/anyfq-uk.json'))
print(json.dumps([{'id':'test-profile','kind':'profile','name':'Fixture UK','flag':'🇬🇧',
                   'url':'https://example.invalid/c','config':cfg,
                   'fetchedAt':'2026-08-21T00:00:00Z'}]))" > /tmp/test-links.json
GSETTINGS_SCHEMA_DIR="$SCHEMADIR" gsettings set org.gnome.shell.extensions.gname-shell-extension-singbox links "$(cat /tmp/test-links.json)"
```

Log out and back in (GJS caches ESM modules, so disable/enable does not reload
`extension.js`). Then open Quick Settings, click **Fixture UK**, and confirm the
notification says `Connecting to Fixture UK` rather than a configuration error.
The connection itself will fail because `uk.fanq.in` rejects the fake credentials —
that is expected; what is being verified is that the cached configuration was
written and sing-box started.

Restore afterwards:

```bash
GSETTINGS_SCHEMA_DIR="$SCHEMADIR" gsettings set org.gnome.shell.extensions.gname-shell-extension-singbox links "$(cat /tmp/links-backup.txt | sed "s/^'//; s/'$//")"
rm -f /tmp/test-links.json /tmp/links-backup.txt
```

- [ ] **Step 3: Run the suite**

Run: `./tests/run.sh`
Expected: all checks pass, exit 0.

- [ ] **Step 4: Commit**

```bash
git add extension.js
git commit -m "Start sing-box from a cached subscription configuration"
```

---

### Task 6: Refresh the cache in the background after connecting

**Files:**
- Modify: `extension.js` (`SingBoxVpnManager.start`, `destroy`)

**Interfaces:**
- Consumes: `fetchText`, `shutdownFetch` from `lib/fetch.js`; `isValidRemoteConfig` from `lib/config.js`.
- Produces: no new exports.

The refresh keeps the cached configuration current when the provider rotates
parameters, without ever making the user wait and without a false warning when the
24-hour token has lapsed — the cached credentials still work, so a failed refresh is
not news.

- [ ] **Step 1: Add the background refresh**

In `extension.js`, extend the imports:

```javascript
import {fetchText, shutdownFetch} from './lib/fetch.js';
```

and add `isValidRemoteConfig` to the `./lib/config.js` import list.

At the end of `start(link)`, after the `communicate_utf8_async` call, add:

```javascript
        if (link.kind === 'profile') this._refreshProfile(link);
```

Add these methods to `SingBoxVpnManager`:

```javascript
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
```

In `destroy()`, cancel any in-flight request before the rest of the teardown:

```javascript
    destroy() {
        this._refreshCancellable?.cancel();
        this._refreshCancellable = null;
        shutdownFetch();

        if (this._process) {
```

Initialise the field in the constructor, next to `this._process = null;`:

```javascript
        this._refreshCancellable = null;
```

- [ ] **Step 2: Confirm the refresh cannot restart the connection**

Read back `_refreshProfile` and check three things by inspection, because no test
can cover them:

1. It calls only `this._settings.set_string`; it never calls `start`, `stop`, or
   touches `this._process`.
2. `extension.js` connects `changed::links` to `rebuildMenu` only — writing to
   `links` redraws the menu and nothing else.
3. `destroy()` cancels the cancellable before `shutdownFetch()`, so a request in
   flight at logout cannot call back into a destroyed manager.

- [ ] **Step 3: Run the suite**

Run: `./tests/run.sh`
Expected: all checks pass, exit 0.

- [ ] **Step 4: Verify a full round trip against the live service**

This is the only end-to-end check that exercises fetch, validate, store and
connect together. It needs a fresh, unexpired QR code from anyfq.com.

```bash
zbarimg --quiet --raw <path-to-fresh-qr.png>
```

Confirm the payload starts with `sing-box://import-remote-profile`. Paste it into
the extension's **Connection URL** field and press Import. Expected: the toast
reads `Fetching the subscription…` then `Connection imported`, and the list shows
a row whose title carries the flag and region name from the deep link and whose
subtitle reads `Subscription · www.anyfq.com`.

Then connect from Quick Settings and confirm traffic flows:

```bash
curl -fsS --max-time 15 https://api.ipify.org; echo
```

Expected: an address in the profile's region, not the local one.

- [ ] **Step 5: Commit**

```bash
git add extension.js
git commit -m "Refresh a subscription's cached configuration in the background"
```

---

### Task 7: Document the feature

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the feature list**

In `README.md`, add to the Features list after the QR-code bullet:

```markdown
- Import a `sing-box://import-remote-profile` subscription link, storing the
  configuration the provider returns and refreshing it in the background.
```

- [ ] **Step 2: Document the subscription behaviour**

Add this section after **TUN permissions**:

```markdown
## Subscriptions

A `sing-box://import-remote-profile` link points at a URL that returns a whole
sing-box configuration rather than describing a single node. Importing one fetches
that configuration immediately and stores it; the import fails rather than keeping
an entry that has never been proven to work.

Connecting uses the stored copy, so it never waits on the network. Once connected,
the extension quietly refreshes the stored copy for next time. That refresh is
silent on purpose: the token inside a subscription URL is typically short-lived, so
a failed refresh is the normal steady state, and the credentials already stored keep
working. A refresh never restarts a running connection.

Subscriptions are stored in GSettings alongside share links, in plain text. This is
the same exposure share links already have — their passwords are stored the same
way — but a subscription holds a whole provider configuration, so there is more of it.
```

- [ ] **Step 3: Run the suite**

Run: `./tests/run.sh`
Expected: all checks pass, exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document subscription import"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 数据模型 (`kind`, backward compatibility) | 4 (write), 5 (read) |
| 导入流程 (parse, fetch, validate, store) | 1, 2, 4 |
| 片段拆成 flag + name | 1 |
| `isSupportedUrl` 独立分支 | 1 (widen), 4 (branch in `addUrl`) |
| 抓不到就拒绝导入 | 4 |
| 连接流程 (cache first, non-blocking) | 5 |
| 后台刷新，不触碰运行中的进程 | 6 |
| `Gio.Cancellable` 清理 | 3, 6 |
| 错误处理表 | 4 (import), 5 (no cache), 6 (silent) |
| 测试策略 (pure functions + fixture + `sing-box check`) | 1, 2 |
| 网络层不做单元测试 | 3 |
| 安全与隐私 (plain text storage documented) | 7 |
| 明确不做 | Global Constraints |

No gaps.

**Placeholder scan:** No TBD, TODO, "handle edge cases", or "similar to Task N". Every code step carries the code.

**Type consistency:** `fetchText(url, cancellable, callback)` is declared in Task 3 and called with that arity in Tasks 4 and 6. `isValidRemoteConfig` returns `{ok, config, error}` in Task 2 and is destructured as `result.ok` / `result.config` / `result.error` in Tasks 4 and 6. `parseRemoteProfileLink` returns `{url, name, flag}` in Task 1 and is read as `profile.url` / `profile.name` / `profile.flag` in Task 4. `kind: 'profile'` is written in Task 4 and tested with `link.kind === 'profile'` in Tasks 4, 5 and 6.
