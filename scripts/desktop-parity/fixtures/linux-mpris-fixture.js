// Owned MPRIS player for the music cases. Exposes org.mpris.MediaPlayer2.Player on
// the session bus as org.mpris.MediaPlayer2.InterceptorParity and records every control call
// in <statusDir>/music.json. Usage: gjs linux-mpris-fixture.js <statusDir>
const { Gio, GLib } = imports.gi;
const statusDir = ARGV[0] || GLib.get_tmp_dir();
const state = { status: 'Paused', loop: 'None', shuffle: false, position: 0, calls: [] };
const save = () => GLib.file_set_contents(GLib.build_filenamev([statusDir, 'music.json']), JSON.stringify(state));
// wrapJSObject exports only the first interface of its XML, so each interface is its own object.
const rootXml = `<node><interface name="org.mpris.MediaPlayer2"><method name="Raise"/><method name="Quit"/>
  <property name="Identity" type="s" access="read"/><property name="CanQuit" type="b" access="read"/><property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/><property name="SupportedUriSchemes" type="as" access="read"/><property name="SupportedMimeTypes" type="as" access="read"/></interface></node>`;
const playerXml = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/><method name="PlayPause"/><method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
  <method name="SetPosition"><arg direction="in" name="TrackId" type="o"/><arg direction="in" name="Position" type="x"/></method>
  <property name="PlaybackStatus" type="s" access="read"/><property name="LoopStatus" type="s" access="readwrite"/>
  <property name="Rate" type="d" access="readwrite"/><property name="Shuffle" type="b" access="readwrite"/>
  <property name="Metadata" type="a{sv}" access="read"/><property name="Volume" type="d" access="readwrite"/>
  <property name="Position" type="x" access="read"/><property name="MinimumRate" type="d" access="read"/><property name="MaximumRate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/><property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/><property name="CanSeek" type="b" access="read"/><property name="CanControl" type="b" access="read"/>
 </interface></node>`;
const record = (name) => { state.calls.push(name); save(); };
const player = {
  Identity: 'Interceptor Parity Player', CanQuit: false, CanRaise: false, HasTrackList: false, SupportedUriSchemes: [], SupportedMimeTypes: [],
  Raise() {}, Quit() {},
  Next() { record('Next'); }, Previous() { record('Previous'); },
  Pause() { state.status = 'Paused'; record('Pause'); }, Play() { state.status = 'Playing'; record('Play'); },
  PlayPause() { state.status = state.status === 'Playing' ? 'Paused' : 'Playing'; record('PlayPause'); },
  Stop() { state.status = 'Stopped'; state.position = 0; record('Stop'); },
  Seek(offset) { state.position = Math.max(0, state.position + offset); record('Seek'); },
  SetPosition(_track, position) { state.position = position; record('SetPosition'); },
  get PlaybackStatus() { return state.status; },
  get LoopStatus() { return state.loop; }, set LoopStatus(v) { state.loop = v; record('LoopStatus=' + v); },
  get Shuffle() { return state.shuffle; }, set Shuffle(v) { state.shuffle = v; record('Shuffle=' + v); },
  Rate: 1.0, Volume: 1.0, MinimumRate: 1.0, MaximumRate: 1.0,
  get Position() { return state.position; },
  get Metadata() { return { 'mpris:trackid': new GLib.Variant('o', '/org/mpris/MediaPlayer2/Track/1'), 'xesam:title': new GLib.Variant('s', 'Interceptor Parity Track'), 'xesam:artist': new GLib.Variant('as', ['Interceptor Parity']), 'mpris:length': new GLib.Variant('x', 600000000) }; },
  CanGoNext: true, CanGoPrevious: true, CanPlay: true, CanPause: true, CanSeek: true, CanControl: true,
};
// Kept in consts: an unreferenced exported object is garbage-collected and silently unexported.
const rootObject = Gio.DBusExportedObject.wrapJSObject(rootXml, player);
rootObject.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
const playerObject = Gio.DBusExportedObject.wrapJSObject(playerXml, player);
playerObject.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.mpris.MediaPlayer2.InterceptorParity', Gio.BusNameOwnerFlags.NONE, () => save(), () => {});
save();
new GLib.MainLoop(null, false).run();
