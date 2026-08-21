import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

export function suite(name) {
    currentSuite = name;
    print(`\n  ${name}`);
}

export function test(name, fn) {
    try {
        fn();
        passed++;
        print(`    ${GREEN}PASS${RESET} ${name}`);
    } catch (error) {
        failed++;
        failures.push(`${currentSuite} > ${name}\n      ${error.message}`);
        print(`    ${RED}FAIL${RESET} ${name}`);
        print(`      ${RED}${error.message}${RESET}`);
    }
}

export function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
}

export function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${message ? message + ': ' : ''}expected ${e}, got ${a}`);
}

export function assertThrows(fn, message) {
    let threw = false;
    try {
        fn();
    } catch (_) {
        threw = true;
    }
    if (!threw) throw new Error(message || 'expected function to throw');
}

/**
 * Validate a generated configuration with the real sing-box binary.
 * Returns {ok, output}; ok is null when sing-box is unavailable.
 */
export function singBoxCheck(config) {
    const singBox = GLib.find_program_in_path('sing-box');
    if (!singBox) return {ok: null, output: 'sing-box not installed'};

    const [file, stream] = Gio.File.new_tmp('singbox-test-XXXXXX.json');
    const path = file.get_path();
    stream.get_output_stream().write_all(
        new TextEncoder().encode(JSON.stringify(config)), null);
    stream.close(null);

    const [, stdout, stderr, status] = GLib.spawn_sync(
        null, [singBox, 'check', '-c', path], null, GLib.SpawnFlags.DEFAULT, null);
    GLib.unlink(path);

    const output = `${new TextDecoder().decode(stdout)}${new TextDecoder().decode(stderr)}`;
    return {ok: status === 0, output: output.trim()};
}

export function assertValidSingBoxConfig(config, message) {
    const {ok, output} = singBoxCheck(config);
    if (ok === null) {
        print(`      ${YELLOW}skipped sing-box validation: ${output}${RESET}`);
        return;
    }
    if (!ok)
        throw new Error(`${message ? message + ': ' : ''}sing-box rejected the config:\n      ${output}`);
}

export function report() {
    print('');
    if (failed > 0) {
        print(`${RED}  ${failed} failing, ${passed} passing${RESET}\n`);
        failures.forEach(f => print(`  ${RED}FAIL${RESET} ${f}`));
        print('');
        return 1;
    }
    print(`${GREEN}  ${passed} passing${RESET}\n`);
    return 0;
}
