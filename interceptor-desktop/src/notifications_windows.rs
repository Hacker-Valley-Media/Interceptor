//! Native WinRT toast state is inspected through its registered application
//! identity. Public namespaces select owned state; they are not credentials.
use crate::{contract_generated::*, failure, notifications_validation as validate, success};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::c_void,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, TypedEventHandler},
    UI::Notifications::*,
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_INVALIDARG},
        Security::{
            Cryptography::{BCRYPT_SHA256_ALG_HANDLE, BCryptHash},
            GetTokenInformation, TOKEN_QUERY, TOKEN_STATISTICS, TokenStatistics,
        },
        System::{
            Com::{
                CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, CoCreateGuid, CoInitializeEx,
                CoRegisterClassObject, CoRevokeClassObject, IClassFactory, IClassFactory_Impl,
                REGCLS_MULTIPLEUSE,
            },
            Threading::{GetCurrentProcess, OpenProcessToken},
            Time::{SystemTimeToTzSpecificLocalTime, TzSpecificLocalTimeToSystemTime},
        },
        UI::{
            Notifications::{
                INotificationActivationCallback, INotificationActivationCallback_Impl,
                NOTIFICATION_USER_INPUT_DATA,
            },
            Shell::SetCurrentProcessExplicitAppUserModelID,
            WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId},
        },
    },
    core::{BOOL, GUID, HSTRING, IUnknown, Interface, PCWSTR, Ref, implement},
};

// Keep the toast identity stable. Package identity belongs only to the badge
// helper, so an upgrade does not discard or replay the existing native queue.
const AUMID: &str = "HackerValleyMedia.Interceptor.Desktop";
const ACTIVATOR: GUID = GUID::from_u128(0x811e51b6_6cc5_4fab_b922_c733988093b5);
const ACTIVATED: &str = "Windows.UI.Notifications.ToastNotification.Activated";
const CLOSED: &str = "Windows.UI.Notifications.ToastNotification.Dismissed";
const FAILED: &str = "Windows.UI.Notifications.ToastNotification.Failed";
const STATE_BYTES: usize = 4 * 1024 * 1024;
fn error(e: impl ToString) -> Value {
    failure("provider_failed", e)
}
fn ns(a: &Value) -> &str {
    a["namespace"].as_str().unwrap_or("default")
}
fn key(ns: &str, id: &str) -> String {
    format!("{ns}\0{id}")
}
fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn date(n: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(n as i128 * 1_000_000)
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
fn hash(s: &str) -> Result<String, Value> {
    let mut bytes = [0; 32];
    unsafe {
        BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, s.as_bytes(), &mut bytes)
            .ok()
            .map_err(error)?;
    }
    // Windows accepts 64-character setters but its getters reject that length.
    // Base64url keeps all 256 digest bits in 43 characters for both paths.
    Ok(B64.encode(bytes))
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn bounded(data: Value) -> Value {
    let r = success(data);
    if serde_json::to_vec(&r).is_ok_and(|b| b.len() <= DESKTOP_NOTIFICATION_MAX_RESULT_BYTES) {
        r
    } else {
        failure("resource_limit", "notification result exceeds 1MiB")
    }
}
fn login() -> Result<String, Value> {
    unsafe {
        if crate::windows::session() == "0" || GetShellWindow().is_invalid() {
            return Err(failure(
                "no_interactive_session",
                "notifications require this user's graphical Windows login",
            ));
        }
        let mut pid = 0;
        GetWindowThreadProcessId(GetShellWindow(), Some(&mut pid));
        let mut session = 0;
        windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(pid, &mut session)
            .map_err(error)?;
        if session.to_string() != crate::windows::session() {
            return Err(failure(
                "no_interactive_session",
                "notification shell belongs to another session",
            ));
        }
        let mut token = windows::Win32::Foundation::HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(error)?;
        let token = crate::windows::OwnedHandle(token);
        let mut info = TOKEN_STATISTICS::default();
        let mut size = 0;
        GetTokenInformation(
            token.0,
            TokenStatistics,
            Some((&mut info as *mut TOKEN_STATISTICS).cast()),
            std::mem::size_of::<TOKEN_STATISTICS>() as u32,
            &mut size,
        )
        .map_err(error)?;
        Ok(format!(
            "{:08x}{:08x}",
            info.AuthenticationId.HighPart as u32, info.AuthenticationId.LowPart
        ))
    }
}
fn registered() -> Result<(), Value> {
    unsafe {
        use windows::Win32::{
            Foundation::PROPERTYKEY,
            System::{
                Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, STGM_READ},
                Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW},
                Variant::VT_CLSID,
            },
            UI::Shell::{IShellLinkW, PropertiesSystem::IPropertyStore, ShellLink},
        };
        let root = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or_else(|| error("missing absolute APPDATA"))?;
        let path=root.join("Microsoft/Windows/Start Menu/Programs/Interceptor Desktop B7F4D8A1-3E22-4B91-A6E4-9C2D5F8A1234.lnk");
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(error)?;
        let persist: IPersistFile = link.cast().map_err(error)?;
        let path = HSTRING::from(path.to_string_lossy().as_ref());
        persist
            .Load(PCWSTR(path.as_ptr()), STGM_READ)
            .map_err(error)?;
        let mut target = vec![0; 32768];
        link.GetPath(&mut target, std::ptr::null_mut(), 0)
            .map_err(error)?;
        let length = target
            .iter()
            .position(|n| *n == 0)
            .ok_or_else(|| error("unterminated native shortcut target"))?;
        let exe = std::fs::canonicalize(std::env::current_exe().map_err(error)?).map_err(error)?;
        if std::fs::canonicalize(String::from_utf16(&target[..length]).map_err(error)?)
            .map_err(error)?
            != exe
        {
            return Err(error(
                "notification shortcut does not target this installed provider",
            ));
        }
        let store: IPropertyStore = link.cast().map_err(error)?;
        let key = |pid| PROPERTYKEY {
            fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid,
        };
        if store.GetValue(&key(5)).map_err(error)?.to_string() != AUMID {
            return Err(error("notification shortcut AUMID is not registered"));
        }
        let value = store.GetValue(&key(26)).map_err(error)?;
        if value.Anonymous.Anonymous.vt != VT_CLSID
            || value.Anonymous.Anonymous.Anonymous.puuid.is_null()
            || *value.Anonymous.Anonymous.Anonymous.puuid != ACTIVATOR
        {
            return Err(error("notification shortcut COM activator differs"));
        }
        let mut server = [0u16; 32768];
        let mut bytes = std::mem::size_of_val(&server) as u32;
        RegGetValueW(
            HKEY_CURRENT_USER,
            windows::core::w!(
                "Software\\Classes\\CLSID\\{811E51B6-6CC5-4FAB-B922-C733988093B5}\\LocalServer32"
            ),
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            Some(server.as_mut_ptr().cast()),
            Some(&mut bytes),
        )
        .ok()
        .map_err(error)?;
        let length = server
            .iter()
            .position(|n| *n == 0)
            .ok_or_else(|| error("unterminated native COM server"))?;
        let server = String::from_utf16(&server[..length]).map_err(error)?;
        let installed = std::env::current_exe().map_err(error)?;
        if !server.eq_ignore_ascii_case(&format!("\"{}\" --toast-activated", installed.display())) {
            return Err(error(
                "notification COM server does not target this installed provider",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u8,
    login: String,
    namespace: String,
    entry: Value,
    token: String,
}
impl Metadata {
    fn validate(&self, login: &str) -> Result<(), Value> {
        let entry: DesktopNotificationEntry =
            serde_json::from_value(self.entry.clone()).map_err(error)?;
        if self.version != 1
            || self.login != login
            || !validate::namespace(&self.namespace)
            || !validate::identifier(&entry.identifier)
            || self.token.len() != 36
            || GUID::try_from(self.token.as_str()).is_err()
        {
            return Err(error("native notification metadata identity is invalid"));
        }
        if entry.nativeIdentifier
            != format!(
                "winrt:{}:{}",
                hash(&key(&self.login, &self.namespace))?,
                hash(&entry.identifier)?
            )
        {
            return Err(error(
                "native tag/group differs from owned notification metadata",
            ));
        }
        let mut action = json!({"type":"desktop_notifications","sub":"post","namespace":self.namespace,"id":entry.identifier,"title":entry.title,"subtitle":entry.subtitle,"body":entry.body,"user_info":entry.userInfoJSON});
        if !entry.categoryIdentifier.is_empty() {
            action["category"] = json!(entry.categoryIdentifier);
        }
        validate::validate(&action)?;
        if entry.attachments.len() > 1
            || matches!(&entry.sound,DesktopNotificationNullableString::V0(s) if s!="default")
            || !entry.threadIdentifier.is_empty()
            || entry.badge.is_some()
            || entry.interruptionLevel.is_some()
        {
            return Err(error(
                "native notification metadata has unsupported content",
            ));
        }
        Ok(())
    }
    fn launch(&self) -> String {
        format!("ip1:{}", B64.encode(serde_json::to_vec(self).unwrap()))
    }
    fn read(doc: &XmlDocument, login: &str, tag: &str, group: &str) -> Result<Option<Self>, Value> {
        let raw = doc
            .DocumentElement()
            .and_then(|e| e.GetAttribute(&HSTRING::from("launch")))
            .map_err(error)?
            .to_string();
        let Some(raw) = raw.strip_prefix("ip1:") else {
            return Ok(None);
        };
        if raw.len() > 131072 {
            return Err(error("native notification metadata exceeds its bound"));
        }
        let m: Self = serde_json::from_slice(&B64.decode(raw).map_err(error)?).map_err(error)?;
        if m.login != login {
            return Ok(None);
        };
        m.validate(login)?;
        if group != hash(&key(&m.login, &m.namespace))?
            || tag != hash(m.entry["identifier"].as_str().unwrap())?
        {
            return Err(error("native notification identity was rebound"));
        }
        Ok(Some(m))
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Repeat {
    action: Value,
    metadata: Metadata,
    next: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    login: String,
    categories: BTreeMap<String, Value>,
    repeats: BTreeMap<String, Repeat>,
    inflight: BTreeSet<String>,
}
fn state_valid(s: &State, login: &str) -> Result<(), Value> {
    if s.version != 1
        || s.login != login
        || s.categories.len() > 64
        || s.repeats.len() > 1000
        || s.inflight.len() > 1
        || s.inflight.iter().any(|k| !s.repeats.contains_key(k))
    {
        return Err(error(
            "notification state version/login/count/intent is invalid",
        ));
    }
    for (k, r) in &s.repeats {
        validate::validate(&r.action)?;
        r.metadata.validate(login)?;
        if !["schedule-after", "schedule-cron"].contains(&r.action["sub"].as_str().unwrap_or(""))
            || r.metadata.entry["trigger"]["repeats"] != true
            || r.action["repeats"] == false
            || k != &key(
                ns(&r.action),
                r.metadata.entry["identifier"].as_str().unwrap(),
            )
            || r.metadata.namespace != ns(&r.action)
            || r.action["id"] != r.metadata.entry["identifier"]
            || r.metadata.entry["trigger"]["nextTriggerDate"] != date(r.next)
        {
            return Err(error(
                "stored repeating notification request/receipt identity is invalid",
            ));
        }
        if r.action["sub"] == "schedule-after"
            && (r.metadata.entry["trigger"]["seconds"] != r.action["seconds"]
                || r.metadata.entry["trigger"]["type"] != "timeInterval")
            || r.action["sub"] == "schedule-cron"
                && (r.metadata.entry["trigger"]["components"]
                    != json!(validate::components(
                        r.action["components"].as_str().unwrap()
                    )?)
                    || r.metadata.entry["trigger"]["type"] != "calendar")
        {
            return Err(error("stored repeating notification trigger differs"));
        }
        for (field, source, default) in [
            ("title", "title", ""),
            ("subtitle", "subtitle", ""),
            ("body", "body", ""),
            ("categoryIdentifier", "category", ""),
            ("userInfoJSON", "user_info", "{}"),
        ] {
            if r.metadata.entry[field] != r.action[source].as_str().unwrap_or(default) {
                return Err(error("stored repeating content differs from its request"));
            }
        }
    }
    for (k, c) in &s.categories {
        let (ns, id) = k
            .split_once('\0')
            .ok_or_else(|| error("invalid category key"))?;
        let category: DesktopNotificationCategory =
            serde_json::from_value(c.clone()).map_err(error)?;
        if category.identifier != id
            || category.options != 0.0
            || !category.intentIdentifiers.is_empty()
            || category.summaryFormat.is_some()
            || category.hiddenPlaceholder.is_some()
        {
            return Err(error("invalid native category metadata"));
        }
        validate::validate(
            &json!({"type":"desktop_notifications","sub":"categories","namespace":ns,"verb":"register","identifier":id,"actions":serde_json::to_string(&category.actions).unwrap()}),
        )?;
        if category.actions.len() > 5
            || category
                .actions
                .iter()
                .any(|a| a.options.as_ref().is_some_and(|x| !x.is_empty()))
        {
            return Err(error("unsupported native category actions"));
        }
    }
    Ok(())
}
struct Storage {
    path: PathBuf,
    events: File,
    _lock: File,
}
impl Storage {
    fn open(login: &str) -> Result<(Self, State), Value> {
        let (events, event_path) = crate::clipboard::event_file("notifications").map_err(error)?;
        let path = event_path.with_file_name(format!("notifications-{login}.state.json"));
        let lock = crate::windows::private_lock(&path.with_extension("lock")).map_err(error)?;
        let s = match crate::windows::private_input(&path) {
            Ok(f) => {
                if f.metadata().map_err(error)?.len() > STATE_BYTES as u64 {
                    return Err(error("notification state exceeds 4MiB; it was preserved"));
                }
                let mut bytes = Vec::new();
                f.take(STATE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(error)?;
                let s: State = serde_json::from_slice(&bytes).map_err(error)?;
                state_valid(&s, login)?;
                s
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State {
                version: 1,
                login: login.into(),
                categories: BTreeMap::new(),
                repeats: BTreeMap::new(),
                inflight: BTreeSet::new(),
            },
            Err(e) => return Err(error(e)),
        };
        Ok((
            Self {
                path,
                events,
                _lock: lock,
            },
            s,
        ))
    }
    fn save(&self, s: &State) -> Result<(), Value> {
        state_valid(s, &s.login)?;
        let bytes = serde_json::to_vec(s).map_err(error)?;
        if bytes.len() > STATE_BYTES {
            return Err(failure("resource_limit", "notification state exceeds 4MiB"));
        }
        match std::fs::symlink_metadata(&self.path) {
            Ok(_) => drop(crate::windows::private_input(&self.path).map_err(error)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(e)),
        }
        let next = self
            .path
            .with_extension(format!("{}-{}.next", std::process::id(), now()));
        let mut f = crate::windows::private_output(&next).map_err(error)?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(error)?;
        drop(f);
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let a: Vec<u16> = next.as_os_str().encode_wide().chain([0]).collect();
        let b: Vec<u16> = self.path.as_os_str().encode_wide().chain([0]).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(a.as_ptr()),
                PCWSTR(b.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(error)?;
        }
        Ok(())
    }
    fn event(&mut self, ns: &str, event: &Value) -> Result<(), Value> {
        let mut bytes =
            serde_json::to_vec(&json!({"namespace":ns,"event":event})).map_err(error)?;
        bytes.push(b'\n');
        if self.events.metadata().map_err(error)?.len() + bytes.len() as u64 > STATE_BYTES as u64 {
            self.events.set_len(0).map_err(error)?;
        }
        self.events
            .seek(SeekFrom::End(0))
            .and_then(|_| self.events.write_all(&bytes))
            .map_err(error)
    }
}
struct Event {
    metadata: Metadata,
    name: &'static str,
    event: Value,
}
unsafe fn bounded_wide(p: PCWSTR, max: usize) -> windows::core::Result<String> {
    if p.is_null() {
        return Err(windows::core::Error::from_hresult(E_INVALIDARG));
    }
    for n in 0..=max {
        if unsafe { *p.0.add(n) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(p.0, n) })
                .map_err(|_| windows::core::Error::from_hresult(E_INVALIDARG));
        }
    }
    Err(windows::core::Error::from_hresult(E_INVALIDARG))
}
#[implement(INotificationActivationCallback)]
struct Activation {
    events: SyncSender<Event>,
    login: String,
}
impl INotificationActivationCallback_Impl for Activation_Impl {
    fn Activate(
        &self,
        app: &PCWSTR,
        args: &PCWSTR,
        _data: *const NOTIFICATION_USER_INPUT_DATA,
        count: u32,
    ) -> windows::core::Result<()> {
        let invalid = || windows::core::Error::from_hresult(E_INVALIDARG);
        if count != 0 || unsafe { bounded_wide(*app, 256) }? != AUMID {
            return Err(invalid());
        }
        let args = unsafe { bounded_wide(*args, 131072) }?;
        let args = args.strip_prefix("ip1:").ok_or_else(invalid)?;
        let (raw, action) = args.split_once('.').unwrap_or((args, ""));
        let m: Metadata = serde_json::from_slice(&B64.decode(raw).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        m.validate(&self.login).map_err(|_| invalid())?;
        let action = if action.is_empty() {
            "default".into()
        } else {
            String::from_utf8(B64.decode(action).map_err(|_| invalid())?).map_err(|_| invalid())?
        };
        if !validate::identifier(&action) {
            return Err(invalid());
        }
        self.events
            .try_send(Event {
                metadata: m,
                name: ACTIVATED,
                event: json!({"kind":"activated","actionIdentifier":action}),
            })
            .map_err(|_| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))
    }
}
#[implement(IClassFactory)]
struct Factory {
    events: SyncSender<Event>,
    login: String,
}
impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        if out.is_null() || iid.is_null() {
            return Err(windows::core::Error::from_hresult(E_INVALIDARG));
        }
        unsafe {
            *out = std::ptr::null_mut();
        }
        if !outer.is_null() {
            return Err(windows::core::Error::from_hresult(CLASS_E_NOAGGREGATION));
        }
        let callback: INotificationActivationCallback = Activation {
            events: self.events.clone(),
            login: self.login.clone(),
        }
        .into();
        unsafe { callback.query(iid, out).ok() }
    }
    fn LockServer(&self, _lock: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}
struct Registration(u32);
impl Drop for Registration {
    fn drop(&mut self) {
        unsafe {
            let _ = CoRevokeClassObject(self.0);
        }
    }
}
struct Live {
    toast: ToastNotification,
    dismissed: i64,
    failed: i64,
}
impl Drop for Live {
    fn drop(&mut self) {
        let _ = self.toast.RemoveDismissed(self.dismissed);
        let _ = self.toast.RemoveFailed(self.failed);
    }
}
struct Worker {
    login: String,
    notifier: ToastNotifier,
    storage: Storage,
    state: State,
    events: SyncSender<Event>,
    known: BTreeMap<String, Metadata>,
    live: BTreeMap<String, Live>,
    subscriptions: BTreeSet<String>,
    history: Vec<(String, Value)>,
    seen: VecDeque<String>,
    error: Option<Value>,
    _registration: Registration,
}
impl Worker {
    fn owned_slot(&self, id: &str, namespace: &str) -> Result<(), Value> {
        let group = hash(&key(&self.login, namespace))?;
        let tag = hash(id)?;
        let list = ToastNotificationManager::History()
            .and_then(|h| h.GetHistoryWithId(&HSTRING::from(AUMID)))
            .map_err(error)?;
        for i in 0..list.Size().map_err(error)? {
            let t = list.GetAt(i).map_err(error)?;
            if t.Tag().map_err(error)?.to_string() == tag
                && t.Group().map_err(error)?.to_string() == group
            {
                let m=Metadata::read(&t.Content().map_err(error)?,&self.login,&tag,&group)?.ok_or_else(||failure("target_gone","native tag/group is occupied by unowned content; no toast was replaced"))?;
                if m.namespace != namespace || m.entry["identifier"] != id {
                    return Err(failure(
                        "target_gone",
                        "native toast identity changed; no toast was replaced",
                    ));
                }
            }
        }
        Ok(())
    }
    fn schedule(&self, m: &Metadata, doc: &XmlDocument, next: i64) -> Result<(), Value> {
        self.ready()?;
        let id = m.entry["identifier"].as_str().unwrap();
        let tag = HSTRING::from(hash(id)?);
        let group = HSTRING::from(hash(&key(&self.login, &m.namespace))?);
        // The native setter rejects length16;15 base64url characters retain90 bits.
        let native_id = HSTRING::from(&hash(&key(&m.namespace, id))?[..15]);
        let pending = self
            .notifier
            .GetScheduledToastNotifications()
            .map_err(error)?;
        for i in 0..pending.Size().map_err(error)? {
            let t = pending.GetAt(i).map_err(error)?;
            if t.Id().map_err(error)? == native_id {
                return Err(failure(
                    "target_gone",
                    "native scheduled identifier is already occupied; no queue was replaced",
                ));
            }
        }
        let toast = ScheduledToastNotification::CreateScheduledToastNotification(
            doc,
            DateTime {
                UniversalTime: (next + 11644473600000) * 10000,
            },
        )
        .map_err(error)?;
        toast.SetTag(&tag).map_err(error)?;
        toast.SetGroup(&group).map_err(error)?;
        toast.SetId(&native_id).map_err(error)?;
        self.notifier.AddToSchedule(&toast).map_err(|e| {
            failure(
                "provider_failed",
                format!("native schedule acceptance may be unknown: {e}; inspect before retrying"),
            )
        })
    }
    fn recover(&mut self) -> Result<(), Value> {
        let pending = self.inventory(true)?;
        let intents = self.state.inflight.clone();
        if intents.is_empty() {
            return Ok(());
        }
        let mut state = self.state.clone();
        for k in intents {
            let r = state.repeats.get(&k).unwrap();
            let namespace = r.metadata.namespace.clone();
            let id = r.metadata.entry["identifier"].clone();
            if !pending.iter().any(|m| m.token == r.metadata.token) {
                state.repeats.remove(&k);
                self.record(&namespace,json!({"kind":"failed","identifier":id,"object":"native scheduling interrupted; acceptance is unknown and will not be replayed"}));
            }
            state.inflight.remove(&k);
        }
        self.commit(state)
    }
    fn fire(&mut self) {
        let Some((k, r)) = self
            .state
            .repeats
            .iter()
            .find(|(_, r)| r.next <= now())
            .map(|(k, r)| (k.clone(), r.clone()))
        else {
            return;
        };
        if self.ready().is_err() {
            return;
        }
        let result = (|| -> Result<(), Value> {
            let pending = self.inventory(true)?;
            if pending.iter().any(|m| m.token == r.metadata.token) {
                return Ok(());
            }
            let delivered = self.inventory(false)?;
            if !delivered.iter().any(|m| m.token == r.metadata.token) {
                let mut state = self.state.clone();
                state.repeats.remove(&k);
                self.commit(state)?;
                self.record(&r.metadata.namespace,json!({"kind":"failed","identifier":r.metadata.entry["identifier"],"object":"native schedule disappeared without confirmed history; recurrence stopped without replay"}));
                return Ok(());
            }
            self.record(&r.metadata.namespace,json!({"kind":"accepted","identifier":r.metadata.entry["identifier"],"object":"native history observed; Windows exposes no actual delivery timestamp"}));
            let next = if r.action["sub"] == "schedule-after" {
                now() + r.action["seconds"].as_f64().unwrap() as i64 * 1000 + 1
            } else {
                calendar(
                    &validate::components(r.action["components"].as_str().unwrap()).unwrap(),
                    now(),
                )?
            };
            let mut trigger = r.metadata.entry["trigger"].clone();
            trigger["nextTriggerDate"] = json!(date(next));
            let (m, doc) = self.content(&r.action, trigger)?;
            let mut state = self.state.clone();
            state.repeats.insert(
                k.clone(),
                Repeat {
                    action: r.action,
                    metadata: m.clone(),
                    next,
                },
            );
            state.inflight.insert(k.clone());
            self.commit(state)?;
            self.schedule(&m, &doc, next)?;
            let mut state = self.state.clone();
            state.inflight.remove(&k);
            self.commit(state)?;
            self.known.insert(k.clone(), m);
            Ok(())
        })();
        if let Err(e) = result {
            // A failed occurrence, including a calendar with no later date, ends its own
            // recurrence without replay. Only a state write failure stops the worker.
            let mut state = self.state.clone();
            state.repeats.remove(&k);
            state.inflight.remove(&k);
            if let Err(e) = self.commit(state) {
                self.error = Some(e);
            }
            self.record(&r.metadata.namespace,json!({"kind":"failed","identifier":r.metadata.entry["identifier"],"object":format!("recurrence stopped without replay: {}",e["error"].as_str().unwrap_or("native notification failed"))}));
        }
    }
    fn ready(&self) -> Result<(), Value> {
        if login()? != self.login {
            return Err(failure(
                "permission_denied",
                "notification graphical login changed; no effect was sent",
            ));
        }
        if let Some(e) = &self.error {
            return Err(e.clone());
        }
        registered()
    }
    fn record(&mut self, ns: &str, mut event: Value) {
        event["timestamp"] = json!(date(now()));
        event["truncated"] = json!(false);
        if let Err(e) = self.storage.event(ns, &event) {
            self.error = Some(e);
        }
        self.history.push((ns.into(), event));
        while self.history.len() > 1000
            || serde_json::to_vec(&self.history)
                .is_ok_and(|b| b.len() > DESKTOP_NOTIFICATION_MAX_RESULT_BYTES)
        {
            self.history.remove(0);
        }
    }
    fn commit(&mut self, s: State) -> Result<(), Value> {
        self.storage.save(&s)?;
        self.state = s;
        Ok(())
    }
    fn inventory(&self, pending: bool) -> Result<Vec<Metadata>, Value> {
        let mut rows = Vec::new();
        if pending {
            let list = self
                .notifier
                .GetScheduledToastNotifications()
                .map_err(error)?;
            if list.Size().map_err(error)? > 1000 {
                return Err(failure(
                    "resource_limit",
                    "native notification queue exceeds 1000",
                ));
            }
            for i in 0..list.Size().map_err(error)? {
                let t = list.GetAt(i).map_err(error)?;
                if let Some(m) = Metadata::read(
                    &t.Content().map_err(error)?,
                    &self.login,
                    &t.Tag().map_err(error)?.to_string(),
                    &t.Group().map_err(error)?.to_string(),
                )? {
                    rows.push(m);
                }
            }
        } else {
            let list = ToastNotificationManager::History()
                .and_then(|h| h.GetHistoryWithId(&HSTRING::from(AUMID)))
                .map_err(error)?;
            if list.Size().map_err(error)? > 1000 {
                return Err(failure(
                    "resource_limit",
                    "native notification history exceeds 1000",
                ));
            }
            for i in 0..list.Size().map_err(error)? {
                let t = list.GetAt(i).map_err(error)?;
                if let Some(m) = Metadata::read(
                    &t.Content().map_err(error)?,
                    &self.login,
                    &t.Tag().map_err(error)?.to_string(),
                    &t.Group().map_err(error)?.to_string(),
                )? {
                    rows.push(m);
                }
            }
        }
        Ok(rows)
    }
    fn content(&self, a: &Value, trigger: Value) -> Result<(Metadata, XmlDocument), Value> {
        for field in ["thread", "interruption", "badge"] {
            if a.get(field).is_some() {
                return Err(failure(
                    "unsupported_operation",
                    format!("Windows toast has no qualified per-notification {field} equivalent"),
                ));
            }
        }
        if a["sound"].as_str().is_some_and(|s| s != "default") {
            return Err(failure(
                "unsupported_operation",
                "Windows toast sound supports default only",
            ));
        }
        let id = a["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}-{}", std::process::id(), now()));
        let native = format!("winrt:{}:{}", hash(&key(&self.login, ns(a)))?, hash(&id)?);
        let mut attachments = Vec::new();
        if let Some(raw) = a["attachment"].as_str() {
            if raw.contains(',') {
                return Err(failure(
                    "unsupported_operation",
                    "Windows toast supports one static image",
                ));
            }
            let (id, path) = raw.split_once('=').unwrap_or(("attachment-1", raw));
            let path = std::fs::canonicalize(path).map_err(error)?;
            let meta = std::fs::metadata(&path).map_err(error)?;
            if !meta.is_file() || meta.len() > 10 * 1024 * 1024 {
                return Err(failure(
                    "resource_limit",
                    "notification image requires a regular file of at most 10MiB",
                ));
            }
            let mut bytes = Vec::new();
            File::open(&path)
                .map_err(error)?
                .take(10 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(error)?;
            if bytes.len() > 10 * 1024 * 1024 {
                return Err(failure(
                    "resource_limit",
                    "notification image grew beyond 10MiB",
                ));
            }
            let format = image::guess_format(&bytes).map_err(error)?;
            let (width, height) =
                image::ImageReader::with_format(std::io::Cursor::new(&bytes), format)
                    .into_dimensions()
                    .map_err(error)?;
            crate::capture::pixel_size(width, height)?;
            if width > 8192 || height > 8192 {
                return Err(failure(
                    "resource_limit",
                    "notification image exceeds 8192px",
                ));
            }
            let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(width);
            limits.max_image_height = Some(height);
            limits.max_alloc = Some(160 * 1024 * 1024);
            reader.limits(limits);
            reader.decode().map_err(error)?;
            let url = reqwest::Url::from_file_path(path)
                .map_err(|_| error("cannot encode absolute notification image URI"))?;
            attachments.push(json!({"identifier":id,"url":url.to_string(),"type":null}));
        }
        let entry = json!({"identifier":id,"nativeIdentifier":native,"title":a["title"].as_str().unwrap_or(""),"subtitle":a["subtitle"].as_str().unwrap_or(""),"body":a["body"].as_str().unwrap_or(""),"categoryIdentifier":a["category"].as_str().unwrap_or(""),"threadIdentifier":"","userInfoJSON":a["user_info"].as_str().unwrap_or("{}"),"sound":a["sound"].as_str(),"attachments":attachments,"trigger":trigger});
        let m = Metadata {
            version: 1,
            login: self.login.clone(),
            namespace: ns(a).into(),
            entry,
            token: format!("{:?}", unsafe { CoCreateGuid().map_err(error)? }),
        };
        m.validate(&self.login)?;
        let mut xml = format!(
            "<toast launch=\"{}\"><visual><binding template=\"ToastGeneric\">",
            escape(&m.launch())
        );
        for field in ["title", "subtitle", "body"] {
            xml.push_str(&format!(
                "<text>{}</text>",
                escape(m.entry[field].as_str().unwrap())
            ));
        }
        if let Some(image) = attachments.first() {
            xml.push_str(&format!(
                "<image src=\"{}\"/>",
                escape(image["url"].as_str().unwrap())
            ));
        }
        xml.push_str("</binding></visual>");
        if let Some(category) = a["category"].as_str() {
            let definition = self
                .state
                .categories
                .get(&key(ns(a), category))
                .ok_or_else(|| {
                    failure(
                        "invalid_request",
                        "notification category is not registered in this namespace",
                    )
                })?;
            xml.push_str("<actions>");
            for action in definition["actions"].as_array().unwrap() {
                let args = format!(
                    "{}.{}",
                    m.launch(),
                    B64.encode(action["identifier"].as_str().unwrap())
                );
                xml.push_str(&format!(
                    "<action content=\"{}\" arguments=\"{}\" activationType=\"foreground\"/>",
                    escape(action["title"].as_str().unwrap()),
                    escape(&args)
                ));
            }
            xml.push_str("</actions>");
        }
        xml.push_str(if a.get("sound").is_some() {
            "<audio src=\"ms-winsoundevent:Notification.Default\"/>"
        } else {
            "<audio silent=\"true\"/>"
        });
        xml.push_str("</toast>");
        if xml.len() > 65536 {
            return Err(failure(
                "resource_limit",
                "native toast XML exceeds 65536 bytes; no effect was sent",
            ));
        }
        let doc = XmlDocument::new().map_err(error)?;
        doc.LoadXml(&HSTRING::from(xml)).map_err(error)?;
        Ok((m, doc))
    }
    fn callbacks(&mut self, m: &Metadata, t: &ToastNotification) -> Result<Live, Value> {
        let sender = self.events.clone();
        let owned = m.clone();
        let dismissed = t
            .Dismissed(&TypedEventHandler::<
                ToastNotification,
                ToastDismissedEventArgs,
            >::new(move |_, args| {
                let reason = args
                    .as_ref()
                    .ok_or_else(|| windows::core::Error::from_hresult(E_INVALIDARG))?
                    .Reason()?
                    .0;
                sender
                    .try_send(Event {
                        metadata: owned.clone(),
                        name: CLOSED,
                        event: json!({"kind":"closed","reason":match reason{0=>2,1=>3,_=>1}}),
                    })
                    .map_err(|_| {
                        windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
                    })
            }))
            .map_err(error)?;
        let sender = self.events.clone();
        let owned = m.clone();
        let failed=match t.Failed(&TypedEventHandler::<ToastNotification,ToastFailedEventArgs>::new(move|_,args|{let code=args.as_ref().ok_or_else(||windows::core::Error::from_hresult(E_INVALIDARG))?.ErrorCode()?.0;sender.try_send(Event{metadata:owned.clone(),name:FAILED,event:json!({"kind":"failed","object":format!("native toast error 0x{:08x}",code as u32)})}).map_err(|_|windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))})){Ok(token)=>token,Err(e)=>{let _=t.RemoveDismissed(dismissed);return Err(error(e));}};
        Ok(Live {
            toast: t.clone(),
            dismissed,
            failed,
        })
    }
    fn dispatch(&mut self, a: &Value) -> Value {
        // Each request retries the reconciliation a restart would run, so an earlier
        // failure does not refuse every later request.
        if let Some(e) = self.error.take() {
            if self.recover().is_err() {
                self.error.get_or_insert(e);
            }
        }
        if let Err(e) = self.ready() {
            return e;
        }
        let ns = ns(a);
        let sub = a["sub"].as_str().unwrap();
        let result = (|| -> Result<Value, Value> {
            match sub {
                "status" | "settings" => {
                    let setting = self.notifier.Setting();
                    let status = match setting.as_ref() {
                        Ok(&NotificationSetting::Enabled) => "authorized",
                        Ok(_) => "denied",
                        Err(_) => "unknown",
                    };
                    let toggle = if status == "authorized" {
                        "enabled"
                    } else if status == "denied" {
                        "disabled"
                    } else {
                        "unknown"
                    };
                    Ok(
                        json!({"status":status,"settings":{"alert":toggle,"sound":"unknown","badge":"unknown","lockScreen":"unknown","notificationCenter":"unknown","criticalAlert":"notSupported"},"provider":"windows-winrt-toast","scope":"application","namespace":ns,"nativeSetting":setting.map(|s|format!("{s:?}")).unwrap_or_else(|e|e.to_string())}),
                    )
                }
                // Windows never prompts: toasts are allowed unless the person turned them off, so the
                // answer is the current ToastNotifier setting, read without showing anything.
                "request" => {
                    let setting = self.notifier.Setting().map_err(error)?;
                    let granted = setting == NotificationSetting::Enabled;
                    // The same default as the Mac and the shared reply check.
                    let options: Vec<&str> = a["options"].as_str().unwrap_or("alert,sound,badge").split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
                    Ok(json!({"granted":granted,"authorizationStatus":if granted {"authorized"} else {"denied"},"perFeatureSettingsEnabled":false,"options":options,
                        "error":if granted {Value::Null} else {json!(format!("Windows notifications are turned off for Interceptor ({setting:?}); turn them on in Settings > System > Notifications"))}}))
                }
                "badge" => {
                    let count = if a["clear"] == true {
                        0
                    } else {
                        a["count"].as_f64().unwrap() as u32
                    };
                    use std::{process::{Command,Stdio},os::windows::process::CommandExt};
                    let exe=std::env::current_exe().map_err(error)?;
                    let root=std::fs::canonicalize(exe.parent().ok_or_else(||error("native provider has no installation root"))?).map_err(error)?;
                    let helper=root.join("interceptor-notification-badge.exe");
                    if std::fs::canonicalize(&helper).map_err(error)?.parent()!=Some(root.as_path()){
                        return Err(error("badge helper is outside this installed provider"));
                    }
                    let deadline=Instant::now()+Duration::from_secs(5);
                    let mut child=crate::auth::AuthChild(Command::new(helper).arg(count.to_string()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x08000000).spawn().map_err(error)?);
                    let mut output=child.0.stdout.take().ok_or_else(||error("badge helper output unavailable"))?;
                    let bytes=crate::auth::bounded_child_result(|bytes|crate::auth::ready_read(&mut output,bytes),deadline,1024)
                        .map_err(|e|if e.kind()==std::io::ErrorKind::TimedOut{failure("timeout_unknown_outcome","badge helper deadline expired; native outcome is unknown")}else{error(e)})?;
                    let reply:Value=serde_json::from_slice(&bytes).map_err(error)?;
                    loop{
                        if let Some(status)=child.0.try_wait().map_err(error)?{if !status.success(){return Err(error(reply["error"].as_str().unwrap_or("badge helper failed")));}break;}
                        if Instant::now()>=deadline{return Err(failure("timeout_unknown_outcome","badge helper did not exit; native outcome is unknown"));}
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    if reply!=json!({"success":true,"count":count,"aumid":"HackerValleyMedia.Interceptor.Desktop_4xfsjzhwq8rce!Desktop"}){
                        return Err(error("badge helper receipt differs"));
                    }
                    Ok(
                        json!({"ok":true,"count":count,"scope":"application","presentation":"native-api-accepted"}),
                    )
                }
                "tail" | "untail" => {
                    let name = a["name"].as_str().unwrap();
                    if ![ACTIVATED, CLOSED, FAILED].contains(&name) {
                        return Err(failure(
                            "unsupported_operation",
                            "Windows tails require an exact native ToastNotification Activated, Dismissed or Failed event name",
                        ));
                    }
                    let k = key(ns, name);
                    if sub == "tail" {
                        if !self.subscriptions.contains(&k) && self.subscriptions.len() >= 32 {
                            return Err(failure(
                                "resource_limit",
                                "notification subscriptions reached 32",
                            ));
                        }
                        self.subscriptions.insert(k);
                        Ok(json!({"tailing":true,"name":name}))
                    } else {
                        Ok(
                            json!({"tailing":false,"name":name,"removed":self.subscriptions.remove(&k)}),
                        )
                    }
                }
                "log" => {
                    if a.get("app").is_some() {
                        return Err(failure(
                            "unsupported_operation",
                            "owned Windows notification events have no application-name filter",
                        ));
                    }
                    let rows = self
                        .history
                        .iter()
                        .filter(|(n, _)| n == ns)
                        .map(|(_, e)| e)
                        .collect::<Vec<_>>();
                    let limit = a["limit"].as_f64().unwrap_or(50.0) as usize;
                    Ok(
                        json!({"namespace":ns,"coverage":"owned-events","entries":rows.iter().skip(rows.len().saturating_sub(limit)).collect::<Vec<_>>()}),
                    )
                }
                "pending" | "delivered" => {
                    let rows = self.inventory(sub == "pending")?;
                    Ok(
                        json!({"namespace":ns,"coverage":if sub=="pending"{"native-pending"}else{"native-delivered"},"partial":false,"entries":rows.iter().filter(|m|m.namespace==ns).take(a["limit"].as_f64().unwrap_or(100.0)as usize).map(|m|&m.entry).collect::<Vec<_>>()}),
                    )
                }
                "categories" => {
                    let verb = a["verb"].as_str().unwrap_or("list");
                    if verb == "list" {
                        return Ok(
                            json!({"namespace":ns,"categories":self.state.categories.iter().filter(|(k,_)|k.starts_with(&format!("{ns}\0"))).map(|(_,c)|c).collect::<Vec<_>>()}),
                        );
                    }
                    let mut state = self.state.clone();
                    if verb == "clear" {
                        state
                            .categories
                            .retain(|k, _| !k.starts_with(&format!("{ns}\0")));
                        self.commit(state)?;
                        return Ok(json!({"ok":true,"remaining":0}));
                    }
                    for field in ["intent_identifiers", "summary_format", "hidden_placeholder"] {
                        if a.get(field).is_some() {
                            return Err(failure(
                                "unsupported_operation",
                                format!(
                                    "Windows toast categories have no native {field} equivalent"
                                ),
                            ));
                        }
                    }
                    let id = a["identifier"].as_str().unwrap();
                    let actions = validate::actions(a["actions"].as_str().unwrap()).unwrap();
                    if actions.len() > 5
                        || actions
                            .iter()
                            .any(|a| a.options.as_ref().is_some_and(|x| !x.is_empty()))
                    {
                        return Err(failure(
                            "unsupported_operation",
                            "Windows toast supports at most 5 actions; Apple action options have no qualified equivalent",
                        ));
                    }
                    let k = key(ns, id);
                    if !state.categories.contains_key(&k) && state.categories.len() >= 64 {
                        return Err(failure(
                            "resource_limit",
                            "notification categories reached 64",
                        ));
                    }
                    state.categories.insert(k,json!({"identifier":id,"actions":actions,"intentIdentifiers":[],"options":0}));
                    let remaining = state
                        .categories
                        .keys()
                        .filter(|k| k.starts_with(&format!("{ns}\0")))
                        .count();
                    self.commit(state)?;
                    Ok(json!({"ok":true,"identifier":id,"remaining":remaining}))
                }
                "post" | "schedule-after" | "schedule-at" | "schedule-cron" => {
                    let repeating = a["repeats"].as_bool().unwrap_or(sub == "schedule-cron");
                    let next = match sub {
                        "post" => None,
                        "schedule-after" => {
                            Some(now() + a["seconds"].as_f64().unwrap() as i64 * 1000 + 1)
                        }
                        "schedule-at" => Some(
                            (crate::log::timestamp(a["date"].as_str().unwrap())
                                .unwrap()
                                .unix_timestamp_nanos()
                                / 1_000_000) as i64,
                        ),
                        _ => Some(calendar(
                            &validate::components(a["components"].as_str().unwrap()).unwrap(),
                            now(),
                        )?),
                    };
                    let mut trigger = json!({"type":if sub=="post"{"immediate"}else if sub=="schedule-after"{"timeInterval"}else{"calendar"},"repeats":repeating});
                    if let Some(next) = next {
                        trigger["nextTriggerDate"] = json!(date(next));
                    }
                    if sub == "schedule-after" {
                        trigger["seconds"] = a["seconds"].clone();
                    }
                    if sub == "schedule-cron" {
                        trigger["components"] =
                            json!(validate::components(a["components"].as_str().unwrap()).unwrap());
                    }
                    let (m, doc) = self.content(a, trigger)?;
                    let id = m.entry["identifier"].as_str().unwrap();
                    let k = key(ns, id);
                    let tag = HSTRING::from(hash(id)?);
                    let group = HSTRING::from(hash(&key(&self.login, ns))?);
                    if !self.known.contains_key(&k) && self.known.len() >= 1000 {
                        // Forget notifications Windows no longer holds instead of refusing new ones.
                        let held = self.inventory(true)?.into_iter().chain(self.inventory(false)?).map(|m| m.token).collect::<BTreeSet<_>>();
                        self.known.retain(|_, m| held.contains(&m.token));
                        let known = &self.known;
                        self.live.retain(|k, _| known.contains_key(k));
                        if self.known.len() >= 1000 {
                            return Err(failure(
                                "resource_limit",
                                "Windows holds 1000 owned notifications; cancel or dismiss some first",
                            ));
                        }
                    }
                    let prior = self.inventory(next.is_some())?;
                    if prior
                        .iter()
                        .any(|x| x.namespace == ns && x.entry["identifier"] == id)
                        && next.is_some()
                    {
                        return Err(failure(
                            "invalid_request",
                            "cancel the exact existing native schedule before replacing it",
                        ));
                    }
                    if let Some(next) = next {
                        if repeating {
                            let mut state = self.state.clone();
                            if !state.repeats.contains_key(&k) && state.repeats.len() >= 1000 {
                                return Err(failure(
                                    "resource_limit",
                                    "repeating notification queue reached 1000",
                                ));
                            }
                            let mut stored = a.clone();
                            stored["id"] = json!(id);
                            state.repeats.insert(
                                k.clone(),
                                Repeat {
                                    action: stored,
                                    metadata: m.clone(),
                                    next,
                                },
                            );
                            state.inflight.insert(k.clone());
                            self.commit(state)?;
                        }
                        if let Err(e) = self.schedule(&m, &doc, next) {
                            if repeating {
                                self.error = Some(e.clone());
                            }
                            return Err(e);
                        }
                        if repeating {
                            let mut state = self.state.clone();
                            state.inflight.remove(&k);
                            if let Err(e) = self.commit(state) {
                                self.error = Some(e.clone());
                                return Err(e);
                            }
                        }
                    } else {
                        self.owned_slot(id, ns)?;
                        let toast =
                            ToastNotification::CreateToastNotification(&doc).map_err(error)?;
                        toast.SetTag(&tag).map_err(error)?;
                        toast.SetGroup(&group).map_err(error)?;
                        let live = self.callbacks(&m, &toast)?;
                        self.notifier.Show(&toast).map_err(|e|failure("provider_failed",format!("native toast acceptance may be unknown: {e}; inspect before retrying")))?;
                        self.live.insert(k.clone(), live);
                    }
                    self.known.insert(k, m.clone());
                    self.record(ns,json!({"kind":if next.is_some(){"scheduled"}else{"accepted"},"identifier":id}));
                    Ok(
                        json!({"ok":true,"identifier":id,"nativeIdentifier":m.entry["nativeIdentifier"],"trigger":m.entry["trigger"],"categoryIdentifier":m.entry["categoryIdentifier"]}),
                    )
                }
                "cancel" | "cancel-all" | "dismiss" | "dismiss-all" => {
                    let pending = sub.starts_with("cancel");
                    let rows = self.inventory(pending)?;
                    let wanted = a["id"].as_str();
                    let mut removed = Vec::new();
                    for m in rows.into_iter().filter(|m| {
                        m.namespace == ns && wanted.is_none_or(|id| m.entry["identifier"] == id)
                    }) {
                        self.ready()?;
                        let id = m.entry["identifier"].as_str().unwrap();
                        let tag = HSTRING::from(hash(id)?);
                        let group = HSTRING::from(hash(&key(&self.login, ns))?);
                        if pending {
                            let list = self
                                .notifier
                                .GetScheduledToastNotifications()
                                .map_err(error)?;
                            for i in 0..list.Size().map_err(error)? {
                                let t = list.GetAt(i).map_err(error)?;
                                if t.Tag().map_err(error)? == tag
                                    && t.Group().map_err(error)? == group
                                {
                                    self.notifier.RemoveFromSchedule(&t).map_err(error)?;
                                }
                            }
                        } else {
                            ToastNotificationManager::History()
                                .and_then(|h| {
                                    h.RemoveGroupedTagWithId(&tag, &group, &HSTRING::from(AUMID))
                                })
                                .map_err(error)?;
                            if let Some(live) = self.live.get(&key(ns, id)) {
                                self.notifier.Hide(&live.toast).map_err(error)?;
                            }
                        }
                        removed.push(id.to_owned());
                        self.record(ns,json!({"kind":if pending{"cancelled"}else{"dismissed"},"identifier":id}));
                    }
                    if pending {
                        let mut state = self.state.clone();
                        let extra = state
                            .repeats
                            .iter()
                            .filter(|(_, r)| {
                                r.metadata.namespace == ns
                                    && wanted.is_none_or(|id| r.metadata.entry["identifier"] == id)
                            })
                            .map(|(k, r)| {
                                (
                                    k.clone(),
                                    r.metadata.entry["identifier"].as_str().unwrap().to_owned(),
                                )
                            })
                            .collect::<Vec<_>>();
                        for (k, id) in extra {
                            state.repeats.remove(&k);
                            state.inflight.remove(&k);
                            if !removed.contains(&id) {
                                removed.push(id);
                            }
                        }
                        if let Err(e) = self.commit(state) {
                            self.error = Some(e.clone());
                            return Err(e);
                        }
                    }
                    let remaining = self
                        .inventory(pending)?
                        .iter()
                        .filter(|m| m.namespace == ns)
                        .count();
                    let mut data = json!({"ok":true,"removed":removed,"remaining":remaining});
                    if let Some(id) = wanted {
                        data["id"] = json!(id);
                    }
                    Ok(data)
                }
                _ => Err(failure(
                    "unsupported_operation",
                    "unknown Windows notification operation",
                )),
            }
        })();
        match result {
            Ok(data) => bounded(data),
            Err(e) => e,
        }
    }
    fn callback(&mut self, e: Event) {
        if self.ready().is_err() {
            return;
        }
        let id = e.metadata.entry["identifier"].as_str().unwrap();
        let k = key(&e.metadata.namespace, id);
        if self
            .known
            .get(&k)
            .is_none_or(|m| m.token != e.metadata.token)
            && !self
                .inventory(false)
                .is_ok_and(|rows| rows.iter().any(|m| m.token == e.metadata.token))
        {
            return;
        }
        let dedupe = format!(
            "{}:{}:{}",
            e.metadata.token, e.name, e.event["actionIdentifier"]
        );
        if self.seen.contains(&dedupe) {
            return;
        }
        // Duplicate callbacks arrive together, so the oldest of 4096 keys can go.
        if self.seen.len() >= 4096 {
            self.seen.pop_front();
        }
        self.seen.push_back(dedupe);
        if self
            .subscriptions
            .contains(&key(&e.metadata.namespace, e.name))
        {
            let mut event = e.event;
            event["name"] = json!(e.name);
            event["identifier"] = json!(id);
            self.record(&e.metadata.namespace, event);
        }
    }
}
fn calendar(c: &BTreeMap<String, u16>, base: i64) -> Result<i64, Value> {
    use windows::Win32::Foundation::SYSTEMTIME;
    let from = |s: SYSTEMTIME| {
        time::Date::from_calendar_date(
            s.wYear as i32,
            time::Month::try_from(s.wMonth as u8).unwrap(),
            s.wDay as u8,
        )
        .and_then(|d| d.with_hms(s.wHour as u8, s.wMinute as u8, s.wSecond as u8))
        .map(|d| d.assume_utc())
    };
    let instant = time::OffsetDateTime::from_unix_timestamp(base / 1000).map_err(error)?;
    let utc = SYSTEMTIME {
        wYear: instant.year() as u16,
        wMonth: instant.month() as u16,
        wDay: instant.day() as u16,
        wHour: instant.hour() as u16,
        wMinute: instant.minute() as u16,
        wSecond: instant.second() as u16,
        ..Default::default()
    };
    let mut local = SYSTEMTIME::default();
    unsafe {
        SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).map_err(error)?;
    }
    let start = from(local).map_err(error)?.date();
    let deadline = Instant::now() + Duration::from_secs(2);
    for day in 0..=366 {
        let d = start + time::Duration::days(day);
        if c.get("year").is_some_and(|n| *n != d.year() as u16)
            || c.get("month").is_some_and(|n| *n != d.month() as u16)
            || c.get("day").is_some_and(|n| *n != d.day() as u16)
            || c.get("weekday")
                .is_some_and(|n| *n != d.weekday().number_days_from_sunday() as u16 + 1)
        {
            continue;
        }
        for h in c.get("hour").map(|n| *n..=*n).unwrap_or(0..=23) {
            for m in c.get("minute").map(|n| *n..=*n).unwrap_or(0..=59) {
                for s in c.get("second").map(|n| *n..=*n).unwrap_or(0..=59) {
                    if Instant::now() >= deadline {
                        return Err(failure(
                            "resource_limit",
                            "native calendar evaluation exceeded 2 seconds",
                        ));
                    }
                    let local = SYSTEMTIME {
                        wYear: d.year() as u16,
                        wMonth: d.month() as u16,
                        wDay: d.day() as u16,
                        wHour: h,
                        wMinute: m,
                        wSecond: s,
                        ..Default::default()
                    };
                    let mut utc = SYSTEMTIME::default();
                    if unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.is_err() {
                        continue;
                    }
                    let mut round = SYSTEMTIME::default();
                    unsafe {
                        SystemTimeToTzSpecificLocalTime(None, &utc, &mut round).map_err(error)?;
                    }
                    if (
                        round.wYear,
                        round.wMonth,
                        round.wDay,
                        round.wHour,
                        round.wMinute,
                        round.wSecond,
                    ) != (local.wYear, local.wMonth, local.wDay, h, m, s)
                    {
                        continue;
                    }
                    let next = from(utc).map_err(error)?.unix_timestamp() * 1000;
                    if next > base && next - base <= DESKTOP_NOTIFICATION_MAX_SECONDS as i64 * 1000
                    {
                        return Ok(next);
                    }
                }
            }
        }
    }
    Err(failure(
        "invalid_request",
        "calendar has no occurrence within 365 days",
    ))
}
struct Request {
    action: Value,
    reply: SyncSender<Value>,
    pending: Arc<AtomicBool>,
    deadline: Instant,
}
static SERVICE: OnceLock<Result<SyncSender<Request>, String>> = OnceLock::new();
pub fn initialize() {
    let _ = service();
}
fn service() -> &'static Result<SyncSender<Request>, String> {
    SERVICE.get_or_init(|| {
        let (requests, inbox) = mpsc::sync_channel::<Request>(8);
        let (initialized, ready) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let (events, signals) = mpsc::sync_channel(128);
            let setup = (|| -> Result<Worker, Value> {
                unsafe {
                    CoInitializeEx(None, COINIT_MULTITHREADED)
                        .ok()
                        .map_err(error)?;
                    SetCurrentProcessExplicitAppUserModelID(PCWSTR(HSTRING::from(AUMID).as_ptr()))
                        .map_err(error)?;
                }
                let login = login()?;
                registered()?;
                let factory: IClassFactory = Factory {
                    events: events.clone(),
                    login: login.clone(),
                }
                .into();
                let (storage, state) = Storage::open(&login)?;
                let registration = Registration(unsafe {
                    CoRegisterClassObject(
                        &ACTIVATOR,
                        &factory,
                        CLSCTX_LOCAL_SERVER,
                        REGCLS_MULTIPLEUSE,
                    )
                    .map_err(error)?
                });
                let notifier =
                    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
                        .map_err(error)?;
                let mut w = Worker {
                    login,
                    notifier,
                    storage,
                    state,
                    events,
                    known: BTreeMap::new(),
                    live: BTreeMap::new(),
                    subscriptions: BTreeSet::new(),
                    history: Vec::new(),
                    seen: VecDeque::new(),
                    error: None,
                    _registration: registration,
                };
                for pending in [false, true] {
                    for m in w.inventory(pending)? {
                        w.known.insert(
                            key(&m.namespace, m.entry["identifier"].as_str().unwrap()),
                            m,
                        );
                    }
                }
                w.recover()?;
                Ok(w)
            })();
            let mut w = match setup {
                Ok(w) => w,
                Err(e) => {
                    let _ = initialized.send(Err(e["error"]
                        .as_str()
                        .unwrap_or("Windows notification initialization failed")
                        .to_owned()));
                    return;
                }
            };
            if initialized.send(Ok(())).is_err() {
                return;
            }
            loop {
                if login().as_ref().ok() != Some(&w.login) {
                    return;
                }
                while let Ok(event) = signals.try_recv() {
                    w.callback(event);
                }
                match inbox.recv_timeout(Duration::from_millis(100)) {
                    Ok(r) => {
                        if r.pending.load(Ordering::Acquire) && Instant::now() < r.deadline {
                            let _ = r.reply.send(w.dispatch(&r.action));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(mpsc::RecvTimeoutError::Timeout) => (),
                }
                w.fire();
            }
        });
        ready
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| "Windows notification initialization exceeded 8 seconds".to_owned())?
            .map(|_| requests)
    })
}
pub fn dispatch(a: &Value) -> Value {
    if let Err(e) = validate::validate(a) {
        return e;
    }
    if let Err(e) = login() {
        return e;
    }
    let service = match service() {
        Ok(s) => s,
        Err(e) => return failure("background_unavailable", e),
    };
    let (reply, result) = mpsc::sync_channel(1);
    let pending = Arc::new(AtomicBool::new(true));
    let deadline = Instant::now() + Duration::from_secs(12);
    if service
        .try_send(Request {
            action: a.clone(),
            reply,
            pending: pending.clone(),
            deadline,
        })
        .is_err()
    {
        return failure(
            "resource_limit",
            "Windows notification worker is unavailable or its eight-request queue is full",
        );
    }
    match result.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(r) => r,
        Err(_) => {
            pending.store(false, Ordering::Release);
            failure(
                "provider_failed",
                "notification deadline expired; native outcome may be unknown; inspect before retrying",
            )
        }
    }
}
pub fn capability(session: &str) -> Value {
    let service = service();
    let readiness = dispatch(&json!({"type":"desktop_notifications","sub":"status"}));
    let effective = readiness["success"] == true;
    let mut result = json!({"operation":"notifications","compiled":true,"present":service.is_ok(),"permission":"not_applicable","session":session,"effective":effective,"background":if effective{"semantic"}else{"unavailable"},"provider":"windows-winrt-toast","versions":{"contract":"1"},"limits":["installer-registered AUMID and COM activator; same graphical logon identity","native settings report delivery policy separately; this capability does not claim a notification authorization grant","native pending/history scoped by exact owned XML identity; no foreign application history","one static image, 5 button definitions, 64 owned categories, 32 subscriptions, 1000 callbacks/history, 4MiB private category/event files","badge receipt means native API accepted; visible taskbar presentation requires native UI qualification","native one-time queue; owned interval/calendar recurrence needs this provider and is persisted only within the same logon","interrupted schedule writes are inspected by exact token; missing or uncertain effects are not replayed"],});
    if !effective {
        result["reason"] = json!(
            readiness["error"]
                .as_str()
                .unwrap_or("notification worker is unavailable")
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_tag_and_group_round_trip_the_complete_digest() {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let id = hash("owned native identity").unwrap();
        assert_eq!(B64.decode(&id).unwrap().len(), 32);
        let doc = XmlDocument::new().unwrap();
        doc.LoadXml(&HSTRING::from("<toast><visual><binding template='ToastGeneric'><text>Unshown test</text></binding></visual></toast>")).unwrap();
        let toast = ToastNotification::CreateToastNotification(&doc).unwrap();
        toast.SetTag(&HSTRING::from(&id)).unwrap();
        toast.SetGroup(&HSTRING::from(&id)).unwrap();
        assert_eq!(toast.Tag().unwrap().to_string(), id);
        assert_eq!(toast.Group().unwrap().to_string(), id);
        drop(toast);
        drop(doc);
        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
    #[test]
    fn state_and_native_identity_refuse_malformed_or_foreign_data() {
        let login = "0000000000001234";
        let s = State {
            version: 1,
            login: login.into(),
            categories: BTreeMap::new(),
            repeats: BTreeMap::new(),
            inflight: BTreeSet::new(),
        };
        assert!(state_valid(&s, login).is_ok());
        assert!(state_valid(&s, "foreign").is_err());
        let mut raw = serde_json::to_value(&s).unwrap();
        raw["unknown"] = json!(true);
        assert!(serde_json::from_value::<State>(raw).is_err());
        let m = Metadata {
            version: 1,
            login: login.into(),
            namespace: "owned".into(),
            token: "malformed".into(),
            entry: json!({}),
        };
        assert!(m.validate(login).is_err());
        assert_ne!(
            hash(&key(login, "one")).unwrap(),
            hash(&key(login, "two")).unwrap()
        );
    }
    #[test]
    fn native_calendar_never_returns_a_past_deadline() {
        let now = now();
        let next = calendar(&BTreeMap::from([("second".into(), 30)]), now).unwrap();
        assert!(next > now);
        assert!(next - now <= 60000);
    }
}
