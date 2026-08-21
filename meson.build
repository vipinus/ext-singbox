project('sing-box-gnome-shell-extension', version: '1.0.0')

uuid = 'gname-shell-extension-singbox@gnome-shell-extension'
datadir = get_option('datadir')
extensiondir = join_paths(datadir, 'gnome-shell', 'extensions', uuid)

install_data('metadata.json', 'extension.js', 'prefs.js', 'stylesheet.css',
  install_dir: extensiondir)
install_data('schemas/org.gnome.shell.extensions.gname-shell-extension-singbox.gschema.xml',
  install_dir: join_paths(extensiondir, 'schemas'))
install_data('README.md', install_dir: extensiondir)
install_data('install.sh', install_dir: extensiondir)
install_data('scripts/privileged-setup.sh', install_dir: join_paths(extensiondir, 'scripts'))