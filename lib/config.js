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

// ---------------------------------------------------------------------------
// 从 anyfq.com 批量导入
// ---------------------------------------------------------------------------

/**
 * 由一条配置 URL 推导出批量订阅清单的地址。
 *
 * 复用调用方**已经持有**的那把令牌，不新签：令牌的 24 小时窗口是「二维码能被
 * 兑换成配置」的时限，不该因为拉了一次清单就重置。主机也原样沿用，因为站点有
 * 多个镜像域名（anyfq.com / 7d24hrs.com / 8964.date），用户是从哪个域名拿到的
 * 订阅，就继续跟哪个域名说话——写死一个会让另外两个域名的用户跨站取配置。
 */
export function subscriptionsUrl(configUrl, locale) {
    const uri = GLib.Uri.parse(configUrl, GLib.UriFlags.NONE);
    const token = parseQuery(uri.get_query() || '').token;
    if (!token) throw new Error('Configuration URL carries no token');

    const port = uri.get_port();
    const base = `${uri.get_scheme()}://${uri.get_host()}${port > 0 ? `:${port}` : ''}`;
    return `${base}/api/v1/singbox/subscriptions` +
        `?token=${encodeURIComponent(token)}&locale=${encodeURIComponent(locale || 'en')}`;
}

/**
 * 某个条目代表哪个地区——批量导入的去重键。
 *
 * ⚠️ 不能按 URL 去重。订阅 URL 里的令牌每 24 小时轮换，同一个地区两次导入的
 * URL 必然不同，按 URL 比对等于每次都新增一份，用户点两次就会看到两套地区。
 *
 * 订阅条目取 `region` 查询参数；手工加的分享链接没有这个参数，退而取主机名的
 * 第一段（`jp.fanq.in` → `jp`）——这是启发式而非契约，但它挡住了「已经手工加过
 * 日本、批量导入又塞一个日本」这个最常见的重复。取不到就返回 null，表示
 * 「无法判断」，调用方应当按不重复处理：宁可多一条，不可吞掉用户要的地区。
 */
export function regionKeyOf(link) {
    if (!link || typeof link.url !== 'string') return null;

    // ⚠️ 不能用 GLib.Uri.parse：真实的 hysteria2 分享链接端口位是多端口写法
    // （`jp.fanq.in:8443,45000-49999`），它按 RFC 3986 不是合法端口，解析直接抛错。
    // 第一版正是这么写的，单测里用了简化过的链接所以是绿的，拿真实数据一跑
    // 才发现所有分享链接都退化成 null——测试比现实宽容，等于没测。
    const region = /[?&]region=([^&#]*)/.exec(link.url);
    if (region && region[1]) return decodeURIComponent(region[1]).toLowerCase();

    // 主机名：跳过可选的 userinfo（里面可能有百分号编码的 @ 和 :），
    // 在遇到 / : , ? # 之前的那一段就是主机。
    const host = /^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?([^/:,?#]+)/i.exec(link.url);
    if (!host) return null;

    const first = host[1].split('.')[0];
    // 单段主机名（localhost）或 IP 字面量不算地区
    if (!first || first === host[1] || /^\d+$/.test(first)) return null;
    return first.toLowerCase();
}

/** 当前语言，形如 zh-CN；取不到时用 en。服务端只认白名单，其余回退英文 */
export function localeTag() {
    for (const name of GLib.get_language_names()) {
        const base = (name || '').split('.')[0].replace('_', '-');
        if (base && base !== 'C') return base;
    }
    return 'en';
}

/**
 * 一份配置属于哪个账号。
 *
 * 凭据在 hysteria2 出站的 `password` 里，形如 `邮箱:密码`，冒号前那段就是账号。
 * 这是服务端下发配置的既有契约（`src/lib/singbox.ts` 里 credential 就是这么拼的），
 * 不是这里新发明的约定。
 *
 * 用它而不是解令牌：令牌的载荷格式是服务端内部实现，扩展不该依赖；而配置结构
 * 本来就是两边共同维护的契约，还有 fixture 和 sing-box check 兜着。
 */
export function accountInConfig(config) {
    const outbounds = config && config.outbounds;
    if (!Array.isArray(outbounds)) return null;
    for (const outbound of outbounds) {
        const pw = outbound && outbound.password;
        if (typeof pw === 'string' && pw.includes(':'))
            return pw.slice(0, pw.indexOf(':')).toLowerCase();
    }
    return null;
}

/** 某个已存条目属于哪个账号；手工加的分享链接没有缓存配置，返回 null */
export function accountOf(link) {
    return accountInConfig(link && link.config);
}

/** 打码显示账号，用于提示文案——完整邮箱没必要出现在弹框里 */
export function maskAccount(account) {
    if (!account) return '?';
    const at = account.indexOf('@');
    if (at <= 0) return `${account.slice(0, 3)}***`;
    return `${account.slice(0, Math.min(3, at))}***${account.slice(at)}`;
}
