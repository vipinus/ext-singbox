project('sing-box-gnome-shell-extension', version: '1.0.0')

uuid = 'gname-shell-extension-singbox@gnome-shell-extension'
domain = 'gname-shell-extension-singbox'
datadir = get_option('datadir')
extensiondir = join_paths(datadir, 'gnome-shell', 'extensions', uuid)

install_data('metadata.json', 'extension.js', 'prefs.js',
  install_dir: extensiondir)
install_data('lib/config.js',
  install_dir: join_paths(extensiondir, 'lib'))
install_data('icons/singbox-symbolic.svg',
  install_dir: join_paths(extensiondir, 'icons'))
install_data('schemas/org.gnome.shell.extensions.' + domain + '.gschema.xml',
  install_dir: join_paths(extensiondir, 'schemas'))
install_data('README.md', install_dir: extensiondir)
install_data('install.sh', install_dir: extensiondir)
install_data('scripts/privileged-setup.sh', install_dir: join_paths(extensiondir, 'scripts'))

msgfmt = find_program('msgfmt', required: false)
if msgfmt.found()
  foreach lang : ['zh_CN']
    custom_target(lang + '.mo',
      input: join_paths('po', lang + '.po'),
      output: domain + '.mo',
      command: [msgfmt, '@INPUT@', '-o', '@OUTPUT@'],
      install: true,
      install_dir: join_paths(extensiondir, 'locale', lang, 'LC_MESSAGES'))
  endforeach
endif

# Compile the schema into the extension directory so the extension can find it
# without a system-wide schema installation.
meson.add_install_script('sh', '-c',
  'glib-compile-schemas "$MESON_INSTALL_DESTDIR_PREFIX/' + extensiondir + '/schemas"')
