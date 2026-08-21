import GLib from 'gi://GLib';

export const COUNTRY_ORDER = ['🇭🇰', '🇸🇬', '🇯🇵', '🇰🇷', '🇺🇸', '🇬🇧', '🇩🇪', '🇫🇷', '🇨🇦', '🇦🇺'];

export const SUPPORTED_SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2'];

export function isSupportedUrl(value) {
    if (isRemoteProfileUrl(value)) return true;
    return new RegExp(`^(${SUPPORTED_SCHEMES.join('|')}):\\/\\/`).test(value);
}

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

export function flagRank(flag) {
    const index = COUNTRY_ORDER.indexOf(flag);
    return index === -1 ? COUNTRY_ORDER.length : index;
}

export function sortLinks(links) {
    return [...links].sort((a, b) =>
        flagRank(a.flag) - flagRank(b.flag) ||
        (a.name || '').localeCompare(b.name || ''));
}

export function parseLinks(raw) {
    try {
        const links = JSON.parse(raw);
        return Array.isArray(links) ? links.filter(link => link && link.url) : [];
    } catch (_) {
        return [];
    }
}

export function decodeBase64(value) {
    return new TextDecoder().decode(
        GLib.base64_decode(value.replace(/-/g, '+').replace(/_/g, '/')));
}

function parseQuery(queryStr) {
    const params = {};
    if (!queryStr) return params;
    queryStr.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    });
    return params;
}

export function parseProxyUrl(rawUrl) {
    const match = rawUrl.match(/^([a-zA-Z0-9+-]+):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#(.*))?$/);
    if (!match) throw new Error('Invalid link format');

    const scheme = match[1].toLowerCase();
    const authority = match[2];
    const pathname = match[3] || '';
    const query = match[4] || '';
    const fragment = match[5] || '';

    let userinfo = '';
    let hostport = authority;
    const atIndex = authority.lastIndexOf('@');
    if (atIndex !== -1) {
        userinfo = authority.slice(0, atIndex);
        hostport = authority.slice(atIndex + 1);
    }

    let hostname = hostport;
    let port = '';
    const colonIndex = hostport.indexOf(':');
    if (colonIndex !== -1) {
        hostname = hostport.slice(0, colonIndex);
        port = hostport.slice(colonIndex + 1);
    }

    let username = '';
    let password = '';
    if (userinfo) {
        const userColon = userinfo.indexOf(':');
        if (userColon !== -1) {
            username = decodeURIComponent(userinfo.slice(0, userColon));
            password = decodeURIComponent(userinfo.slice(userColon + 1));
        } else {
            username = decodeURIComponent(userinfo);
        }
    }

    return {
        scheme,
        username,
        password,
        hostname,
        port,
        pathname,
        searchParams: parseQuery(query),
        fragment: decodeURIComponent(fragment),
    };
}

/**
 * sing-box expects every entry of `server_ports` to be a `start:end` range,
 * so a bare port has to be widened into a range of one.
 */
export function normalizePortRanges(port) {
    return port.split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0)
        .map(part => {
            const [start, end] = part.split(/[-:]/);
            return `${start}:${end ?? start}`;
        });
}

export function buildSingBoxConfig(uri) {
    const parsed = parseProxyUrl(uri);
    const server = parsed.hostname;

    let serverPort = 443;
    let serverPorts = null;
    if (parsed.port) {
        if (parsed.port.includes(',') || parsed.port.includes('-') || parsed.port.includes(':')) {
            serverPorts = normalizePortRanges(parsed.port);
            const firstPort = parseInt(serverPorts[0], 10);
            serverPort = isNaN(firstPort) ? 443 : firstPort;
        } else {
            serverPort = Number(parsed.port) || 443;
        }
    }

    const tls = parsed.searchParams.security === 'tls' || parsed.scheme === 'trojan' || parsed.scheme === 'hysteria2' || parsed.scheme === 'hy2';
    const tlsConfig = tls ? {
        enabled: true,
        server_name: parsed.searchParams.sni || server,
        insecure: parsed.searchParams.insecure === '1' || parsed.searchParams.allowInsecure === '1',
    } : undefined;

    let outbound;

    if (parsed.scheme === 'vless') {
        outbound = {
            type: 'vless',
            tag: 'proxy',
            server,
            server_port: serverPort,
            uuid: parsed.username,
        };
        if (tlsConfig) outbound.tls = tlsConfig;
        if (parsed.searchParams.type === 'ws') {
            outbound.transport = {
                type: 'ws',
                path: parsed.searchParams.path || '/',
                headers: parsed.searchParams.host ? {Host: parsed.searchParams.host} : undefined,
            };
        }
    } else if (parsed.scheme === 'trojan') {
        outbound = {
            type: 'trojan',
            tag: 'proxy',
            server,
            server_port: serverPort,
            password: parsed.password || parsed.username,
            tls: tlsConfig,
        };
    } else if (parsed.scheme === 'hysteria2' || parsed.scheme === 'hy2') {
        outbound = {
            type: 'hysteria2',
            tag: 'proxy',
            server,
            server_port: serverPort,
            password: parsed.password || parsed.username,
            tls: tlsConfig,
        };
        if (serverPorts && serverPorts.length > 0) {
            outbound.server_ports = serverPorts;
        }
        if (parsed.searchParams.obfs) {
            outbound.obfs = {
                type: parsed.searchParams.obfs,
                password: parsed.searchParams['obfs-password'] || '',
            };
        }
    } else if (parsed.scheme === 'ss') {
        const credentials = parsed.password
            ? `${parsed.username}:${parsed.password}`
            : decodeBase64(parsed.username || parsed.pathname);
        const separator = credentials.indexOf(':');
        if (separator < 1) throw new Error('Shadowsocks link is missing method or password');
        outbound = {
            type: 'shadowsocks',
            tag: 'proxy',
            server,
            server_port: serverPort,
            method: credentials.slice(0, separator),
            password: credentials.slice(separator + 1),
        };
    } else if (parsed.scheme === 'vmess') {
        const data = JSON.parse(decodeBase64(parsed.pathname || parsed.hostname));
        outbound = {
            type: 'vmess',
            tag: 'proxy',
            server: data.add,
            server_port: Number(data.port),
            uuid: data.id,
            security: data.scy || 'auto',
        };
        if (data.tls === 'tls') outbound.tls = {enabled: true, server_name: data.sni || data.host || data.add};
        if (data.net === 'ws') outbound.transport = {type: 'ws', path: data.path || '/', headers: data.host ? {Host: data.host} : undefined};
    } else {
        throw new Error(`Unsupported protocol: ${parsed.scheme}`);
    }

    return {
        log: {level: 'warn'},
        dns: {servers: [{tag: 'remote', type: 'https', server: '1.1.1.1', detour: 'proxy'}], final: 'remote', strategy: 'prefer_ipv4'},
        inbounds: [{type: 'tun', tag: 'tun-in', interface_name: 'singbox0', address: ['172.19.0.1/30'], auto_route: true, strict_route: true, stack: 'mixed'}],
        outbounds: [outbound, {type: 'direct', tag: 'direct'}],
        route: {auto_detect_interface: true, final: 'proxy', rules: [{action: 'sniff'}, {protocol: 'dns', action: 'hijack-dns'}]},
    };
}

const MAX_FAILURE_LENGTH = 200;

/**
 * Turn sing-box log output into a single line suitable for a desktop
 * notification, preferring the fatal error that actually stopped the process.
 *
 * The caller supplies the fallback so that it can be a translated string.
 */
export function describeProcessFailure(stderr, fallback = 'sing-box exited unexpectedly') {
    const lines = (stderr || '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const pick = level => lines.filter(line => line.startsWith(level)).pop();
    const line = pick('FATAL') ?? pick('ERROR') ?? lines.pop();
    if (!line) return fallback;

    const message = line.replace(/^[A-Z]+(\[\d+\])?\s*/, '').trim() || fallback;
    return message.length > MAX_FAILURE_LENGTH
        ? `${message.slice(0, MAX_FAILURE_LENGTH - 1)}…`
        : message;
}

/**
 * Fill `%s` placeholders left to right. GNOME Shell only installs
 * `String.prototype.format` for its own code, so extensions need their own.
 */
export function format(template, ...values) {
    let index = 0;
    return template.replace(/%s/g, () => {
        const value = values[index++];
        return value === undefined ? '' : String(value);
    });
}
