#!/bin/sh
# Run every check that does not need a live GNOME Shell session.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DOMAIN='gname-shell-extension-singbox'
cd "$PROJECT_DIR"

status=0
step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAILED: %s\n' "$1" >&2; status=1; }

step 'Syntax check'
if command -v node >/dev/null 2>&1; then
    scratch=$(mktemp -d)
    trap 'rm -rf "$scratch"' EXIT
    for file in extension.js prefs.js lib/config.js tests/harness.js tests/config-test.js; do
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
