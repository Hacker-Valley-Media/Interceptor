// Owned Linux parity fixture. GTK 3 under gjs exposes AT-SPI. State changes
// are written to <statusDir>/state.json so batch checks can confirm an action landed.
// Usage: gjs linux-fixture.js <statusDir>
imports.gi.versions.Gtk = '3.0';
const { Gtk, GLib, Gdk } = imports.gi;
Gtk.init(null);
const statusDir = ARGV[0] || GLib.get_tmp_dir();
const state = { input: '', result: 'Not submitted', menu: 'unchanged', checkbox: false, combo: '', scroll: 'unchanged', drag: 'unchanged', keys: [], clicks: 0 };
const save = () => GLib.file_set_contents(GLib.build_filenamev([statusDir, 'state.json']), JSON.stringify(state));
const named = (widget, name) => { widget.get_accessible().set_name(name); return widget; };

const window = new Gtk.Window({ title: 'Interceptor Parity Fixture', default_width: 560, default_height: 760 });
const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin: 12 });
const bar = new Gtk.MenuBar(), file = new Gtk.MenuItem({ label: 'File' }), menu = new Gtk.Menu(), mark = new Gtk.MenuItem({ label: 'Mark fixture' });
file.set_submenu(menu); menu.append(mark); bar.append(file);
const menuStatus = named(new Gtk.Label({ label: 'Menu fixture unchanged' }), 'Menu fixture status');
mark.connect('activate', () => { menuStatus.set_text('Menu fixture invoked'); state.menu = 'invoked'; save(); });
const input = named(new Gtk.Entry(), 'Fixture input');
input.connect('changed', () => { state.input = input.get_text(); save(); });
// Keys are recorded at the window: compositor key delivery reaches the window's focus widget.
window.connect('key-press-event', (_w, event) => {
  const [, keyval] = event.get_keyval(), [, mods] = event.get_state();
  state.keys.push(((mods & Gdk.ModifierType.CONTROL_MASK) ? 'Ctrl+' : '') + ((mods & Gdk.ModifierType.SHIFT_MASK) ? 'Shift+' : '') + Gdk.keyval_name(keyval));
  save(); return false;
});
const submit = new Gtk.Button({ label: 'Submit fixture' });
const result = named(new Gtk.Label({ label: 'Not submitted' }), 'Fixture result');
submit.connect('clicked', () => { result.set_text('Submitted: ' + input.get_text()); state.result = result.get_text(); state.clicks++; save(); });
const password = named(new Gtk.Entry({ visibility: false, text: 'PARITY-SYNTHETIC-SECRET' }), 'Fixture password');
const readonly = named(new Gtk.Entry({ editable: false, text: 'UNCHANGED READ ONLY' }), 'Read-only fixture input');
const disabled = named(new Gtk.Entry({ sensitive: false, text: 'UNCHANGED DISABLED' }), 'Disabled fixture input');
const disabledButton = new Gtk.Button({ label: 'Disabled fixture button', sensitive: false });
const check = new Gtk.CheckButton({ label: 'Fixture checkbox' });
check.connect('toggled', () => { state.checkbox = check.get_active(); save(); });
const combo = named(new Gtk.ComboBoxText(), 'Fixture combo');
for (const item of ['One', 'Two', 'Three']) combo.append_text(item);
combo.connect('changed', () => { state.combo = combo.get_active_text() || ''; save(); });
const selected = named(new Gtk.Entry({ editable: false, text: 'Before Selected 🙂 文件 After' }), 'Selection fixture input');
const scrollText = named(new Gtk.TextView({ editable: false }), 'Scroll fixture input');
scrollText.get_buffer().set_text(Array.from({ length: 200 }, (_, i) => 'Scroll fixture line ' + i).join('\n'), -1);
const scrollPort = new Gtk.ScrolledWindow({ height_request: 110 });
scrollPort.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC); scrollPort.add(scrollText);
scrollPort.get_vadjustment().connect('value-changed', adj => { state.scroll = 'offset ' + Math.round(adj.get_value()); save(); });
const drag = named(new Gtk.EventBox({ height_request: 110 }), 'Drag fixture');
drag.add(new Gtk.Label({ label: 'Drag fixture' }));
let dragStart = null;
drag.connect('button-press-event', (_w, e) => { const [, x, y] = e.get_coords(); dragStart = [x, y]; return false; });
drag.connect('button-release-event', (_w, e) => { if (dragStart) { const [, x, y] = e.get_coords(); state.drag = `${Math.round(dragStart[0])},${Math.round(dragStart[1])}->${Math.round(x)},${Math.round(y)}`; save(); dragStart = null; } return false; });
const list = named(new Gtk.ListBox(), 'Fixture list');
for (const item of ['Alpha', 'Beta', 'Gamma']) list.add(new Gtk.Label({ label: item }));
for (const widget of [bar, input, submit, result, password, readonly, disabled, disabledButton, check, combo, selected, scrollPort, drag, menuStatus, list]) box.pack_start(widget, false, false, 0);
window.add(box);
window.connect('destroy', Gtk.main_quit);
window.show_all();
window.set_focus(input);
save();

const observer = new Gtk.Window({ title: 'Interceptor Parity Observer', default_width: 360, default_height: 160 });
const note = named(new Gtk.Entry({ text: 'This window keeps focus while Interceptor works on the fixture.' }), 'Observer focus');
observer.add(note);
observer.show_all();
note.grab_focus();
observer.present();
// GTK3 entries drop their selection when another entry claims PRIMARY (select-on-focus does),
// so select after the observer takes focus and keep later focus moves from claiming it.
Gtk.Settings.get_default().gtk_entry_select_on_focus = false;
selected.select_region(7, 20);
Gtk.main();
