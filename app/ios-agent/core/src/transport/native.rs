//! The idevice-backed native surface (iOS 27+).
//!
//! The phone reaches its own developer services through the app's loopback route (packet
//! tunnel or the user's loopback VPN). This module owns the RSD handshake over that TCP
//! endpoint, the AX client, the CoreDevice HID/display/pasteboard/screenshot/app services and
//! the conversion between the shared snapshot model and those services.
//!
//! Platform note: the only OS-specific part is the endpoint. On iOS it is the loopback address
//! the app's Network Extension exposes; on a host (used by the setup helper and by compile
//! checks) it is a forwarded port. Everything else is the same Rust.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};

use idevice::provider::RsdProvider;
use idevice::services::core_device::display_stream::{
    build_start_video_parameters, DisplayServiceClient, MediaNegotiationBlob,
};
use idevice::services::core_device::{
    AppServiceClient, ButtonState, ImageFormat, IndigoHidClient, PasteboardServiceClient,
    ScreenCaptureServiceClient, UniversalHidServiceClient, GENERAL_PASTEBOARD,
    TOUCHSCREEN_STATE_CONTACT, TOUCHSCREEN_STATE_RELEASE,
};
use idevice::services::rsd::RsdHandshake;
use idevice::{IdeviceError, ReadWrite, RsdService};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::Mutex;

use super::ax::RemoteAxClient;
use crate::ax::{AppInfo, AxNode, Point, Rect, Snapshot};
use crate::error::{AgentError, AgentResult, FailureCode};
use crate::ops::{PressKey, ScrollDir};
use crate::surface::{DisplayGeometry, IosSurface, Screenshot, ServiceState};

/// The on-device loopback address the app's tunnel exposes. The setup/App shell may override
/// it; a host-side helper forwards the RSD port here instead.
#[cfg(target_os = "ios")]
pub const IOS_LOOPBACK_HOST: &str = "10.7.0.1";
#[cfg(not(target_os = "ios"))]
pub const IOS_LOOPBACK_HOST: &str = "127.0.0.1";

/// Default RSD port used by Device Hub (the CoreDevice tunnel advertises it; a loopback route
/// normally forwards the same port).
pub const DEFAULT_RSD_PORT: u16 = 49152;

/// The stream type every idevice service client is generic over.
type BoxedRw = Box<dyn ReadWrite + 'static>;

pub fn default_loopback_endpoint() -> SocketAddr {
    format!("{IOS_LOOPBACK_HOST}:{DEFAULT_RSD_PORT}")
        .parse()
        .expect("loopback address is static")
}

struct Clients {
    ax: RemoteAxClient,
    hid: UniversalHidServiceClient<BoxedRw>,
    indigo: IndigoHidClient<BoxedRw>,
    paste: PasteboardServiceClient<BoxedRw>,
    screen: ScreenCaptureServiceClient<BoxedRw>,
    app: AppServiceClient<BoxedRw>,
    display: DisplayServiceClient<BoxedRw>,
    hid_ready: bool,
    hid_error: Option<String>,
    _auth: Option<AuthStream>,
}

/// Keeps the display media stream alive: HID reports are dropped by the device unless a
/// displayservice media stream authenticates the HID surfaces. The RTP payload itself is
/// discarded.
struct AuthStream {
    _video: Arc<UdpSocket>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for AuthStream {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Clients {
    async fn start_hid_auth(&mut self) -> AgentResult<AuthStream> {
        let video = UdpSocket::bind(("127.0.0.1", 0))
            .await
            .map_err(service_err)?;
        let addr = video.local_addr().map_err(service_err)?;
        let offer = MediaNegotiationBlob::video_offer(0x5354_524d)
            .to_negotiator_offer()
            .map_err(service_err)?;
        let session = uuid::Uuid::new_v4();
        let params = build_start_video_parameters(
            "127.0.0.1",
            addr.port(),
            "0.0.0.0",
            0,
            offer,
            0,
            1,
            session,
        );
        // The device begins sending HEVC/RTP to `video`; draining it keeps the socket from
        // blocking and keeps the stream alive for the HID surfaces.
        self.display
            .start_media_stream(params)
            .await
            .map_err(service_err)?;
        let socket = Arc::new(video);
        let task = tokio::spawn(drain(socket.clone()));
        Ok(AuthStream {
            _video: socket,
            tasks: vec![task],
        })
    }
}

async fn drain(socket: Arc<UdpSocket>) {
    let mut buf = [0u8; 4096];
    loop {
        if socket.recv(&mut buf).await.is_err() {
            break;
        }
    }
}

pub struct NativeSurface {
    ip: IpAddr,
    handshake: Mutex<RsdHandshake>,
    clients: Mutex<Option<Clients>>,
    state: RwLock<ServiceState>,
    geometry: RwLock<DisplayGeometry>,
    foreground: RwLock<AppInfo>,
}

impl NativeSurface {
    /// Connect to an established RSD endpoint. The tunnel (loopback VPN or a forwarded USB
    /// port) is authenticated before this call; no pairing record is needed for the services
    /// themselves.
    pub async fn connect(
        endpoint: SocketAddr,
        geometry: DisplayGeometry,
        foreground: AppInfo,
    ) -> AgentResult<Self> {
        let stream = TcpStream::connect(endpoint).await.map_err(service_err)?;
        let handshake = RsdHandshake::new(stream).await.map_err(service_err)?;
        Ok(Self {
            ip: endpoint.ip(),
            handshake: Mutex::new(handshake),
            clients: Mutex::new(None),
            state: RwLock::new(ServiceState::default()),
            geometry: RwLock::new(geometry),
            foreground: RwLock::new(foreground),
        })
    }

    /// The platform pushes these facts (keyguard, lease, pairing, DDI, Developer Mode, bridge)
    /// in from the app shell; the core never guesses them from a failed action.
    pub fn set_state(&self, state: ServiceState) {
        *self.state.write().unwrap() = state;
    }

    pub fn set_geometry(&self, geometry: DisplayGeometry) {
        *self.geometry.write().unwrap() = geometry;
    }

    pub fn set_foreground_app(&self, app: AppInfo) {
        *self.foreground.write().unwrap() = app;
    }

    async fn connect_clients(&self) -> AgentResult<Clients> {
        let handshake = self.handshake.lock().await;
        let mut ip = self.ip;
        let ax = connect_service::<RemoteAxClient>(&handshake, &mut ip).await?;
        let hid =
            connect_service::<UniversalHidServiceClient<BoxedRw>>(&handshake, &mut ip).await?;
        let indigo = connect_service::<IndigoHidClient<BoxedRw>>(&handshake, &mut ip).await?;
        let paste =
            connect_service::<PasteboardServiceClient<BoxedRw>>(&handshake, &mut ip).await?;
        let screen =
            connect_service::<ScreenCaptureServiceClient<BoxedRw>>(&handshake, &mut ip).await?;
        let app = connect_service::<AppServiceClient<BoxedRw>>(&handshake, &mut ip).await?;
        let display = connect_service::<DisplayServiceClient<BoxedRw>>(&handshake, &mut ip).await?;
        Ok(Clients {
            ax,
            hid,
            indigo,
            paste,
            screen,
            app,
            display,
            hid_ready: false,
            hid_error: None,
            _auth: None,
        })
    }

    async fn clients(&self) -> AgentResult<tokio::sync::MutexGuard<'_, Option<Clients>>> {
        let mut guard = self.clients.lock().await;
        if guard.is_none() {
            let mut clients = self.connect_clients().await?;
            clients.ax.init().await.map_err(service_err)?;
            match clients.start_hid_auth().await {
                Ok(auth) => {
                    clients._auth = Some(auth);
                    clients.hid_ready = true;
                }
                Err(err) => {
                    // Touch, typing and presses would be silently dropped by the device
                    // without the stream, so surface the failure instead of pretending.
                    clients.hid_error = Some(err.message);
                }
            }
            *guard = Some(clients);
        }
        Ok(guard)
    }

    fn ensure_hid(clients: &Clients) -> AgentResult<()> {
        if clients.hid_ready {
            Ok(())
        } else {
            Err(AgentError::new(
                FailureCode::ServiceUnavailable,
                clients
                    .hid_error
                    .clone()
                    .unwrap_or_else(|| "the HID authentication stream is not running".into()),
            ))
        }
    }

    async fn paste_text(&self, text: &str) -> AgentResult<()> {
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        purgeable_paste(clients, text).await
    }
}

async fn purgeable_paste(clients: &mut Clients, text: &str) -> AgentResult<()> {
    let previous = clients
        .paste
        .get(GENERAL_PASTEBOARD)
        .await
        .ok()
        .and_then(|snapshot| snapshot.text());
    clients
        .paste
        .set_text(text, GENERAL_PASTEBOARD)
        .await
        .map_err(service_err)?;
    // Cmd+V through the HID keyboard: Left GUI (0xE3) + V (0x19).
    for (usage, state) in [
        (0xE3u64, ButtonState::Down),
        (0x19, ButtonState::Down),
        (0x19, ButtonState::Up),
        (0xE3, ButtonState::Up),
    ] {
        clients
            .indigo
            .send_keyboard(usage, state)
            .await
            .map_err(service_err)?;
    }
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    // Put the user's text back. A non-text pasteboard cannot be restored through this API;
    // clearing our text is the best remaining option.
    let restore = previous.unwrap_or_default();
    let _ = clients.paste.set_text(&restore, GENERAL_PASTEBOARD).await;
    Ok(())
}

impl IosSurface for NativeSurface {
    fn state(&self) -> ServiceState {
        *self.state.read().unwrap()
    }

    fn geometry(&self) -> DisplayGeometry {
        *self.geometry.read().unwrap()
    }

    /// The native AX snapshot is a clean-room placeholder: `find`, `windows` and every gated
    /// op that rebuilds a snapshot fail `service-unavailable` with the reason until the focus
    /// payload shape is discovered from a permissive source or the device.
    async fn snapshot(&self) -> AgentResult<Snapshot> {
        let geometry = self.geometry();
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        let elements = clients.ax.snapshot(120).await.map_err(service_err)?;
        let mut root = AxNode::new(
            "Window",
            "",
            Rect::new(0.0, 0.0, geometry.width, geometry.height),
        );
        root.children = elements
            .into_iter()
            .map(|element| {
                let role = friendly_role(&element.role);
                AxNode {
                    clickable: role_clickable(&role),
                    editable: role_editable(&role),
                    scrollable: role_scrollable(&role),
                    role,
                    name: element.label,
                    view_id: if element.identifier.is_empty() {
                        None
                    } else {
                        Some(element.identifier)
                    },
                    rect: element.rect,
                    ..AxNode::default()
                }
            })
            .collect();
        let app = self.foreground.read().unwrap().clone();
        Ok(Snapshot::build(root, app))
    }

    async fn touch(&self, point: Point, duration_ms: u32) -> AgentResult<()> {
        let geometry = self.geometry();
        let (x, y) = geometry.normalize(point);
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        Self::ensure_hid(clients)?;
        if duration_ms == 0 {
            clients.hid.tap(x, y).await.map_err(service_err)
        } else {
            clients
                .hid
                .send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x, y, None)
                .await
                .map_err(service_err)?;
            tokio::time::sleep(std::time::Duration::from_millis(duration_ms as u64)).await;
            clients
                .hid
                .send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y, None)
                .await
                .map_err(service_err)
        }
    }

    async fn swipe(&self, from: Point, to: Point, duration_ms: u32) -> AgentResult<()> {
        let geometry = self.geometry();
        let (x1, y1) = geometry.normalize(from);
        let (x2, y2) = geometry.normalize(to);
        let steps = (duration_ms / 20).clamp(4, 40);
        let delay = (duration_ms / steps).max(1) as u64;
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        Self::ensure_hid(clients)?;
        clients
            .hid
            .drag(x1, y1, x2, y2, steps, delay)
            .await
            .map_err(service_err)
    }

    async fn type_text(&self, text: &str) -> AgentResult<()> {
        self.paste_text(text).await
    }

    async fn set_text(&self, _id: &str, node: &AxNode, text: &str) -> AgentResult<()> {
        if !node.rect.is_empty() {
            self.touch(node.rect.center(), 0).await?;
        }
        self.paste_text(text).await
    }

    async fn press(&self, key: PressKey) -> AgentResult<()> {
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        Self::ensure_hid(clients)?;
        match key {
            PressKey::Enter => {
                for state in [ButtonState::Down, ButtonState::Up] {
                    clients
                        .indigo
                        .send_keyboard(0x28, state)
                        .await
                        .map_err(service_err)?;
                }
                Ok(())
            }
            other => {
                let (usage_page, usage_code) = match other {
                    PressKey::Home => (0x0cu64, 0x40u64),
                    PressKey::Lock => (0x0c, 0x30),
                    PressKey::VolumeUp => (0x0c, 0xE9),
                    PressKey::VolumeDown => (0x0c, 0xEA),
                    PressKey::Enter => unreachable!(),
                };
                clients
                    .indigo
                    .send_button(usage_page, usage_code, ButtonState::Down)
                    .await
                    .map_err(service_err)?;
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                clients
                    .indigo
                    .send_button(usage_page, usage_code, ButtonState::Up)
                    .await
                    .map_err(service_err)
            }
        }
    }

    async fn screenshot(&self) -> AgentResult<Screenshot> {
        let geometry = self.geometry();
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        let png = clients
            .screen
            .take_screenshot(None, ImageFormat::Png)
            .await
            .map_err(service_err)?;
        Ok(Screenshot {
            png,
            window: self.foreground.read().unwrap().package.clone(),
            scale: geometry.scale,
        })
    }

    async fn launch_app(&self, package: &str, fresh: bool) -> AgentResult<()> {
        let mut guard = self.clients().await?;
        let clients = guard.as_mut().expect("clients present");
        clients
            .app
            .launch_application(
                package.to_string(),
                &[],
                fresh,
                false,
                None,
                None,
                None::<uuid::Uuid>,
            )
            .await
            .map_err(service_err)?;
        Ok(())
    }

    async fn scroll(&self, dir: ScrollDir, amount: u8) -> AgentResult<()> {
        let geometry = self.geometry();
        let (from, to, duration_ms) = crate::dispatch::scroll_swipe(geometry, dir, amount);
        self.swipe(from, to, duration_ms).await
    }
}

fn friendly_role(raw: &str) -> String {
    for (needle, role) in [
        ("Button", "Button"),
        ("SecureTextField", "SecureTextField"),
        ("SearchField", "TextField"),
        ("TextField", "TextField"),
        ("TextView", "TextView"),
        ("StaticText", "StaticText"),
        ("Slider", "Slider"),
        ("Switch", "Switch"),
        ("Cell", "Cell"),
        ("ScrollView", "ScrollView"),
        ("Table", "Table"),
        ("CollectionView", "CollectionView"),
        ("Tab", "Tab"),
        ("Link", "Link"),
    ] {
        if raw.contains(needle) {
            return role.to_string();
        }
    }
    raw.to_string()
}

fn role_clickable(role: &str) -> bool {
    matches!(
        role,
        "Button" | "Cell" | "Link" | "Tab" | "Switch" | "Slider"
    )
}

fn role_editable(role: &str) -> bool {
    matches!(role, "TextField" | "SecureTextField" | "TextView")
}

fn role_scrollable(role: &str) -> bool {
    matches!(role, "ScrollView" | "Table" | "CollectionView")
}

/// Connects one advertised RSD service through the tunnel provider. This mirrors
/// `RsdHandshake::connect` without the generic lifetime it imposes on the client type.
async fn connect_service<T: RsdService>(
    handshake: &RsdHandshake,
    provider: &mut IpAddr,
) -> AgentResult<T> {
    let name = T::rsd_service_name().to_string();
    let port = handshake
        .services
        .get(&name)
        .map(|service| service.port)
        .ok_or_else(|| service_err(format!("RSD service {name} is not advertised")))?;
    let stream = provider
        .connect_to_service_port(port)
        .await
        .map_err(service_err)?;
    T::from_stream(stream).await.map_err(service_err)
}

fn service_err(error: impl std::fmt::Display) -> AgentError {
    AgentError::new(FailureCode::ServiceUnavailable, error.to_string())
}

/// Mapping helper kept for the setup helper: an `IdeviceError` becomes a service failure.
pub fn map_idevice_error(error: IdeviceError) -> AgentError {
    service_err(error)
}
