import GLib from 'gi://GLib';

import {
    accountInConfig,
    accountOf,
    buildSingBoxConfig,
    describeProcessFailure,
    format,
    flagRank,
    isRemoteProfileUrl,
    isSupportedUrl,
    isValidRemoteConfig,
    parseLinks,
    parseProxyUrl,
    maskAccount,
    parseRemoteProfileLink,
    regionKeyOf,
    sortLinks,
    subscriptionsUrl,
} from '../lib/config.js';

import {
    assert,
    assertEqual,
    assertThrows,
    assertValidSingBoxConfig,
    report,
    suite,
    test,
} from './harness.js';

const UUID = '11111111-2222-3333-4444-555555555555';

function b64(value) {
    return GLib.base64_encode(new TextEncoder().encode(value));
}

function outboundOf(config) {
    return config.outbounds[0];
}

suite('URL parsing');

test('splits userinfo, host and port', () => {
    const parsed = parseProxyUrl(`vless://${UUID}@example.com:8443?security=tls#Tokyo`);
    assertEqual(parsed.scheme, 'vless');
    assertEqual(parsed.username, UUID);
    assertEqual(parsed.hostname, 'example.com');
    assertEqual(parsed.port, '8443');
    assertEqual(parsed.fragment, 'Tokyo');
});

test('keeps passwords that contain an @ sign', () => {
    const parsed = parseProxyUrl('trojan://user:p%40ss@example.com:443');
    assertEqual(parsed.username, 'user');
    assertEqual(parsed.password, 'p@ss');
    assertEqual(parsed.hostname, 'example.com');
});

test('rejects a malformed link', () => {
    assertThrows(() => parseProxyUrl('not-a-link'));
});

suite('protocol outbounds');

test('vless carries uuid, tls and websocket transport', () => {
    const outbound = outboundOf(buildSingBoxConfig(
        `vless://${UUID}@example.com:443?security=tls&type=ws&path=/ray&host=cdn.example.com&sni=sni.example.com`));
    assertEqual(outbound.type, 'vless');
    assertEqual(outbound.uuid, UUID);
    assertEqual(outbound.tls.server_name, 'sni.example.com');
    assertEqual(outbound.transport, {type: 'ws', path: '/ray', headers: {Host: 'cdn.example.com'}});
});

test('trojan takes the password from the userinfo', () => {
    const outbound = outboundOf(buildSingBoxConfig('trojan://secret@example.com:443'));
    assertEqual(outbound.type, 'trojan');
    assertEqual(outbound.password, 'secret');
    assertEqual(outbound.tls.enabled, true);
});

test('shadowsocks decodes base64 method and password', () => {
    const outbound = outboundOf(buildSingBoxConfig(
        `ss://${b64('aes-256-gcm:hunter2')}@example.com:8388`));
    assertEqual(outbound.type, 'shadowsocks');
    assertEqual(outbound.method, 'aes-256-gcm');
    assertEqual(outbound.password, 'hunter2');
});

test('shadowsocks rejects credentials without a separator', () => {
    assertThrows(() => buildSingBoxConfig(`ss://${b64('nocolonhere')}@example.com:8388`));
});

test('vmess decodes its base64 json payload', () => {
    const outbound = outboundOf(buildSingBoxConfig(`vmess://${b64(JSON.stringify({
        add: 'example.com', port: '443', id: UUID, net: 'ws', path: '/v', tls: 'tls', host: 'cdn.example.com',
    }))}`));
    assertEqual(outbound.type, 'vmess');
    assertEqual(outbound.server, 'example.com');
    assertEqual(outbound.server_port, 443);
    assertEqual(outbound.tls.server_name, 'cdn.example.com');
    assertEqual(outbound.transport.type, 'ws');
});

test('insecure query parameter disables certificate verification', () => {
    const outbound = outboundOf(buildSingBoxConfig('trojan://secret@example.com:443?allowInsecure=1'));
    assertEqual(outbound.tls.insecure, true);
});

test('unsupported protocol is rejected', () => {
    assertThrows(() => buildSingBoxConfig('socks5://example.com:1080'));
});

suite('hysteria2 port hopping');

test('a dash range becomes a sing-box start:end range', () => {
    const outbound = outboundOf(buildSingBoxConfig('hysteria2://secret@example.com:443-500'));
    assertEqual(outbound.server_ports, ['443:500']);
    assertEqual(outbound.server_port, 443);
});

test('a comma list expands each single port into a range', () => {
    const outbound = outboundOf(buildSingBoxConfig('hysteria2://secret@example.com:443,8443'));
    assertEqual(outbound.server_ports, ['443:443', '8443:8443']);
});

test('a single port produces no server_ports at all', () => {
    const outbound = outboundOf(buildSingBoxConfig('hysteria2://secret@example.com:443'));
    assertEqual(outbound.server_ports, undefined);
});

test('obfs settings are carried over', () => {
    const outbound = outboundOf(buildSingBoxConfig(
        'hysteria2://secret@example.com:443?obfs=salamander&obfs-password=cover'));
    assertEqual(outbound.obfs, {type: 'salamander', password: 'cover'});
});

suite('generated configuration');

test('dns uses the sing-box 1.12+ server format', () => {
    const server = buildSingBoxConfig(`vless://${UUID}@example.com:443?security=tls`).dns.servers[0];
    assertEqual(server.type, 'https', 'dns server needs an explicit type');
    assertEqual(server.server, '1.1.1.1', 'dns server needs a bare host, not a url');
    assert(server.address === undefined, 'legacy "address" field must be gone');
});

test('no legacy block outbound is emitted', () => {
    const config = buildSingBoxConfig(`vless://${UUID}@example.com:443?security=tls`);
    assert(!config.outbounds.some(o => o.type === 'block'),
        'the legacy block outbound is unreferenced and deprecated');
});

test('tun inbound hijacks dns and routes everything through the proxy', () => {
    const config = buildSingBoxConfig(`vless://${UUID}@example.com:443?security=tls`);
    assertEqual(config.inbounds[0].auto_route, true);
    assertEqual(config.inbounds[0].strict_route, true);
    assertEqual(config.route.final, 'proxy');
    assert(config.route.rules.some(r => r.action === 'hijack-dns'), 'dns must be hijacked');
});

suite('sing-box accepts every generated configuration');

const ACCEPTED = [
    ['vless over tls', `vless://${UUID}@example.com:443?security=tls`],
    ['vless over websocket', `vless://${UUID}@example.com:443?security=tls&type=ws&path=/ray`],
    ['trojan', 'trojan://secret@example.com:443'],
    ['shadowsocks', `ss://${b64('aes-256-gcm:hunter2')}@example.com:8388`],
    ['vmess', `vmess://${b64(JSON.stringify({add: 'example.com', port: '443', id: UUID, tls: 'tls'}))}`],
    ['hysteria2', 'hysteria2://secret@example.com:443'],
    ['hysteria2 with port hopping', 'hysteria2://secret@example.com:443-500'],
    ['hysteria2 with a comma port list', 'hysteria2://secret@example.com:443,8443'],
];

ACCEPTED.forEach(([name, url]) => {
    test(name, () => assertValidSingBoxConfig(buildSingBoxConfig(url), name));
});

suite('backend failure reporting');

test('the fatal line is lifted out of sing-box log output', () => {
    const stderr = [
        '\x1b[31mERROR\x1b[0m[0000] something deprecated',
        '\x1b[31mFATAL\x1b[0m[0000] decode config at proxy.json: invalid uuid',
    ].join('\n');
    assertEqual(describeProcessFailure(stderr), 'decode config at proxy.json: invalid uuid');
});

test('an error line is used when there is no fatal line', () => {
    assertEqual(describeProcessFailure('\x1b[31mERROR\x1b[0m[0000] permission denied'),
        'permission denied');
});

test('unrecognised output falls back to its last non-empty line', () => {
    assertEqual(describeProcessFailure('starting\nsomething went wrong\n\n'),
        'something went wrong');
});

test('empty output still yields a usable message', () => {
    assert(describeProcessFailure('').length > 0, 'a message is always needed for the notification');
    assert(describeProcessFailure('   \n  ').length > 0, 'whitespace counts as empty');
});

test('a very long message is truncated for the notification', () => {
    const message = describeProcessFailure(`FATAL[0000] ${'x'.repeat(500)}`);
    assert(message.length <= 200, `expected a short message, got ${message.length} characters`);
});

suite('string interpolation');

test('placeholders are filled in order', () => {
    assertEqual(format('%s stopped: %s', 'Tokyo 01', 'invalid uuid'),
        'Tokyo 01 stopped: invalid uuid');
});

test('a missing value leaves an empty placeholder rather than "undefined"', () => {
    assertEqual(format('%s stopped: %s', 'Tokyo 01'), 'Tokyo 01 stopped: ');
});

test('a value containing a placeholder is not expanded again', () => {
    assertEqual(format('%s and %s', '%s', 'tail'), '%s and tail');
});

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

suite('link list handling');

test('an unknown flag sorts after every known country', () => {
    assert(flagRank('\u{1F1F3}\u{1F1F1}') > flagRank('\u{1F1E6}\u{1F1FA}'),
        'unknown flags belong at the end');
});

test('links are ordered by country and then by name', () => {
    const sorted = sortLinks([
        {flag: '\u{1F1FA}\u{1F1F8}', name: 'LA'},
        {flag: '\u{1F1F3}\u{1F1F1}', name: 'Amsterdam'},
        {flag: '\u{1F1ED}\u{1F1F0}', name: 'HK 02'},
        {flag: '\u{1F1ED}\u{1F1F0}', name: 'HK 01'},
    ]).map(l => l.name);
    assertEqual(sorted, ['HK 01', 'HK 02', 'LA', 'Amsterdam']);
});

test('malformed stored json yields an empty list', () => {
    assertEqual(parseLinks('{not json'), []);
});

test('entries without a url are discarded', () => {
    assertEqual(parseLinks('[{"url":"vless://a"},{"name":"broken"}]'), [{url: 'vless://a'}]);
});

test('only the supported schemes are importable', () => {
    assert(isSupportedUrl('hy2://a@b:443'), 'hy2 is an accepted alias');
    assert(isSupportedUrl('vmess://payload'), 'vmess is supported');
    assert(!isSupportedUrl('http://example.com'), 'plain http is not a proxy link');
});


// --- Bulk import from anyfq.com -------------------------------------------

const CFG = 'https://www.anyfq.com/api/v1/singbox/config?token=abc.def&region=us';

test('the subscription list URL reuses the same token and host', () => {
    assertEqual(subscriptionsUrl(CFG, 'zh-CN'),
        'https://www.anyfq.com/api/v1/singbox/subscriptions?token=abc.def&locale=zh-CN');
});

test('the subscription list URL keeps the mirror domain it came from', () => {
    // 站点有多个镜像域名，写死一个会让另外两个域名的用户跨站取配置
    assertEqual(subscriptionsUrl('https://8964.date/api/v1/singbox/config?token=t&region=jp', 'en'),
        'https://8964.date/api/v1/singbox/subscriptions?token=t&locale=en');
});

test('a configuration URL without a token is rejected up front', () => {
    // 不带令牌发出去只会换来一个 401，不如当场说清楚
    assertThrows(() => subscriptionsUrl('https://www.anyfq.com/api/v1/singbox/config', 'en'));
});

test('the dedupe key comes from the region parameter', () => {
    assertEqual(regionKeyOf({url: CFG}), 'us');
    assertEqual(regionKeyOf({url: CFG.replace('region=us', 'region=US')}), 'us');
});

test('the dedupe key ignores the token', () => {
    // ⚠️ 整个去重的要害：令牌每 24 小时轮换，同一地区两次导入的 URL 必然不同。
    // 按 URL 比对会让用户每点一次批量导入就多出一整套地区。
    assertEqual(regionKeyOf({url: CFG}),
        regionKeyOf({url: CFG.replace('abc.def', 'zzz.yyy')}));
});

test('share links fall back to the first hostname label', () => {
    // ⚠️ 用真实形状：端口位是多端口写法，userinfo 里有百分号编码的 @ 和 :。
    // 早先这里写的是简化链接，能过 GLib.Uri.parse，于是测试绿着而现实全挂。
    assertEqual(regionKeyOf({
        url: 'hysteria2://a%40b.com%3Apw@jp.fanq.in:8443,45000-49999/?insecure=1&sni=jp.fanq.in',
    }), 'jp');
    assertEqual(regionKeyOf({url: 'hysteria2://u%40x.com:pw@jp.fanq.in:8443/?sni=jp.fanq.in'}), 'jp');
});

test('an undecidable entry yields no dedupe key', () => {
    // 返回 null 表示「判断不了」，调用方按不重复处理：
    // 宁可多一条，也不该吞掉用户要的地区
    assertEqual(regionKeyOf({url: 'hysteria2://u:p@203.0.113.7:8443,45000-49999/'}), null);
    assertEqual(regionKeyOf({url: 'hysteria2://u:p@localhost:8443/'}), null);
    assertEqual(regionKeyOf(null), null);
    assertEqual(regionKeyOf({}), null);
});


test('the account is read from the embedded credential', () => {
    const cfg = {outbounds: [
        {type: 'hysteria2', password: 'Someone@Example.com:secret'},
        {type: 'direct'},
    ]};
    assertEqual(accountInConfig(cfg), 'someone@example.com');
    assertEqual(accountOf({config: cfg}), 'someone@example.com');
});

test('entries without a cached configuration have no account', () => {
    // 手工加的分享链接就是这种：能连，但扩展看不出它属于谁
    assertEqual(accountOf({url: 'hysteria2://a@b:443'}), null);
    assertEqual(accountInConfig(null), null);
    assertEqual(accountInConfig({outbounds: [{type: 'direct'}]}), null);
});

test('accounts are masked before being shown', () => {
    assertEqual(maskAccount('someone@example.com'), 'som***@example.com');
    assertEqual(maskAccount('ab@x.com'), 'ab***@x.com');
    assertEqual(maskAccount(null), '?');
});

imports.system.exit(report());

