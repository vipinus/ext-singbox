project('sing-box-gnome-shell-extension', version: '1.0.0')

uuid = 'singbox@anyfq.com'
domain = 'gname-shell-extension-singbox'
datadir = get_option('datadir')
extensiondir = join_paths(datadir, 'gnome-shell', 'extensions', uuid)

install_data('metadata.json', 'extension.js', 'prefs.js',
  install_dir: extensiondir)
install_data('lib/config.js', 'lib/fetch.js', 'lib/singboxService.js',
  install_dir: join_paths(extensiondir, 'lib'))
install_data('icons/singbox-symbolic.svg',
  install_dir: join_paths(extensiondir, 'icons'))
install_data('schemas/org.gnome.shell.extensions.' + domain + '.gschema.xml',
  install_dir: join_paths(extensiondir, 'schemas'))
# README 刻意不装进扩展目录：那里只放运行时要用的文件，混进去的 README 正是
# 上传被 extensions.gnome.org 自动拒的原因之一（见 scripts/pack.sh）。
#
# ⚠️ meson 只装扩展本身，不装后端的 systemd 用户单元。走这条路安装的话，
# 还要手工做 install.sh 的另外两件事：装 systemd/singbox-ext.service 到
# ~/.config/systemd/user/，以及 scripts/privileged-setup.sh 那一步。

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
