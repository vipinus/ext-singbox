// singboxService.js — 通过会话总线驱动 systemd 用户单元 singbox-ext.service。
//
// 为什么是这个形状：extensions.gnome.org 的审查规则里有两条卡死了原来的做法——
// 扩展不能执行来自设置里的命令字符串（那等于把任意命令执行藏在一个可编辑的
// 文本框里），也不能在 gnome-shell 进程里养一个活得比扩展还久的守护进程。
// 所以后端改由 systemd 的**用户实例**托管，扩展只负责发 StartUnit/StopUnit，
// 并订阅 ActiveState 的变化。
//
// 用户实例不需要 polkit：调用者就是这些单元的所有者，systemd 直接放行。
// 这和 tor-ext 走系统总线 + polkit 规则的那套是两码事，那边的单元跑在 root 下。
//
// 这个文件只依赖 Gio/GLib/GObject，不碰 resource:///org/gnome/shell/*，
// 所以 tests/service-test.js 能在裸 gjs 里把它整个 import 进去测。

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BUS_NAME = 'org.freedesktop.systemd1';
const MGR_PATH = '/org/freedesktop/systemd1';
const MGR_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

/** 单元名。install.sh 把 systemd/singbox-ext.service 装到用户单元目录下。 */
export const UNIT = 'singbox-ext.service';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

/**
 * 生成的配置放哪。
 *
 * ⚠️ 用 get_home_dir() 而不是 get_user_config_dir()：真正读这个文件的是单元里的
 * `ExecStart=… -c %h/.config/sing-box/ext/config.json`，systemd 的 %h 就是家目录。
 * 若这里跟着 XDG_CONFIG_HOME 走，而单元写死 %h/.config，设了那个变量的机器上
 * 两边就会指向不同的文件——症状是「连接后 sing-box 起不来或用的是上一次的配置」。
 * tests/service-test.js 会把这两处对拍，改任何一处都得改另一处。
 */
export function configDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.config', 'sing-box', 'ext']);
}

export function configPath() {
    return GLib.build_filenamev([configDir(), 'config.json']);
}

/**
 * 写入生成的配置，返回它的路径。
 *
 * `path` 只为测试留了一个口子：默认就是 configPath()，扩展从不传它——
 * 路径是和单元文件之间的契约，不该是可配置的。
 *
 * 这里不用 GLib.chmod：EGO 的审查会盯着扩展改文件权限位这种动作。改成
 * 「创建时就带对权限」——目录用 mkdir 的 mode 参数，文件用 Gio 的 PRIVATE 标志。
 */
export function writeConfig(config, path = configPath()) {
    const dir = GLib.path_get_dirname(path);
    // 0700 只作用于 mkdir 新建出来的那几层（这是 mkdir 语义，不是 chmod）：
    // 目录已经存在时不动它的权限，扩展没有理由去改用户自己设的位。
    if (GLib.mkdir_with_parents(dir, 0o700) !== 0)
        throw new Error(`could not create ${dir}`);

    const file = Gio.File.new_for_path(path);
    const bytes = new TextEncoder().encode(JSON.stringify(config, null, 2));

    // PRIVATE：新建出来的文件是 0600——这份配置里带着节点凭据。
    // REPLACE_DESTINATION：替换时走「新建 + 改名」而不是就地截断。就地截断会
    // 沿用旧文件的权限位，PRIVATE 就等于没写；这正是 chmod 原来在补的那件事。
    file.replace_contents(bytes, null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    return path;
}

/** 删掉生成的配置。文件不在也算成功。 */
export function removeConfig(path = configPath()) {
    GLib.unlink(path);
}

export const SingBoxService = GObject.registerClass({
    Signals: {
        // "active" | "activating" | "deactivating" | "inactive" | "failed"
        'active-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class SingBoxService extends GObject.Object {
    /**
     * @param {object} params - `bus` 可以传一个替身，测试用；默认会话总线。
     */
    _init(params = {}) {
        super._init();
        this._bus = params.bus ?? Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._unitPath = null;
        this._unitPathPromise = null;
        this._subscribePromise = null;
        this._propsSubId = 0;
        this._subscribed = false;
    }

    get unit() {
        return UNIT;
    }

    async _call(objectPath, iface, method, params, replyType) {
        return this._bus.call(
            BUS_NAME, objectPath, iface, method, params, replyType,
            // 没有 ALLOW_INTERACTIVE_AUTHORIZATION：用户实例不走 polkit，
            // 带上它只会让人以为这里可能弹窗。
            Gio.DBusCallFlags.NONE, -1, this._cancellable);
    }

    /**
     * 拿到单元的对象路径，顺带把属性订阅挂上。
     *
     * ⚠️ 记的是 **Promise** 而不是解析完的路径：两个调用并发进来时（磁贴点一下
     * 就会同时发出 isInstalled() 和 state()），只记结果的话两边都会看到「还没解析」
     * 而各跑一遍，`signal_subscribe()` 挂两个 handler，destroy() 只退得掉最后一个
     * ——禁用扩展后仍有回调活着。失败不留缓存，总线一时不可用不该把后面每次调用
     * 都钉死在同一个错误上。
     */
    async _getUnitPath() {
        if (!this._unitPathPromise) {
            this._unitPathPromise = this._resolveUnitPath().catch(error => {
                this._unitPathPromise = null;
                throw error;
            });
        }
        return this._unitPathPromise;
    }

    async _resolveUnitPath() {
        let path;
        try {
            const ret = await this._call(MGR_PATH, MGR_IFACE, 'GetUnit',
                new GLib.Variant('(s)', [UNIT]), new GLib.VariantType('(o)'));
            [path] = ret.deep_unpack();
        } catch (_error) {
            // GetUnit 只认已经加载进内存的单元，没启动过就会报错。LoadUnit 会
            // 把它加载起来，而且对根本不存在的单元也返回一个对象（LoadState
            // 是 not-found）——「装没装」交给 isInstalled() 判，不在这里抛。
            const ret = await this._call(MGR_PATH, MGR_IFACE, 'LoadUnit',
                new GLib.Variant('(s)', [UNIT]), new GLib.VariantType('(o)'));
            [path] = ret.deep_unpack();
        }

        this._unitPath = path;
        await this._subscribe();
        return path;
    }

    /**
     * 订阅这个单元的属性变化。
     *
     * ⚠️ Manager.Subscribe() 不能省：systemd 只向调用过它的客户端广播单元属性
     * 变化，不调的话 PropertiesChanged 一条都收不到——表现是「连上了但磁贴不变」。
     */
    async _subscribe() {
        // 同样记 Promise：_getUnitPath() 的并发保护落在这里之前，这一层自己
        // 也得防住——`if (this._propsSubId)` 这个判断在 await 之前就跑完了，
        // 挡不住两个并发调用都走到下面的 signal_subscribe()。
        //
        // 失败同样不留缓存，理由和 _getUnitPath() 一样：订阅挂了一次就永远
        // 不再重试的话，磁贴会一直收不到状态变化，而且看不出哪里坏了。
        if (!this._subscribePromise) {
            this._subscribePromise = this._doSubscribe().catch(error => {
                this._subscribePromise = null;
                throw error;
            });
        }
        return this._subscribePromise;
    }

    async _doSubscribe() {
        if (this._propsSubId || !this._unitPath) return;

        if (!this._subscribed) {
            try {
                await this._call(MGR_PATH, MGR_IFACE, 'Subscribe', null, null);
                this._subscribed = true;
            } catch (_error) {
                // 已经订阅过会报错，那不影响后面收信号。
            }
        }

        this._propsSubId = this._bus.signal_subscribe(
            BUS_NAME, PROPS_IFACE, 'PropertiesChanged',
            this._unitPath, UNIT_IFACE,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                const [, changed] = params.deep_unpack();
                if (changed && 'ActiveState' in changed)
                    this.emit('active-changed', changed['ActiveState'].deep_unpack());
            });
    }

    async _property(iface, name) {
        const path = await this._getUnitPath();
        const ret = await this._call(path, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [iface, name]), new GLib.VariantType('(v)'));
        const [variant] = ret.deep_unpack();
        return variant.deep_unpack();
    }

    /** 单元文件在不在。装之前用户点开关，得到的应该是一句人话而不是 D-Bus 报错。 */
    async isInstalled() {
        try {
            return (await this._property(UNIT_IFACE, 'LoadState')) !== 'not-found';
        } catch (_error) {
            return false;
        }
    }

    /** 当前 ActiveState；总线上出了任何问题都当作没在跑。 */
    async state() {
        try {
            return await this._property(UNIT_IFACE, 'ActiveState');
        } catch (_error) {
            return 'inactive';
        }
    }

    /**
     * 「在跑」比「active」宽：activating / deactivating / reloading 都算。
     *
     * ⚠️ 换服务器时这个判断决定发 StartUnit 还是 RestartUnit。把 activating
     * 当成「没在跑」会走 StartUnit——systemd 会把它并进正在进行的那个启动任务里，
     * 而配置文件已经被覆盖成 B：跑着的是 A，界面显示的是 B，谁都看不出来。
     */
    async isRunning() {
        const state = await this.state();
        return state !== 'inactive' && state !== 'failed';
    }

    async start() {
        return this._jobCall('StartUnit');
    }

    async stop() {
        return this._jobCall('StopUnit');
    }

    /** 换服务器要重启：配置文件是同一个路径，sing-box 只在启动时读一次。 */
    async restart() {
        return this._jobCall('RestartUnit');
    }

    async _jobCall(method) {
        const ret = await this._call(MGR_PATH, MGR_IFACE, method,
            new GLib.Variant('(ss)', [UNIT, 'replace']),
            new GLib.VariantType('(o)'));
        const [jobPath] = ret.deep_unpack();
        return jobPath;
    }

    /**
     * 断干净：退订信号、取消在途请求。
     *
     * 刻意不停单元——后端归 systemd 管，禁用扩展或重启 gnome-shell 都不该
     * 把用户的连接掐掉，这正是搬到 systemd 的目的之一。
     */
    destroy() {
        if (this._propsSubId) {
            try {
                this._bus.signal_unsubscribe(this._propsSubId);
            } catch (_error) {
                // 总线已经没了
            }
            this._propsSubId = 0;
        }

        // ⚠️ 刻意**不**发 Manager.Unsubscribe：会话总线连接是整个 gnome-shell
        // 共用的，Subscribe/Unsubscribe 是按连接计的，退订会把同一个进程里别的
        // 订阅者（别的扩展、shell 自己）一起弄哑。退掉自己那个 signal handler
        // 就够了——多留一个进程级订阅只是让 systemd 多发几条信号，没人监听。
        this._subscribed = false;
        this._unitPathPromise = null;
        this._subscribePromise = null;

        try {
            this._cancellable.cancel();
        } catch (_error) {
            // 已经取消过
        }
    }
});
