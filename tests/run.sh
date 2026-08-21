#!/bin/sh
# Run every check that does not need a live GNOME Shell session.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DOMAIN='gname-shell-extension-singbox'
cd "$PROJECT_DIR"

status=0
step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAILED: %s\n' "$1" >&2; status=1; }

step 'Shell syntax'
# 排在所有步骤最前面：这个文件自己也是 sh 脚本，后面任何一步写错语法都会在
# 执行到那一行时才炸，而且症状看起来像那一步的逻辑问题。已经误诊过一次。
#
# 自动发现而不是写死清单：写死的话新加的脚本会悄悄漏检——scripts/update-pot.sh
# 就是这么加进来的。
shell_files=$(find . -name '*.sh' -not -path './.git/*' | sort)
shell_count=0
for file in $shell_files; do
    sh -n "$file" || fail "shell syntax: $file"
    shell_count=$((shell_count + 1))
done
printf 'checked %s shell scripts\n' "$shell_count"

step 'Syntax check'
if command -v node >/dev/null 2>&1; then
    scratch=$(mktemp -d)
    trap 'rm -rf "$scratch"' EXIT
    for file in extension.js prefs.js lib/config.js lib/fetch.js tests/harness.js tests/config-test.js; do
        cp "$file" "$scratch/$(echo "$file" | tr '/' '_').mjs"
    done
    for file in "$scratch"/*.mjs; do
        node --check "$file" || fail "syntax: $file"
    done
    printf 'parsed %s files\n' "$(ls "$scratch" | wc -l)"
else
    printf 'node not found, skipping the syntax check\n'
fi

step 'Unit tests'
if command -v gjs >/dev/null 2>&1; then
    gjs -m tests/config-test.js || fail 'unit tests'
else
    printf 'gjs not found, cannot run the unit tests\n' >&2
    fail 'gjs missing'
fi

step 'GSettings schema'
if command -v glib-compile-schemas >/dev/null 2>&1; then
    schema_out=$(mktemp -d)
    cp "schemas/org.gnome.shell.extensions.$DOMAIN.gschema.xml" "$schema_out/"
    glib-compile-schemas --strict "$schema_out" && printf 'schema compiles\n' || fail 'schema'
    rm -rf "$schema_out"
else
    printf 'glib-compile-schemas not found, skipping\n'
fi

step 'Translations'
if command -v msgfmt >/dev/null 2>&1; then
    while read -r lang; do
        [ -n "$lang" ] || continue
        msgfmt --check --statistics "po/$lang.po" -o /dev/null || fail "translation: $lang"
    done < po/LINGUAS
else
    printf 'msgfmt not found, skipping\n'
fi

step 'Translation template'
# CI 也做这项检查。放在这里是因为「推上去才发现模板过期」是纯粹的浪费——
# 而这类失败的 diff 全是无信息的行号漂移，看一眼还以为出了大事。
if command -v xgettext >/dev/null 2>&1; then
    regen=$(mktemp --suffix=.pot)
    ./scripts/update-pot.sh "$regen"
    # 用临时文件而不是 <(...)：进程替换是 bash 语法，这个文件是 #!/bin/sh。
    # 同一个坑在这个文件里已经踩过两次了。
    a=$(mktemp); b=$(mktemp)
    grep -v '^"POT-Creation-Date' po/gname-shell-extension-singbox.pot > "$a"
    grep -v '^"POT-Creation-Date' "$regen" > "$b"
    if diff -q "$a" "$b" >/dev/null; then
        printf 'template is up to date\n'
    else
        fail 'po template is stale; run ./scripts/update-pot.sh'
    fi
    rm -f "$regen" "$a" "$b"
else
    printf 'xgettext not found, skipping\n'
fi

step 'Privileged setup script'
# privileged-setup.sh 是唯一一个动系统安全策略的文件。它写进 /etc/polkit-1 的
# 那条规则决定了「谁能免密改 DNS」，所以这里锁死它的授权范围：语法要能过，
# 范围不能在没人注意时被放宽。
rule=$(sed -n '/<<RULE$/,/^RULE$/p' scripts/privileged-setup.sh | sed '1d;$d' |
    sed 's/\$TARGET_USER/testuser/')
if [ -z "$rule" ]; then
    fail 'could not extract the polkit rule template'
else
    if command -v node >/dev/null 2>&1; then
        rule_js=$(mktemp --suffix=.js)
        printf '%s\n' "$rule" > "$rule_js"
        node --check "$rule_js" || fail 'the polkit rule is not valid JavaScript'
        rm -f "$rule_js"
    fi

    # 三道护栏，缺一条这条规则就比设计的宽
    printf '%s' "$rule" | grep -q 'subject.user !== "testuser"' ||
        fail 'the polkit rule does not pin a single user'
    printf '%s' "$rule" | grep -q '!subject.local || !subject.active' ||
        fail 'the polkit rule does not require a local, active session'

    # 放行的 action 必须与设计完全一致——多一个都要在这里显式改
    granted=$(printf '%s\n' "$rule" |
        sed -n 's/^ *case "\(org\.freedesktop\.resolve1\.[a-z0-9-]*\)":$/\1/p' | sort)
    expected=$(printf '%s\n' \
        org.freedesktop.resolve1.revert \
        org.freedesktop.resolve1.set-default-route \
        org.freedesktop.resolve1.set-dns-over-tls \
        org.freedesktop.resolve1.set-dns-servers \
        org.freedesktop.resolve1.set-dnssec \
        org.freedesktop.resolve1.set-domains \
        org.freedesktop.resolve1.set-llmnr \
        org.freedesktop.resolve1.set-mdns | sort)
    if [ "$granted" = "$expected" ]; then
        printf 'polkit rule grants exactly the %s intended actions\n' \
            "$(printf '%s\n' "$granted" | wc -l)"
    else
        fail 'the polkit rule grants a different set of actions than intended'
        printf 'granted:\n%s\nexpected:\n%s\n' "$granted" "$expected" >&2
    fi
fi

# install.sh 靠 pkcheck 判断特权步骤能不能跳过。它查的 action 必须是规则真正
# 放行的子集——多查一个规则里没有的，pkcheck 永远返回未授权，跳过逻辑就成了摆设，
# 而且不会报错，只会表现为「每次装都还是要密码」，很难联想到是这里。
checked=$(sed -n 's/^ *for action in \(.*\); do$/\1/p' install.sh | tr ' ' '\n' |
    sed 's/^/org.freedesktop.resolve1./' | sort -u)
if [ -z "$checked" ]; then
    fail 'could not find the pkcheck action list in install.sh'
else
    # 用循环而不是 comm + <(...)：进程替换是 bash 语法，这个文件是 #!/bin/sh，
    # dash 直接语法错误（上面那条 sh -n 检查就是这么抓到的）。
    missing=''
    for action in $checked; do
        printf '%s\n' "$granted" | grep -qx "$action" || missing="$missing$action
"
    done
    if [ -z "$missing" ]; then
        printf 'install.sh checks %s actions, all granted by the rule\n' \
            "$(printf '%s\n' "$checked" | wc -l)"
    else
        fail 'install.sh checks actions the polkit rule does not grant'
        printf 'not granted:\n%s\n' "$missing" >&2
    fi
fi

step 'Extension metadata'
if command -v gjs >/dev/null 2>&1; then
    gjs -c 'const m = JSON.parse(new TextDecoder().decode(
        imports.gi.GLib.file_get_contents("metadata.json")[1]));
        for (const key of ["uuid", "name", "description", "version",
                           "shell-version", "settings-schema", "gettext-domain"])
            if (m[key] === undefined) throw new Error("metadata.json is missing " + key);
        print("metadata.json is complete");' || fail 'metadata'
fi

printf '\n'
if [ "$status" -eq 0 ]; then
    printf 'All checks passed.\n'
else
    printf 'Some checks failed.\n' >&2
fi
exit "$status"
