//! An explicitly selected, owner-private file photo library. It never opens a
//! user's unrelated gallery database. Metadata comes from pinned ExifTool13.00,
//! pixels from the existing bounded decoder or pinned FFmpeg8.0. State and
//! history describe actual committed operations on this library only.
use crate::{contract_generated::*, failure, success};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Value>;
const BYTES: usize = 128 * 1024 * 1024;
const STATE_BYTES: usize = 8 * 1024 * 1024;
static ACTIVE: Mutex<()> = Mutex::new(());
fn io_error(e: io::Error) -> Value {
    failure(
        if e.kind() == io::ErrorKind::PermissionDenied {
            "permission_denied"
        } else if e.kind() == io::ErrorKind::NotFound {
            "unsupported_target"
        } else {
            "provider_failed"
        },
        e,
    )
}
fn instant() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| failure("provider_failed", e))
}
fn fresh(prefix: &str) -> Result<String> {
    Ok(format!(
        "{prefix}:{}",
        crate::secret_target::random_token().map_err(io_error)?
    ))
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
fn number(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= 9007199254740991.0)
            .map(|n| n as u64)
    })
}
fn ids(raw: &str) -> Result<Vec<String>> {
    let rows = raw.split(',').map(str::to_owned).collect::<Vec<_>>();
    if rows.is_empty()
        || rows.len() > 100
        || rows
            .iter()
            .any(|v| v.is_empty() || v.trim() != v || v.len() > 4096 || v.contains('\0'))
        || rows.iter().collect::<BTreeSet<_>>().len() != rows.len()
    {
        Err(failure(
            "invalid_request",
            "Photos requires 1..100 exact distinct identities",
        ))
    } else {
        Ok(rows)
    }
}
fn fields(sub: &str) -> Option<&'static [&'static str]> {
    Some(match sub {
        "status" | "current-token" => &[],
        "request" => &["level"],
        "albums" => &["album_type"],
        "album" | "album-delete" | "asset" | "delete" => &["id"],
        "album-create" => &["name"],
        "album-rename" => &["id", "name"],
        "assets" => &[
            "album", "media", "subtype", "since", "until", "where", "limit", "offset", "favorite",
            "hidden", "burst",
        ],
        "export" => &["id", "out", "format", "size"],
        "export-video" | "export-live" => &["id", "out"],
        "thumbnail" => &["id", "out", "size", "save"],
        "favorite" | "hide" => &["id", "on"],
        "add-to-album" | "remove-from-album" => &["album", "asset"],
        "import" | "import-video" => &["file", "album"],
        "changes" => &["token"],
        _ => return None,
    })
}
struct Comparison {
    key: String,
    op: String,
    value: Value,
}
fn comparisons(raw: &str) -> Result<Vec<Comparison>> {
    let regex=regex::Regex::new(r#"^(isFavorite|isHidden|mediaType|pixelWidth|pixelHeight|duration|creationDate|modificationDate) (==|!=|>=|<=|>|<) (true|false|[0-9]+(?:\.[0-9]+)?|"[^"\r\n]+")$"#).unwrap();
    let rows = raw.split(" AND ").collect::<Vec<_>>();
    if rows.is_empty() || rows.len() > 8 {
        return Err(failure(
            "invalid_request",
            "Photos predicate exceeds 8 comparisons",
        ));
    }
    rows.into_iter()
        .map(|row| {
            let m = regex.captures(row).ok_or_else(|| {
                failure(
                    "invalid_request",
                    "Photos predicate has unsupported syntax or field",
                )
            })?;
            let key = m[1].to_owned();
            let op = m[2].to_owned();
            let text = &m[3];
            let value = if key == "isFavorite" || key == "isHidden" {
                if !matches!(op.as_str(), "==" | "!=") || !matches!(text, "true" | "false") {
                    return Err(failure(
                        "invalid_request",
                        "Photos Boolean predicate requires exact equality",
                    ));
                }
                json!(text == "true")
            } else if key.ends_with("Date") {
                if !text.starts_with('"')
                    || crate::log::timestamp(&text[1..text.len() - 1]).is_none()
                {
                    return Err(failure(
                        "invalid_request",
                        "Photos date predicate requires an actual instant",
                    ));
                }
                json!(&text[1..text.len() - 1])
            } else {
                let n = text
                    .parse::<f64>()
                    .ok()
                    .filter(|n| {
                        n.is_finite()
                            && (0.0..=1e9).contains(n)
                            && (*n <= 3.0 || key != "mediaType")
                            && (n.fract() == 0.0 || key == "duration")
                    })
                    .ok_or_else(|| {
                        failure(
                            "invalid_request",
                            "Photos numeric predicate exceeds its bound",
                        )
                    })?;
                json!(n)
            };
            Ok(Comparison { key, op, value })
        })
        .collect()
}
fn validate(a: &Value) -> Result<()> {
    if let Some(e) = desktop_photos_shape_error(a) {
        return Err(failure("invalid_request", e));
    }
    let sub = a["sub"].as_str().unwrap();
    let allowed =
        fields(sub).ok_or_else(|| failure("invalid_request", "unknown Photos selector"))?;
    if a.as_object()
        .unwrap()
        .keys()
        .any(|k| !matches!(k.as_str(), "type" | "sub") && !allowed.contains(&k.as_str()))
    {
        return Err(failure(
            "invalid_request",
            "Photos field does not belong to selector",
        ));
    }
    for (k, v) in a.as_object().unwrap() {
        if let Some(s) = v.as_str() {
            if s.trim().is_empty()
                || s.contains('\0')
                || s.len() > if k == "token" { 65536 } else { 4096 }
            {
                return Err(failure("invalid_request", "Photos text exceeds its bound"));
            }
        }
    }
    let required: &[&str] = match sub {
        "album" | "album-delete" | "asset" | "thumbnail" | "favorite" | "hide" | "delete" => {
            &["id"]
        }
        "album-create" => &["name"],
        "album-rename" => &["id", "name"],
        "export" | "export-video" | "export-live" => &["id", "out"],
        "add-to-album" | "remove-from-album" => &["album", "asset"],
        "import" | "import-video" => &["file"],
        "changes" => &["token"],
        _ => &[],
    };
    if required.iter().any(|k| a.get(*k).is_none()) {
        return Err(failure(
            "invalid_request",
            "Photos selector requires exact fields",
        ));
    }
    for (key, low, high) in [("limit", 1, 1000), ("offset", 0, 10000), ("size", 1, 4096)] {
        if a.get(key)
            .is_some_and(|v| number(v).is_none_or(|n| n < low || n > high))
        {
            return Err(failure("invalid_request", "invalid bounded Photos integer"));
        }
    }
    for key in ["since", "until"] {
        if a.get(key)
            .is_some_and(|v| v.as_str().and_then(crate::log::timestamp).is_none())
        {
            return Err(failure(
                "invalid_request",
                "Photos date requires an actual ISO8601 instant",
            ));
        }
    }
    if a["since"]
        .as_str()
        .and_then(crate::log::timestamp)
        .zip(a["until"].as_str().and_then(crate::log::timestamp))
        .is_some_and(|(lo, hi)| hi < lo)
    {
        return Err(failure("invalid_request", "Photos interval is reversed"));
    }
    for (key, values) in [
        ("level", &["readwrite", "addonly"][..]),
        ("album_type", &["album", "smart", "moment"][..]),
        ("media", &["image", "video", "audio", "unknown"][..]),
        (
            "subtype",
            &[
                "panorama",
                "screenshot",
                "hdr",
                "livePhoto",
                "live",
                "depthEffect",
                "streamed",
                "streamedVideo",
                "highFrameRate",
                "timelapse",
            ][..],
        ),
        ("format", &["jpeg", "png"][..]),
    ] {
        if a.get(key)
            .is_some_and(|v| v.as_str().is_none_or(|s| !values.contains(&s)))
        {
            return Err(failure("invalid_request", "unknown Photos enum"));
        }
    }
    if let Some(raw) = a["where"].as_str() {
        comparisons(raw)?;
    }
    for key in ["id", "asset"] {
        if let Some(raw) = a[key].as_str() {
            let rows = ids(raw)?;
            if key == "id" && sub != "delete" && rows.len() != 1 {
                return Err(failure(
                    "invalid_request",
                    "Photos selector requires one exact identity",
                ));
            }
        }
    }
    for key in ["file", "out"] {
        if let Some(raw) = a[key].as_str() {
            crate::filesystem::absolute(raw)?;
        }
    }
    if let Some(raw) = a["token"].as_str() {
        if STANDARD
            .decode(raw)
            .ok()
            .is_none_or(|b| b.is_empty() || STANDARD.encode(b) != raw)
        {
            return Err(failure(
                "invalid_request",
                "Photos token requires canonical bounded base64",
            ));
        }
    }
    if serde_json::to_vec(a)
        .map_err(|e| failure("invalid_request", e))?
        .len()
        > 131072
    {
        return Err(failure("resource_limit", "Photos request exceeds 128KiB"));
    }
    Ok(())
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    file: String,
    hash: String,
    uti: String,
    kind: String,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    row: Value,
    resources: Vec<Resource>,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Album {
    name: String,
    members: BTreeSet<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    revision: u64,
    event: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    library: String,
    revision: u64,
    assets: BTreeMap<String, Asset>,
    albums: BTreeMap<String, Album>,
    history: VecDeque<Change>,
}
#[cfg(windows)]
type Lock = File;
#[cfg(not(windows))]
type Lock = File;
struct Library {
    root: PathBuf,
    _lock: Lock,
    state: State,
    deadline: Instant,
    baseline: Option<String>,
}
fn root() -> Result<PathBuf> {
    crate::filesystem::absolute(&std::env::var("INTERCEPTOR_PHOTOS_LIBRARY").map_err(|_|failure("not_installed",format!("photos needs an owner-private folder in INTERCEPTOR_PHOTOS_LIBRARY; {}; no other gallery is used",crate::PROVIDER_ENV_HINT)))?)
}
fn read_private(path: &Path, max: usize) -> Result<Vec<u8>> {
    let mut file = crate::monitor::private_file(path, false).map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file()
        || file.metadata().map_err(io_error)?.len() > max as u64
    {
        return Err(failure(
            "resource_limit",
            "Photos private file exceeds its byte bound",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > max {
        return Err(failure(
            "resource_limit",
            "Photos file grew beyond its bound",
        ));
    }
    Ok(bytes)
}
fn valid_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        && !name.starts_with('.')
}
fn validate_state(state: &State) -> Result<()> {
    if state.version != 1
        || !state.library.starts_with("library:")
        || state.library.len() > 128
        || state.revision > 9007199254740991
        || state.assets.len() > 1000
        || state.albums.len() > 997
        || state.history.len() > 1000
    {
        return Err(failure(
            "partial_result",
            "Photos library version, identity, revision or counts are invalid; bytes preserved",
        ));
    }
    let mut files = BTreeSet::new();
    for (id, asset) in &state.assets {
        if !id.starts_with("asset:")
            || id.len() > 128
            || asset.row["id"] != *id
            || serde_json::from_value::<DesktopPhotosAsset>(asset.row.clone()).is_err()
            || asset.resources.is_empty()
            || asset.resources.len() > 2
            || !asset
                .resources
                .iter()
                .any(|r| r.kind == "image" || r.kind == "video")
        {
            return Err(failure(
                "partial_result",
                "Photos asset metadata is malformed; bytes preserved",
            ));
        }
        let w = number(&asset.row["pixelWidth"])
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        let h = number(&asset.row["pixelHeight"])
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        if crate::capture::pixel_size(w, h).is_err()
            || !matches!(asset.row["mediaType"].as_str(), Some("image" | "video"))
            || asset.row["sourceType"] != "ownedFileLibrary"
            || asset.row["duration"]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || !(0.0..=1e9).contains(&n))
        {
            return Err(failure(
                "partial_result",
                "Photos observed media fields are invalid",
            ));
        }
        for key in ["creationDate", "modificationDate", "addedDate"] {
            if asset
                .row
                .get(key)
                .is_some_and(|v| v.as_str().and_then(crate::log::timestamp).is_none())
            {
                return Err(failure(
                    "partial_result",
                    "Photos library date is not an actual instant",
                ));
            }
        }
        for resource in &asset.resources {
            if !valid_file(&resource.file)
                || !files.insert(&resource.file)
                || resource.hash.len() != 64
                || !resource.hash.bytes().all(|b| b.is_ascii_hexdigit())
                || resource.uti.len() > 128
                || !matches!(resource.kind.as_str(), "image" | "video")
            {
                return Err(failure(
                    "partial_result",
                    "Photos resource identity/hash/type is malformed",
                ));
            }
        }
    }
    for (id, album) in &state.albums {
        if !id.starts_with("album:")
            || id.len() > 128
            || album.name.trim().is_empty()
            || album.name.len() > 4096
            || album
                .members
                .iter()
                .any(|id| !state.assets.contains_key(id))
        {
            return Err(failure(
                "partial_result",
                "Photos album metadata or membership is malformed",
            ));
        }
    }
    let mut previous = 0;
    for change in &state.history {
        if change.revision <= previous
            || change.revision > state.revision
            || serde_json::from_value::<DesktopPhotosChange>(change.event.clone()).is_err()
        {
            return Err(failure(
                "partial_result",
                "Photos history is malformed; token was not advanced",
            ));
        }
        previous = change.revision;
    }
    if state
        .history
        .back()
        .is_some_and(|c| c.revision != state.revision)
        || state.history.is_empty() && state.revision != 0
    {
        return Err(failure(
            "partial_result",
            "Photos history revision differs from library",
        ));
    }
    Ok(())
}
impl Library {
    fn open(create: bool, deadline: Instant) -> Result<Self> {
        let root = root()?;
        crate::monitor::private_directory(&root, create, false).map_err(io_error)?;
        crate::monitor::private_directory(&root.join("media"), create, false).map_err(io_error)?;
        #[cfg(windows)]
        let lock = crate::windows::private_lock(&root.join("library.lock")).map_err(|_| {
            failure(
                "resource_limit",
                "another actor owns the Photos library lock",
            )
        })?;
        #[cfg(not(windows))]
        let lock = {
            use std::os::fd::AsRawFd;
            let path = root.join("library.lock");
            if !path.exists() && create {
                drop(crate::monitor::private_file(&path, true).map_err(io_error)?);
            }
            let file = crate::monitor::private_file(&path, false).map_err(io_error)?;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(failure(
                    "resource_limit",
                    "another actor owns the Photos library lock",
                ));
            }
            file
        };
        let path = root.join("library.json");
        let previous = if path.exists() {
            Some(read_private(&path, STATE_BYTES)?)
        } else {
            None
        };
        let state = if let Some(bytes) = previous.as_ref() {
            serde_json::from_slice(bytes).map_err(|_| {
                failure(
                    "partial_result",
                    "Photos library JSON is malformed; original preserved",
                )
            })?
        } else if create {
            State {
                version: 1,
                library: fresh("library")?,
                revision: 0,
                assets: BTreeMap::new(),
                albums: BTreeMap::new(),
                history: VecDeque::new(),
            }
        } else {
            return Err(failure(
                "not_installed",
                "Photos library is not initialized; explicit photos request creates the selected private library",
            ));
        };
        validate_state(&state)?;
        let mut library = Self {
            root,
            _lock: lock,
            state,
            deadline,
            baseline: previous.as_ref().map(|bytes| digest(bytes)),
        };
        if create && previous.is_none() {
            library.save()?;
        }
        Ok(library)
    }
    fn alive(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            Err(failure(
                "timeout_unknown_outcome",
                "Photos native work exceeded 48 seconds; no mutation replay",
            ))
        } else {
            Ok(())
        }
    }
    fn save(&mut self) -> Result<()> {
        self.alive()?;
        validate_state(&self.state)?;
        let bytes = serde_json::to_vec(&self.state).map_err(|e| failure("provider_failed", e))?;
        if bytes.len() > STATE_BYTES {
            return Err(failure(
                "resource_limit",
                "Photos library state exceeds 8MiB; prior state preserved",
            ));
        }
        let path = self.root.join("library.json");
        let temporary = self
            .root
            .join(format!("library-{}.next", crate::monitor::identifier()));
        let mut file = crate::monitor::private_file(&temporary, true).map_err(io_error)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(io_error)?;
        drop(file);
        if path.exists() {
            if self.baseline.as_ref() != Some(&digest(&read_private(&path, STATE_BYTES)?)) {
                return Err(failure(
                    "unsupported_target",
                    "Photos state changed outside the retained transaction; prior bytes and prepared copy preserved",
                ));
            }
        } else if self.baseline.is_some() {
            return Err(failure(
                "unsupported_target",
                "retained Photos state disappeared before commit",
            ));
        }
        #[cfg(not(windows))]
        {
            fs::rename(&temporary, &path).map_err(io_error)?;
            File::open(&self.root)
                .and_then(|d| d.sync_all())
                .map_err(io_error)?;
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            };
            let from = temporary
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let to = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            unsafe {
                MoveFileExW(
                    windows::core::PCWSTR(from.as_ptr()),
                    windows::core::PCWSTR(to.as_ptr()),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            }
            .map_err(|e| failure("timeout_unknown_outcome", e))?;
        }
        if read_private(&path, STATE_BYTES)? != bytes {
            return Err(failure(
                "timeout_unknown_outcome",
                "Photos committed state readback differs; no mutation replay",
            ));
        }
        self.baseline = Some(digest(&bytes));
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        let bytes = read_private(&self.root.join("library.json"), STATE_BYTES)?;
        if self.baseline.as_ref() != Some(&digest(&bytes)) {
            return Err(failure(
                "unsupported_target",
                "Photos state changed outside its retained transaction",
            ));
        }
        let previous: State = serde_json::from_slice(&bytes)
            .map_err(|_| failure("partial_result", "Photos previous state is malformed"))?;
        validate_state(&previous)?;
        if previous.library != self.state.library || previous.revision != self.state.revision {
            return Err(failure(
                "unsupported_target",
                "Photos library identity/revision changed during mutation",
            ));
        }
        let asset_inserted = self
            .state
            .assets
            .keys()
            .filter(|id| !previous.assets.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        let asset_deleted = previous
            .assets
            .keys()
            .filter(|id| !self.state.assets.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        let asset_updated = self
            .state
            .assets
            .iter()
            .filter(|(id, row)| previous.assets.get(*id).is_some_and(|old| old != *row))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let album_inserted = self
            .state
            .albums
            .keys()
            .filter(|id| !previous.albums.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        let album_deleted = previous
            .albums
            .keys()
            .filter(|id| !self.state.albums.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        let mut album_updated = self
            .state
            .albums
            .iter()
            .filter(|(id, row)| previous.albums.get(*id).is_some_and(|old| old != *row))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for kind in ["favorites", "hidden", "videos"] {
            let members = |state: &State| {
                state
                    .assets
                    .iter()
                    .filter(|(_, asset)| match kind {
                        "favorites" => asset.row["isFavorite"] == true,
                        "hidden" => asset.row["isHidden"] == true,
                        _ => asset.row["mediaType"] == "video",
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<BTreeSet<_>>()
            };
            if members(&previous) != members(&self.state) {
                album_updated.push(self.smart_id(kind));
            }
        }
        let mut changed = false;
        for (kind, inserted, updated, deleted) in [
            ("asset", asset_inserted, asset_updated, asset_deleted),
            (
                "assetCollection",
                album_inserted,
                album_updated,
                album_deleted,
            ),
        ] {
            if inserted.is_empty() && updated.is_empty() && deleted.is_empty() {
                continue;
            }
            self.state.revision = self
                .state
                .revision
                .checked_add(1)
                .filter(|n| *n <= 9007199254740991)
                .ok_or_else(|| failure("resource_limit", "Photos revision overflow"))?;
            self.state.history.push_back(Change{revision:self.state.revision,event:json!({"objectType":kind,"inserted":inserted,"updated":updated,"deleted":deleted})});
            changed = true;
        }
        if changed {
            while self.state.history.len() > 1000 {
                self.state.history.pop_front();
            }
            self.save()?;
        }
        Ok(())
    }
    fn resource_bytes(&self, resource: &Resource) -> Result<Vec<u8>> {
        self.alive()?;
        let bytes = read_private(&self.root.join("media").join(&resource.file), BYTES)?;
        if bytes.is_empty() || digest(&bytes) != resource.hash {
            return Err(failure(
                "unsupported_target",
                "Photos resource bytes differ from retained library identity; metadata was preserved",
            ));
        }
        Ok(bytes)
    }
    fn asset(&self, id: &str) -> Result<&Asset> {
        let row = self.state.assets.get(id).ok_or_else(|| {
            failure(
                "unsupported_target",
                "exact Photos asset is absent from selected library",
            )
        })?;
        for resource in &row.resources {
            self.resource_bytes(resource)?;
        }
        Ok(row)
    }
    fn album_ids(&self, id: &str) -> Result<BTreeSet<String>> {
        if let Some(album) = self.state.albums.get(id) {
            return Ok(album.members.clone());
        }
        for kind in ["favorites", "hidden", "videos"] {
            if id == self.smart_id(kind) {
                return Ok(self
                    .state
                    .assets
                    .iter()
                    .filter(|(_, a)| match kind {
                        "favorites" => a.row["isFavorite"] == true,
                        "hidden" => a.row["isHidden"] == true,
                        _ => a.row["mediaType"] == "video",
                    })
                    .map(|(id, _)| id.clone())
                    .collect());
            }
        }
        Err(failure(
            "unsupported_target",
            "exact Photos album is absent from selected library",
        ))
    }
    fn smart_id(&self, kind: &str) -> String {
        format!("smart:{}:{kind}", self.state.library)
    }
    fn album_row(&self, id: &str) -> Result<Value> {
        let members = self.album_ids(id)?;
        if let Some(album) = self.state.albums.get(id) {
            Ok(
                json!({"id":id,"title":album.name,"type":"album","subtype":"ownedFileAlbum","estimatedAssetCount":members.len()}),
            )
        } else {
            let kind = id.rsplit(':').next().unwrap();
            Ok(
                json!({"id":id,"title":kind,"type":"smart","subtype":kind,"estimatedAssetCount":members.len()}),
            )
        }
    }
    fn token(&self) -> String {
        STANDARD.encode(
            serde_json::to_vec(&json!(["photos1", self.state.library, self.state.revision]))
                .unwrap(),
        )
    }
    fn changes(&self, raw: &str) -> Result<Value> {
        let bytes = STANDARD
            .decode(raw)
            .map_err(|_| failure("invalid_request", "invalid Photos token"))?;
        let values: Vec<Value> = serde_json::from_slice(&bytes)
            .map_err(|_| failure("invalid_request", "Photos token is not a library token"))?;
        if values.len() != 3 || values[0] != "photos1" || values[1] != self.state.library {
            return Err(failure(
                "unsupported_target",
                "Photos token belongs to another library or generation",
            ));
        }
        let revision = number(&values[2])
            .filter(|n| *n <= self.state.revision)
            .ok_or_else(|| {
                failure(
                    "invalid_request",
                    "Photos token revision is invalid or in the future",
                )
            })?;
        if self
            .state
            .history
            .front()
            .is_some_and(|c| revision < c.revision - 1)
        {
            return Err(failure(
                "data_lost",
                "Photos history retention passed the supplied token; no token advancement",
            ));
        }
        let events = self
            .state
            .history
            .iter()
            .filter(|c| c.revision > revision)
            .map(|c| c.event.clone())
            .collect::<Vec<_>>();
        let count: usize = events
            .iter()
            .map(|e| {
                ["inserted", "updated", "deleted"]
                    .iter()
                    .map(|k| e[k].as_array().unwrap().len())
                    .sum::<usize>()
            })
            .sum();
        if count > 12000 {
            return Err(failure(
                "resource_limit",
                "Photos history exceeds 12000 identifiers; no token advancement",
            ));
        }
        Ok(json!({"events":events,"currentToken":self.token()}))
    }
    fn output(&self, path: &Path, bytes: &[u8]) -> Result<usize> {
        self.alive()?;
        if bytes.is_empty() || bytes.len() > BYTES {
            return Err(failure("resource_limit", "Photos output exceeds 128MiB"));
        }
        let mut file = crate::monitor::private_file(path, true).map_err(io_error)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(io_error)?;
        drop(file);
        if read_private(path, BYTES)? != bytes {
            return Err(failure(
                "partial_result",
                "Photos output readback differs; artifact preserved",
            ));
        }
        #[cfg(target_os = "linux")]
        File::open(path.parent().unwrap())
            .and_then(|d| d.sync_all())
            .map_err(io_error)?;
        Ok(bytes.len())
    }
}
fn command(path: &Path, args: &[String], deadline: Instant, max: usize) -> Result<Vec<u8>> {
    if Instant::now() >= deadline {
        return Err(failure(
            "timeout_unknown_outcome",
            "Photos engine deadline expired before start",
        ));
    }
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = crate::auth::AuthChild(command.spawn().map_err(io_error)?);
    let output = child
        .0
        .stdout
        .take()
        .ok_or_else(|| failure("provider_failed", "Photos engine output is unavailable"))?;
    let (tx, rx) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output
            .take(max as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    loop {
        if Instant::now() >= deadline {
            return Err(failure(
                "timeout_unknown_outcome",
                "Photos engine exceeded deadline; owned helper group/job is retired",
            ));
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(bytes) => {
                let bytes = bytes.map_err(io_error)?;
                if bytes.len() > max {
                    return Err(failure(
                        "resource_limit",
                        "Photos engine output exceeds bounded frame",
                    ));
                }
                let status = loop {
                    if let Some(status) = child.0.try_wait().map_err(io_error)? {
                        break status;
                    }
                    if Instant::now() >= deadline {
                        return Err(failure(
                            "timeout_unknown_outcome",
                            "Photos engine did not exit after output",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                };
                let _ = reader.join();
                if !status.success() {
                    return Err(failure(
                        "provider_failed",
                        format!("Photos engine exited unsuccessfully: {status}"),
                    ));
                }
                return Ok(bytes);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => (),
            Err(_) => {
                return Err(failure(
                    "provider_failed",
                    "Photos engine reader disconnected",
                ));
            }
        }
    }
}
fn engine(variable: &str, version: &str, deadline: Instant) -> Result<PathBuf> {
    let (path, _) = crate::native_library::pinned_bytes(variable, 64 * 1024 * 1024)?;
    let args = if variable == "INTERCEPTOR_PHOTOS_EXIFTOOL" {
        vec!["-config".into(), "".into(), "-ver".into()]
    } else {
        vec!["-version".into()]
    };
    let bytes = command(&path, &args, deadline, 65536)?;
    let text = String::from_utf8(bytes)
        .map_err(|_| failure("version_mismatch", "Photos engine version is not UTF8"))?;
    if if variable == "INTERCEPTOR_PHOTOS_EXIFTOOL" {
        text.trim() != version
    } else {
        !text
            .lines()
            .next()
            .unwrap_or("")
            .starts_with(&format!("ffmpeg version {version} "))
    } {
        return Err(failure(
            "version_mismatch",
            "Photos engine version differs from selected source version",
        ));
    }
    Ok(path)
}
fn metadata(path: &Path, deadline: Instant) -> Result<Value> {
    let exe = engine("INTERCEPTOR_PHOTOS_EXIFTOOL", "13.00", deadline)?;
    let mut args = vec![
        "-config".into(),
        "".into(),
        "-json".into(),
        "-n".into(),
        "-G1".into(),
        "-s".into(),
    ];
    for tag in [
        "FileType",
        "FileTypeExtension",
        "ImageWidth",
        "ImageHeight",
        "Duration",
        "MediaDuration",
        "ContentIdentifier",
        "Orientation",
        "Rotation",
        "SubSecDateTimeOriginal",
        "DateTimeOriginal",
        "OffsetTimeOriginal",
        "CreateDate",
        "ModifyDate",
    ] {
        args.push(format!("-{tag}"));
    }
    args.push("--".into());
    args.push(path.to_string_lossy().into());
    let bytes = command(&exe, &args, deadline, 262144)?;
    let rows: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| {
        failure(
            "provider_failed",
            "Photos metadata engine did not return JSON",
        )
    })?;
    if rows.len() != 1 || !rows[0].is_object() {
        return Err(failure(
            "provider_failed",
            "Photos metadata engine returned an ambiguous item",
        ));
    }
    Ok(rows.into_iter().next().unwrap())
}
fn meta<'a>(data: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    let rows = data
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| k.rsplit(':').next() == Some(key))
        .map(|(_, v)| v)
        .collect::<Vec<_>>();
    if rows.windows(2).any(|p| p[0] != p[1]) {
        return Err(failure(
            "unsupported_target",
            format!("native Photos metadata is ambiguous for {key}"),
        ));
    }
    Ok(rows.first().copied())
}
fn dimensions(data: &Value) -> Result<(u32, u32)> {
    let w = meta(data, "ImageWidth")?
        .and_then(number)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| failure("unsupported_target", "actual photo/video width is missing"))?;
    let h = meta(data, "ImageHeight")?
        .and_then(number)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| failure("unsupported_target", "actual photo/video height is missing"))?;
    crate::capture::pixel_size(w, h)?;
    let rotated = meta(data, "Orientation")?
        .and_then(number)
        .is_some_and(|n| (5..=8).contains(&n))
        || meta(data, "Rotation")?
            .and_then(Value::as_f64)
            .is_some_and(|n| n.abs() == 90.0 || n.abs() == 270.0);
    Ok(if rotated { (h, w) } else { (w, h) })
}
fn captured_date(data: &Value) -> Result<Option<String>> {
    for key in ["SubSecDateTimeOriginal", "DateTimeOriginal", "CreateDate"] {
        if let Some(raw) = meta(data, key)?.and_then(Value::as_str) {
            if !raw.is_ascii() || raw.len() > 4096 {
                continue;
            }
            let mut text = raw.to_owned();
            if text.len() > 10 && text.as_bytes()[4] == b':' && text.as_bytes()[7] == b':' {
                text.replace_range(7..8, "-");
                text.replace_range(4..5, "-");
            }
            if text.len() > 10 && text.as_bytes()[10] == b' ' {
                text.replace_range(10..11, "T");
            }
            if !text.ends_with('Z') && text.len() >= 19 && !text[19..].contains(['+', '-']) {
                if let Some(offset) = meta(data, "OffsetTimeOriginal")?.and_then(Value::as_str) {
                    text.push_str(offset);
                }
            }
            if let Some(date) = crate::log::timestamp(&text) {
                return date
                    .format(&time::format_description::well_known::Rfc3339)
                    .map(Some)
                    .map_err(|e| failure("provider_failed", e));
            }
        }
    }
    Ok(None)
}
fn import(library: &mut Library, a: &Value) -> Result<Value> {
    if library.state.assets.len() >= 1000 {
        return Err(failure(
            "resource_limit",
            "Photos library exceeds 1000 assets",
        ));
    }
    let album = a["album"].as_str();
    if let Some(id) = album {
        if !library.state.albums.contains_key(id) {
            return Err(failure(
                "unsupported_target",
                "Photos import requires an exact writable owned album",
            ));
        }
    }
    let source = crate::filesystem::absolute(a["file"].as_str().unwrap())?;
    let bytes = crate::thumbnail::source_bytes(&source)?;
    if bytes.is_empty() {
        return Err(failure("unsupported_target", "Photos import file is empty"));
    }
    let id = fresh("asset")?;
    let stem = id.replace(':', "-");
    let file = format!("{stem}.media");
    let path = library.root.join("media").join(&file);
    library.output(&path, &bytes)?;
    // Nothing references these copies until the commit below, so a refused import keeps neither.
    let paired = library.root.join("media").join(format!("{stem}.paired.mov"));
    let prepared = (|| -> Result<(Value, Vec<Resource>)> {
        let data = metadata(&path, library.deadline)?;
        let filetype = meta(&data, "FileType")?
            .and_then(Value::as_str)
            .ok_or_else(|| failure("unsupported_target", "actual Photos file type is missing"))?;
        let video = a["sub"] == "import-video";
        let uti = match filetype {
            "JPEG" => "public.jpeg",
            "PNG" => "public.png",
            "WEBP" => "org.webmproject.webp",
            "HEIC" | "HEIF" => "public.heic",
            "AVIF" => "public.avif",
            "MOV" => "com.apple.quicktime-movie",
            "MP4" => "public.mpeg-4",
            "MKV" => "org.matroska.mkv",
            "AVI" => "public.avi",
            _ => {
                return Err(failure(
                    "unsupported_target",
                    "Photos native metadata reports an unsupported container; no copy was kept",
                ));
            }
        };
        if video != matches!(filetype, "MOV" | "MP4" | "MKV" | "AVI") {
            return Err(failure(
                "unsupported_target",
                "actual Photos import media type differs; no copy was kept",
            ));
        }
        let (width, height) = if !video && matches!(filetype, "JPEG" | "PNG" | "WEBP") {
            crate::thumbnail::decode_raster(&bytes)?.dimensions()
        } else {
            dimensions(&data)?
        };
        let duration = if video {
            meta(&data, "Duration")?
                .or(meta(&data, "MediaDuration")?)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1e9)
                .ok_or_else(|| failure("unsupported_target", "actual video duration is missing"))?
        } else {
            0.0
        };
        let now = instant()?;
        let mut row = json!({"id":id,"mediaType":if video{"video"}else{"image"},"pixelWidth":width,"pixelHeight":height,"duration":duration,"isFavorite":false,"isHidden":false,"sourceType":"ownedFileLibrary","addedDate":now,"modificationDate":now});
        if let Some(date) = captured_date(&data)? {
            row["creationDate"] = json!(date);
        }
        let mut resources = vec![Resource {
            file,
            hash: digest(&bytes),
            uti: uti.into(),
            kind: if video { "video" } else { "image" }.into(),
        }];
        if !video {
            if let Some(content) = meta(&data, "ContentIdentifier")?
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 256)
            {
                // A case-insensitive volume (NTFS) names one sidecar both ways; its canonical path counts once.
                let candidates = [source.with_extension("mov"), source.with_extension("MOV")]
                    .into_iter()
                    .filter_map(|p| fs::canonicalize(p).ok())
                    .collect::<BTreeSet<_>>();
                if candidates.len() > 1 {
                    return Err(failure(
                        "unsupported_target",
                        "multiple Live Photo sidecars are present; exact pair is ambiguous",
                    ));
                }
                if let Some(sidecar) = candidates.into_iter().next() {
                    let paired = crate::thumbnail::source_bytes(&sidecar)?;
                    let file = format!("{stem}.paired.mov");
                    let target = library.root.join("media").join(&file);
                    library.output(&target, &paired)?;
                    let video = metadata(&target, library.deadline)?;
                    if meta(&video, "FileType")?.and_then(Value::as_str) != Some("MOV")
                        || meta(&video, "ContentIdentifier")?.and_then(Value::as_str) != Some(content)
                    {
                        return Err(failure(
                            "unsupported_target",
                            "Live Photo native image/video content identifiers differ; no copy was kept",
                        ));
                    }
                    dimensions(&video)?;
                    resources.push(Resource {
                        file,
                        hash: digest(&paired),
                        uti: "com.apple.quicktime-movie".into(),
                        kind: "video".into(),
                    });
                    row["mediaSubtypes"] = json!(["livePhoto"]);
                }
            }
        }
        Ok((row, resources))
    })();
    let (row, resources) = prepared.map_err(|e| {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&paired);
        e
    })?;
    library
        .state
        .assets
        .insert(id.clone(), Asset { row, resources });
    if let Some(album) = album {
        library
            .state
            .albums
            .get_mut(album)
            .unwrap()
            .members
            .insert(id.clone());
    }
    library.commit()?;
    library.asset(&id)?;
    Ok(json!({"ok":true,"id":id}))
}
fn matches_predicate(row: &Value, comparison: &Comparison) -> Result<bool> {
    let native = if comparison.key == "mediaType" {
        json!(match row["mediaType"].as_str() {
            Some("image") => 1,
            Some("video") => 2,
            Some("audio") => 3,
            _ => 0,
        })
    } else {
        row[&comparison.key].clone()
    };
    if native.is_null() {
        return Ok(false);
    }
    let ordering = if comparison.key.ends_with("Date") {
        native
            .as_str()
            .and_then(crate::log::timestamp)
            .zip(comparison.value.as_str().and_then(crate::log::timestamp))
            .map(|(x, y)| x.cmp(&y))
    } else if let (Some(x), Some(y)) = (native.as_bool(), comparison.value.as_bool()) {
        Some(x.cmp(&y))
    } else {
        native
            .as_f64()
            .zip(comparison.value.as_f64())
            .and_then(|(x, y)| x.partial_cmp(&y))
    };
    let Some(ordering) = ordering else {
        return Err(failure(
            "partial_result",
            "stored Photos scalar does not match native predicate field",
        ));
    };
    use std::cmp::Ordering::{Equal, Greater, Less};
    Ok(match comparison.op.as_str() {
        "==" => ordering == Equal,
        "!=" => ordering != Equal,
        ">" => ordering == Greater,
        "<" => ordering == Less,
        ">=" => ordering != Less,
        "<=" => ordering != Greater,
        _ => false,
    })
}
fn raster(library: &Library, asset: &Asset, size: u32) -> Result<image::RgbaImage> {
    let resource = asset
        .resources
        .iter()
        .find(|r| r.kind == "image")
        .unwrap_or(&asset.resources[0]);
    let bytes = library.resource_bytes(resource)?;
    let mut pixels = if matches!(
        resource.uti.as_str(),
        "public.jpeg" | "public.png" | "org.webmproject.webp"
    ) {
        crate::thumbnail::decode_raster(&bytes)?
    } else {
        let exe = engine("INTERCEPTOR_PHOTOS_FFMPEG", "8.0", library.deadline)?;
        let path = library.root.join("media").join(&resource.file);
        let args = vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-threads".into(),
            "1".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-i".into(),
            path.to_string_lossy().into(),
            "-map".into(),
            "0:v:0".into(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            format!("scale={size}:{size}:force_original_aspect_ratio=decrease"),
            "-threads".into(),
            "1".into(),
            "-f".into(),
            "image2pipe".into(),
            "-c:v".into(),
            "png".into(),
            "pipe:1".into(),
        ];
        crate::thumbnail::decode_raster(&command(&exe, &args, library.deadline, 8 * 1024 * 1024)?)?
    };
    let (w, h) = pixels.dimensions();
    let edge = w.max(h);
    if edge > size {
        pixels = image::imageops::resize(
            &pixels,
            ((w as u64 * size as u64) / edge as u64).max(1) as u32,
            ((h as u64 * size as u64) / edge as u64).max(1) as u32,
            image::imageops::FilterType::Triangle,
        );
    }
    Ok(pixels)
}
fn export(library: &Library, a: &Value) -> Result<Value> {
    let id = a["id"].as_str().unwrap();
    let asset = library.asset(id)?;
    let sub = a["sub"].as_str().unwrap();
    if sub == "export-live" {
        if asset.resources.len() != 2
            || !asset.resources.iter().any(|r| r.kind == "image")
            || !asset.resources.iter().any(|r| r.kind == "video")
        {
            return Err(failure(
                "unsupported_target",
                "Photos asset has no actual content-identifier-matched live resource pair",
            ));
        }
        let base = crate::filesystem::absolute(a["out"].as_str().unwrap())?;
        let mut resources = Vec::new();
        for resource in &asset.resources {
            let ext = match resource.uti.as_str() {
                "public.jpeg" => "jpg",
                "public.png" => "png",
                "public.heic" => "heic",
                "public.avif" => "avif",
                "org.webmproject.webp" => "webp",
                "com.apple.quicktime-movie" => "mov",
                _ => {
                    return Err(failure(
                        "unsupported_target",
                        "Live Photo resource type is unsupported",
                    ));
                }
            };
            let path = PathBuf::from(format!("{}.{ext}", base.to_string_lossy()));
            let bytes = library.resource_bytes(resource)?;
            let count = match library.output(&path, &bytes) {
                Ok(count) => count,
                Err(error) => {
                    return Err(
                        json!({"success":false,"code":"partial_result","error":error["error"],"details":{"writtenResources":resources,"outcomeUnknown":true}}),
                    );
                }
            };
            resources.push(
                json!({"filePath":path,"uti":resource.uti,"bytes":count,"type":resource.kind}),
            );
        }
        return Ok(json!({"ok":true,"assetId":id,"filePathBase":base,"resources":resources}));
    }
    if sub == "export-video"
        || sub == "export" && a.get("format").is_none() && a.get("size").is_none()
    {
        let kind = if sub == "export-video" {
            "video"
        } else {
            "image"
        };
        if asset.row["mediaType"] != kind {
            return Err(failure(
                "unsupported_target",
                "Photos resource export media type differs",
            ));
        }
        let resource = asset.resources.iter().find(|r| r.kind == kind).unwrap();
        let bytes = library.resource_bytes(resource)?;
        let path = crate::filesystem::absolute(a["out"].as_str().unwrap())?;
        let count = library.output(&path, &bytes)?;
        return Ok(
            json!({"ok":true,"assetId":id,"filePath":path,"uti":resource.uti,"bytes":count,"originalWidth":asset.row["pixelWidth"],"originalHeight":asset.row["pixelHeight"]}),
        );
    }
    if sub == "export" && asset.row["mediaType"] != "image" {
        return Err(failure(
            "unsupported_target",
            "Photos raster export requires an image",
        ));
    }
    let size = number(&a["size"]).unwrap_or(if sub == "thumbnail" {
        256
    } else {
        number(&asset.row["pixelWidth"])
            .unwrap()
            .max(number(&asset.row["pixelHeight"]).unwrap())
    }) as u32;
    let pixels = raster(library, asset, size)?;
    let format = a["format"].as_str().unwrap_or("jpeg");
    let bytes = crate::capture::encode(&pixels, format, 85)?;
    let save = sub != "thumbnail" || a.get("out").is_some() || a["save"] == true;
    let mut data = if sub == "thumbnail" {
        json!({"ok":true,"format":"jpeg","bytes":bytes.len(),"width":pixels.width(),"height":pixels.height()})
    } else {
        json!({"ok":true,"assetId":id,"uti":if format=="png"{"public.png"}else{"public.jpeg"},"bytes":bytes.len(),"originalWidth":asset.row["pixelWidth"],"originalHeight":asset.row["pixelHeight"],"exportWidth":pixels.width(),"exportHeight":pixels.height()})
    };
    if save {
        let path = if let Some(raw) = a["out"].as_str() {
            crate::filesystem::absolute(raw)?
        } else {
            library
                .root
                .join(format!("thumbnail-{}.jpg", crate::monitor::identifier()))
        };
        library.output(&path, &bytes)?;
        data["filePath"] = json!(path);
    } else {
        if bytes.len() > 700000 {
            return Err(failure(
                "resource_limit",
                "inline Photos thumbnail exceeds 700000 bytes; use --out",
            ));
        }
        data["dataUrl"] = json!(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(&bytes)
        ));
    }
    Ok(data)
}
fn perform(a: &Value, deadline: Instant) -> Result<Value> {
    let sub = a["sub"].as_str().unwrap();
    if sub == "assets"
        && a["subtype"]
            .as_str()
            .is_some_and(|s| !matches!(s, "live" | "livePhoto"))
    {
        return Err(failure(
            "unsupported_operation",
            "selected file library cannot report Apple-specific computed media classifications; no fabricated empty result",
        ));
    }
    if sub == "status" {
        let status = match root() {
            Ok(path) if path.join("library.json").exists() => {
                crate::monitor::private_directory(&path, false, false).map_err(io_error)?;
                let state: State =
                    serde_json::from_slice(&read_private(&path.join("library.json"), STATE_BYTES)?)
                        .map_err(|_| {
                            failure("partial_result", "Photos library state is malformed")
                        })?;
                validate_state(&state)?;
                "authorized"
            }
            _ => "notConfigured",
        };
        return Ok(
            json!({"status":status,"provider":"owned-file-photo-library","scope":"explicit owner-private library; status is filesystem authority, not a system-gallery privacy grant"}),
        );
    }
    let mut library = Library::open(sub == "request", deadline)?;
    match sub {
        "request" => Ok(
            json!({"status":"authorized","provider":"owned-file-photo-library","scope":"explicit owner-private library; no system gallery access or permission prompt"}),
        ),
        "current-token" => Ok(json!({"token":library.token()})),
        "changes" => library.changes(a["token"].as_str().unwrap()),
        "albums" => {
            if a["album_type"] == "moment" {
                return Err(failure(
                    "unsupported_operation",
                    "Apple moments have no owned-file-library equivalent",
                ));
            }
            let mut rows = Vec::new();
            if a["album_type"] != "smart" {
                for id in library.state.albums.keys() {
                    rows.push(library.album_row(id)?);
                }
            }
            if a["album_type"] != "album" {
                for kind in ["favorites", "hidden", "videos"] {
                    rows.push(library.album_row(&library.smart_id(kind))?);
                }
            }
            if rows.len() > 1000 {
                return Err(failure("resource_limit", "Photos album result exceeds 1000"));
            }
            Ok(json!({"albums":rows}))
        }
        "album" => library.album_row(a["id"].as_str().unwrap()),
        "album-create" => {
            if library.state.albums.len() >= 997 {
                return Err(failure(
                    "resource_limit",
                    "Photos album capacity includes 3 native library filter albums",
                ));
            }
            let id = fresh("album")?;
            let name = a["name"].as_str().unwrap().to_owned();
            library.state.albums.insert(
                id.clone(),
                Album {
                    name: name.clone(),
                    members: BTreeSet::new(),
                },
            );
            library.commit()?;
            Ok(json!({"id":id,"name":name}))
        }
        "album-delete" | "album-rename" => {
            let id = a["id"].as_str().unwrap();
            let row = library.state.albums.get_mut(id).ok_or_else(|| {
                failure(
                    "unsupported_target",
                    "Photos album mutation requires an exact writable owned album",
                )
            })?;
            if sub == "album-delete" {
                library.state.albums.remove(id);
                library.commit()?;
                Ok(json!({"ok":true,"id":id}))
            } else {
                let name = a["name"].as_str().unwrap();
                if row.name != name {
                    row.name = name.into();
                    library.commit()?;
                }
                Ok(json!({"id":id,"name":name}))
            }
        }
        "asset" => Ok(library.asset(a["id"].as_str().unwrap())?.row.clone()),
        "assets" => {
            let members = a["album"]
                .as_str()
                .map(|id| library.album_ids(id))
                .transpose()?;
            let predicates = a["where"]
                .as_str()
                .map(comparisons)
                .transpose()?
                .unwrap_or_default();
            let mut rows = Vec::new();
            for (id, asset) in &library.state.assets {
                library.alive()?;
                if members.as_ref().is_some_and(|m| !m.contains(id))
                    || a.get("media").is_some() && asset.row["mediaType"] != a["media"]
                    || a["favorite"] == true && asset.row["isFavorite"] != true
                    || a["hidden"] != true && asset.row["isHidden"] == true
                {
                    continue;
                }
                if let Some(subtype) = a["subtype"].as_str() {
                    let subtype = if subtype == "live" {
                        "livePhoto"
                    } else if subtype == "streamed" {
                        "streamedVideo"
                    } else {
                        subtype
                    };
                    if !asset.row["mediaSubtypes"]
                        .as_array()
                        .is_some_and(|rows| rows.iter().any(|v| v == subtype))
                    {
                        continue;
                    }
                }
                let created = asset.row["creationDate"]
                    .as_str()
                    .and_then(crate::log::timestamp);
                if a["since"]
                    .as_str()
                    .and_then(crate::log::timestamp)
                    .is_some_and(|lo| created.is_none_or(|d| d < lo))
                    || a["until"]
                        .as_str()
                        .and_then(crate::log::timestamp)
                        .is_some_and(|hi| created.is_none_or(|d| d > hi))
                {
                    continue;
                }
                let mut matches = true;
                for comparison in &predicates {
                    if !matches_predicate(&asset.row, comparison)? {
                        matches = false;
                        break;
                    }
                }
                if matches {
                    rows.push(&asset.row);
                }
            }
            rows.sort_by(|x, y| {
                y["creationDate"]
                    .as_str()
                    .cmp(&x["creationDate"].as_str())
                    .then_with(|| x["id"].as_str().cmp(&y["id"].as_str()))
            });
            let count = rows.len();
            let limit = number(&a["limit"]).unwrap_or(100) as usize;
            let offset = number(&a["offset"]).unwrap_or(0) as usize;
            let mut page = Vec::new();
            for row in rows.into_iter().skip(offset).take(limit) {
                page.push(library.asset(row["id"].as_str().unwrap())?.row.clone());
            }
            Ok(
                json!({"count":count,"limit":limit,"offset":offset,"hasMore":offset+page.len()<count,"assets":page}),
            )
        }
        "favorite" | "hide" => {
            let id = a["id"].as_str().unwrap();
            library.asset(id)?;
            let field = if sub == "favorite" {
                "isFavorite"
            } else {
                "isHidden"
            };
            let on = a["on"].as_bool().unwrap_or(true);
            let row = &mut library.state.assets.get_mut(id).unwrap().row;
            if row[field] != json!(on) {
                row[field] = json!(on);
                row["modificationDate"] = json!(instant()?);
                library.commit()?;
            }
            Ok(json!({"ok":true,"id":id,field:on}))
        }
        "add-to-album" | "remove-from-album" => {
            let id = a["album"].as_str().unwrap();
            let assets = ids(a["asset"].as_str().unwrap())?;
            for asset in &assets {
                library.asset(asset)?;
            }
            let album = library.state.albums.get_mut(id).ok_or_else(|| {
                failure(
                    "unsupported_target",
                    "Photos membership mutation requires exact writable owned album",
                )
            })?;
            let mut changed = false;
            for asset in &assets {
                changed |= if sub == "add-to-album" {
                    album.members.insert(asset.clone())
                } else {
                    album.members.remove(asset)
                };
            }
            if changed {
                library.commit()?;
            }
            Ok(json!({"ok":true,"album":id,"assets":assets}))
        }
        "delete" => {
            let assets = ids(a["id"].as_str().unwrap())?;
            let mut files = Vec::new();
            for id in &assets {
                files.extend(
                    library
                        .asset(id)?
                        .resources
                        .iter()
                        .map(|r| library.root.join("media").join(&r.file)),
                );
            }
            for id in &assets {
                library.state.assets.remove(id);
                for album in library.state.albums.values_mut() {
                    album.members.remove(id);
                }
            }
            library.commit()?;
            for path in files {
                fs::remove_file(&path).map_err(|e|json!({"success":false,"code":"partial_result","error":e.to_string(),"details":{"libraryDeletionCommitted":true,"remainingFile":path,"outcomeUnknown":true}}))?;
            }
            #[cfg(target_os = "linux")]
            File::open(library.root.join("media"))
                .and_then(|d| d.sync_all())
                .map_err(io_error)?;
            Ok(json!({"ok":true,"deleted":assets}))
        }
        "import" | "import-video" => import(&mut library, a),
        "export" | "export-video" | "export-live" | "thumbnail" => export(&library, a),
        _ => Err(failure("invalid_request", "unknown Photos selector")),
    }
}
fn reply_error(a: &Value, data: &Value) -> Option<String> {
    macro_rules! shape {
        ($t:ty) => {
            serde_json::from_value::<$t>(data.clone()).map(|_| ())
        };
    }
    let result = match a["sub"].as_str().unwrap() {
        "status" | "request" => shape!(DesktopPhotosStatus),
        "albums" => shape!(DesktopPhotosAlbums),
        "album" => shape!(DesktopPhotosAlbum),
        "assets" => shape!(DesktopPhotosAssets),
        "asset" => shape!(DesktopPhotosAsset),
        "album-create" | "album-rename" => shape!(DesktopPhotosNamed),
        "export" | "export-video" => shape!(DesktopPhotosExport),
        "export-live" => shape!(DesktopPhotosLiveExport),
        "thumbnail" => shape!(DesktopPhotosThumbnail),
        "delete" => shape!(DesktopPhotosDeleted),
        "add-to-album" | "remove-from-album" => shape!(DesktopPhotosMembership),
        "current-token" => shape!(DesktopPhotosToken),
        "changes" => shape!(DesktopPhotosChanges),
        _ => shape!(DesktopPhotosOK),
    };
    if result.is_err() {
        return Some("Photos helper reply violates exact selector schema".into());
    }
    if serde_json::to_vec(data).ok()?.len() > 1048576 {
        return Some("Photos reply exceeds 1MiB".into());
    }
    if data.get("ok").is_some() && data["ok"] != true {
        return Some("Photos effect receipt did not confirm success".into());
    }
    None
}
pub fn dispatch(a: &Value) -> Value {
    if let Err(error) = validate(a) {
        return error;
    }
    let Ok(_active) = ACTIVE.try_lock() else {
        return failure(
            "resource_limit",
            "another Photos helper remains active; nothing queued",
        );
    };
    match crate::thumbnail::image_helper(
        "--photos-engine",
        a,
        Instant::now() + Duration::from_secs(55),
    ) {
        Ok(data) => match reply_error(a, &data) {
            Some(error) => failure("partial_result", error),
            None => success(data),
        },
        Err(error) => error,
    }
}
pub(crate) fn helper(parent: u32) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    unsafe {
        let memory = libc::rlimit {
            rlim_cur: 512 * 1024 * 1024,
            rlim_max: 512 * 1024 * 1024,
        };
        let core = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::setrlimit(libc::RLIMIT_AS, &memory) != 0
            || libc::setrlimit(libc::RLIMIT_CORE, &core) != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    crate::thumbnail::retain_provider(parent)?;
    let bytes = crate::read_frame(&mut io::stdin().lock())?
        .ok_or_else(|| io::Error::other("Photos helper requires one request"))?;
    let action: Value = serde_json::from_slice(&bytes)?;
    let result = match validate(&action) {
        Err(error) => error,
        Ok(()) => match perform(&action, Instant::now() + Duration::from_secs(48)) {
            Ok(data) => match reply_error(&action, &data) {
                Some(error) => failure("partial_result", error),
                None => success(data),
            },
            Err(error) => error,
        },
    };
    let bytes = serde_json::to_vec(&result)?;
    crate::write_frame(
        &mut io::stdout().lock(),
        &if bytes.len() > 1048576 {
            serde_json::to_vec(&failure(
                "partial_result",
                "Photos receipt exceeds 1MiB after possible effect",
            ))?
        } else {
            bytes
        },
    )
}
pub fn capability(session: &str) -> Value {
    json!({"operation":"photos","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"permission":"unknown","session":session,"effective":false,"background":"semantic","provider":"owned-file-photo-library","versions":{"contract":"1","exiftool":"13.00","ffmpeg":"8.0"},"limits":["Explicit owner-private INTERCEPTOR_PHOTOS_LIBRARY; actual filesystem authority and library metadata, no unrelated gallery database or Apple iCloud access.","Twenty-two selectors; read-only computed favorite/hidden/video albums; moments are Apple-specific and unavailable. Unknown capture/subtype metadata is omitted; no timezone is invented for floating EXIF dates.","JPEG/PNG/WebP use the existing 32M-pixel decoder. HEIC/AVIF/video require mandatory-SHA256 ExifTool 13.00 and FFmpeg 8.0. Exact engine bundles, codecs and licenses require staging and qualification.","Live pairs import same-stem MOV only when actual native Apple/QuickTime ContentIdentifier values match. Original encoded exports preserve observed UTI, with private exclusive files and byte readback.","One owned reaped 512MiB helper, 48-second native budget; 1000 assets/1000 albums; 8MiB state; 128MiB output/64MiB imports; 1MiB replies; 1000 retained library changes. Expired/wrong-library tokens refuse without advancement.","Source candidate only; grouped builds, engines/assets/licenses, actual native metadata/pixels/history, installed CLI/MCP, focus/privacy and affected-route qualification remain open."]})
}
