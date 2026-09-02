// 后端服务层的单元测试：配置文件的写法，以及 systemd D-Bus 调用的形状。
//
// 不需要活着的 gnome-shell，也不需要真的 systemd：总线换成一个替身对象，
// lib/singboxService.js 只依赖 Gio/GLib/GObject，裸 gjs 就能整个 import 进来。

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    SingBoxService,
    UNIT,
    configDir,
    configPath,
    removeConfig,
    writeConfig,
} from '../lib/singboxService.js';

import {
    assert,
    assertEqual,
    asyncTest,
    report,
    suite,
    test,
} from './harness.js';

const UNIT_OBJECT_PATH = '/org/freedesktop/systemd1/unit/singbox_2dext_2eservice';
const JOB_PATH = '/org/freedesktop/systemd1/job/1';

/**
 * 会话总线的替身：记下每一次调用，按方法名返回事先摆好的答案。
 *
 * 只实现 SingBoxService 真正用到的三个方法（call / signal_subscribe /
 * signal_unsubscribe），多实现的部分不会被测到，等于自欺。
 */
class FakeBus {
    constructor(handlers) {
        this.handlers = handlers;
        this.calls = [];
        this.subscriptions = new Map();
        this.unsubscribed = [];
        this._nextId = 1;
    }

    async call(_name, path, iface, method, params, _replyType, _flags, _timeout, cancellable) {
        this.calls.push({path, iface, method, cancellable,
            args: params ? params.deep_unpack() : null});
        const handler = this.handlers[method];
        if (!handler) throw new Error(`unexpected method ${method}`);
        return handler(params);
    }

    signal_subscribe(_name, iface, signal, path, _arg0, _flags, callback) {
        const id = this._nextId++;
        this.subscriptions.set(id, {iface, signal, path, callback});
        return id;
    }

    signal_unsubscribe(id) {
        this.unsubscribed.push(id);
        this.subscriptions.delete(id);
    }

    /** 模拟 systemd 广播一次单元属性变化。 */
    emitActiveState(state) {
        for (const {path, callback} of this.subscriptions.values()) {
            callback(this, ':1.2', path,
                'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                new GLib.Variant('(sa{sv}as)', [
                    'org.freedesktop.systemd1.Unit',
                    {ActiveState: new GLib.Variant('s', state)},
                    [],
                ]));
        }
    }

    methodNames() {
        return this.calls.map(call => call.method);
    }
}

function busWith({loadState = 'loaded', activeState = 'inactive', getUnitFails = false} = {}) {
    const objectPath = () => new GLib.Variant('(o)', [UNIT_OBJECT_PATH]);
    return new FakeBus({
        GetUnit: () => {
            if (getUnitFails) throw new Error('Unit singbox-ext.service not loaded.');
            return objectPath();
        },
        LoadUnit: objectPath,
        Subscribe: () => null,
        Unsubscribe: () => null,
        Get: params => {
            const [, name] = params.deep_unpack();
            const value = name === 'LoadState' ? loadState : activeState;
            return new GLib.Variant('(v)', [new GLib.Variant('s', value)]);
        },
        StartUnit: () => new GLib.Variant('(o)', [JOB_PATH]),
        StopUnit: () => new GLib.Variant('(o)', [JOB_PATH]),
        RestartUnit: () => new GLib.Variant('(o)', [JOB_PATH]),
    });
}

// --- 配置文件 -------------------------------------------------------------

suite('generated configuration file');

test('the config path is the one the systemd unit reads', () => {
    // 这条是跨文件契约：单元里写死 %h/.config/…，代码里必须逐字对上，
    // 否则 sing-box 会去读一个不存在（或过期）的文件，而且不会报错到界面上。
    const [ok, contents] = GLib.file_get_contents('systemd/singbox-ext.service');
    assert(ok, 'systemd/singbox-ext.service is missing');

    const unit = new TextDecoder().decode(contents);
    const execStart = unit.split('\n').find(line => line.startsWith('ExecStart='));
    assert(execStart, 'the unit has no ExecStart line');

    const configArgument = execStart.split(/\s+/).pop();
    assertEqual(configArgument.replace('%h', GLib.get_home_dir()), configPath());
});

test('the config lives under the home directory, not XDG_CONFIG_HOME', () => {
    // get_user_config_dir() 会跟着 XDG_CONFIG_HOME 走，而单元里的 %h 不会。
    assertEqual(configPath(),
        `${GLib.get_home_dir()}/.config/sing-box/ext/config.json`);
    assertEqual(configDir(), `${GLib.get_home_dir()}/.config/sing-box/ext`);
});

test('writing creates a 0700 directory and a 0600 file, with no chmod', () => {
    const root = GLib.dir_make_tmp('singbox-config-XXXXXX');
    const path = GLib.build_filenamev([root, 'ext', 'config.json']);

    writeConfig({log: {level: 'warn'}}, path);

    assertEqual(mode(GLib.path_get_dirname(path)), 0o700, 'directory mode');
    assertEqual(mode(path), 0o600, 'file mode');

    const [, contents] = GLib.file_get_contents(path);
    assertEqual(JSON.parse(new TextDecoder().decode(contents)), {log: {level: 'warn'}});

    removeConfig(path);
    GLib.rmdir(GLib.path_get_dirname(path));
    GLib.rmdir(root);
});

test('rewriting an existing world-readable file still ends up 0600', () => {
    // 这正是原来那句 GLib.chmod 在补的事。REPLACE_DESTINATION 少了的话，
    // 替换会就地截断、沿用旧权限位，PRIVATE 等于没写——测试要能抓住这一点。
    const root = GLib.dir_make_tmp('singbox-config-XXXXXX');
    const path = GLib.build_filenamev([root, 'config.json']);
    GLib.file_set_contents(path, '{}');
    GLib.chmod(path, 0o644);
    assertEqual(mode(path), 0o644, 'precondition');

    writeConfig({outbounds: []}, path);
    assertEqual(mode(path), 0o600, 'file mode after the rewrite');

    removeConfig(path);
    GLib.rmdir(root);
});

test('removing a config that is not there is not an error', () => {
    const root = GLib.dir_make_tmp('singbox-config-XXXXXX');
    removeConfig(GLib.build_filenamev([root, 'nothing.json']));
    GLib.rmdir(root);
});

function mode(path) {
    const info = Gio.File.new_for_path(path).query_info(
        'unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    return info.get_attribute_uint32('unix::mode') & 0o777;
}

// --- systemd 调用 ---------------------------------------------------------

suite('systemd user unit');

asyncTest('start, stop and restart address the right unit with the right job mode', async () => {
    for (const [method, call] of [['StartUnit', 'start'], ['StopUnit', 'stop'], ['RestartUnit', 'restart']]) {
        const bus = busWith();
        const service = new SingBoxService({bus});
        const job = await service[call]();

        assertEqual(job, JOB_PATH, `${call}() returns the job path`);
        const sent = bus.calls.find(entry => entry.method === method);
        assert(sent, `${call}() sends ${method}`);
        assertEqual(sent.args, [UNIT, 'replace'], `${method} arguments`);
        assertEqual(sent.path, '/org/freedesktop/systemd1', `${method} object path`);
        service.destroy();
    }
});

asyncTest('the unit name matches the file install.sh installs', async () => {
    assertEqual(UNIT, 'singbox-ext.service');
    assert(GLib.file_test('systemd/singbox-ext.service', GLib.FileTest.EXISTS),
        'the unit file is missing');
    // 单元刻意不带 [Install]：它是按需启动的，不该被 enable 进 default.target。
    const [, contents] = GLib.file_get_contents('systemd/singbox-ext.service');
    const unit = new TextDecoder().decode(contents);
    assert(!/^WantedBy=/m.test(unit), 'the unit must not be wanted by any target');
    assert(/^Restart=no$/m.test(unit), 'the unit must not restart on its own');
});

asyncTest('a missing unit reads as not installed instead of throwing', async () => {
    const missing = new SingBoxService({bus: busWith({loadState: 'not-found'})});
    assertEqual(await missing.isInstalled(), false);
    missing.destroy();

    const installed = new SingBoxService({bus: busWith({loadState: 'loaded'})});
    assertEqual(await installed.isInstalled(), true);
    installed.destroy();
});

asyncTest('the active state is read from the Unit interface', async () => {
    const bus = busWith({activeState: 'active'});
    const service = new SingBoxService({bus});

    assertEqual(await service.state(), 'active');
    assertEqual(await service.isActive(), true);

    const get = bus.calls.find(entry => entry.method === 'Get');
    assertEqual(get.args, ['org.freedesktop.systemd1.Unit', 'ActiveState']);
    assertEqual(get.path, UNIT_OBJECT_PATH);
    service.destroy();
});

asyncTest('a bus that refuses everything reads as inactive, not as a crash', async () => {
    const service = new SingBoxService({bus: new FakeBus({})});
    assertEqual(await service.state(), 'inactive');
    assertEqual(await service.isActive(), false);
    assertEqual(await service.isInstalled(), false);
    service.destroy();
});

asyncTest('a unit that was never started is resolved through LoadUnit', async () => {
    // GetUnit 只认已经加载进内存的单元。第一次连接时它必然失败，落到 LoadUnit。
    const bus = busWith({getUnitFails: true});
    const service = new SingBoxService({bus});

    assertEqual(await service.state(), 'inactive');
    assert(bus.methodNames().includes('LoadUnit'), 'LoadUnit was not tried');
    service.destroy();
});

asyncTest('Subscribe is sent before listening, or systemd never broadcasts', async () => {
    const bus = busWith();
    const service = new SingBoxService({bus});
    await service.state();

    assert(bus.methodNames().includes('Subscribe'),
        'without Manager.Subscribe() no PropertiesChanged ever arrives');
    assertEqual(bus.subscriptions.size, 1, 'exactly one signal subscription');
    const [subscription] = [...bus.subscriptions.values()];
    assertEqual(subscription.signal, 'PropertiesChanged');
    assertEqual(subscription.path, UNIT_OBJECT_PATH);
    service.destroy();
});

asyncTest('an ActiveState change is re-emitted as active-changed', async () => {
    const bus = busWith();
    const service = new SingBoxService({bus});
    await service.state();

    const seen = [];
    service.connect('active-changed', (_service, state) => seen.push(state));

    bus.emitActiveState('activating');
    bus.emitActiveState('active');
    bus.emitActiveState('failed');

    assertEqual(seen, ['activating', 'active', 'failed']);
    service.destroy();
});

asyncTest('destroy unsubscribes and stops delivering signals', async () => {
    const bus = busWith();
    const service = new SingBoxService({bus});
    await service.state();

    const id = [...bus.subscriptions.keys()][0];
    const seen = [];
    service.connect('active-changed', (_service, state) => seen.push(state));

    service.destroy();

    assertEqual(bus.unsubscribed, [id], 'the signal subscription is released');
    assert(bus.methodNames().includes('Unsubscribe'),
        'systemd is told to stop broadcasting to us');
    assertEqual(bus.subscriptions.size, 0);
    assertEqual(seen, [], 'no signal can arrive after destroy');
    assert(service._cancellable.is_cancelled(), 'in-flight calls are cancelled');
});

imports.system.exit(report());
