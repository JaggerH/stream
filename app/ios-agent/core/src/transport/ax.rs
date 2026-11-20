//! The native accessibility client (iOS 27+ path).
//!
//! It speaks the AX inspector service (`com.apple.accessibility.axAuditDaemon.remoteserver`)
//! through the same DTX transport `idevice` uses for developer services. The service name and
//! the capability notification are from go-ios (`ios/accessibility`, MIT). No code is copied;
//! the wire call is reimplemented.
//!
//! **Clean-room status of the snapshot.** The focus-event payload keys and the focus iteration
//! strategy are pending clean-room discovery. An earlier draft took them from a GPL-3.0 project;
//! that content has been removed (code, test and extracted keys), and [`RemoteAxClient::snapshot`]
//! now returns a structured `service-unavailable` instead of guessing a shape. The element model
//! below ([`AxElement`]) is a neutral placeholder; nothing fills it until a permissively licensed
//! source or on-device evidence establishes the keys.

use idevice::services::dvt::message::AuxValue;
use idevice::services::dvt::remote_server::{Channel, RemoteServerClient};
use idevice::{IdeviceError, ReadWrite, RsdService};
use plist::{Dictionary, Value};

use crate::ax::Rect;

pub const SERVICE_NAME: &str = "com.apple.accessibility.axAuditDaemon.remoteserver";

/// The reason the native snapshot fails until the focus payload shape is discovered cleanly.
pub const CLEAN_ROOM_SNAPSHOT_REASON: &str = "focus payload keys pending clean-room discovery";

/// One focusable element. The fields are the neutral model the dispatcher consumes; the
/// transport that fills them is pending clean-room discovery (see the module note).
#[derive(Debug, Clone, PartialEq)]
pub struct AxElement {
    /// The platform element identity; the clean-room follow-up will pass it back to attribute
    /// and action calls.
    pub bytes: Vec<u8>,
    pub role: String,
    pub label: String,
    pub identifier: String,
    pub rect: Rect,
}

pub struct RemoteAxClient {
    client: RemoteServerClient<Box<dyn ReadWrite + 'static>>,
    api_version: u64,
}

impl RsdService for RemoteAxClient {
    fn rsd_service_name() -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed(SERVICE_NAME)
    }

    async fn from_stream(stream: Box<dyn ReadWrite>) -> Result<Self, IdeviceError> {
        Ok(Self {
            client: RemoteServerClient::new(stream),
            api_version: 0,
        })
    }
}

impl RemoteAxClient {
    pub fn api_version(&self) -> u64 {
        self.api_version
    }

    /// Wire up capabilities and record the AX API version.
    pub async fn init(&mut self) -> Result<(), IdeviceError> {
        let mut ch = self.client.root_channel();
        let caps = dict(vec![
            ("com.apple.private.DTXBlockCompression", Value::from(2u64)),
            ("com.apple.private.DTXConnection", Value::from(1u64)),
        ]);
        call_async(
            &mut ch,
            "_notifyOfPublishedCapabilities:",
            vec![archive(caps)],
        )
        .await?;
        if let Some(data) = call_reply(&mut ch, "deviceApiVersion", vec![]).await? {
            self.api_version = first_number(&data).unwrap_or(0);
        }
        call_async(
            &mut ch,
            "deviceSetAppMonitoringEnabled:",
            vec![archive(Value::Boolean(false))],
        )
        .await?;
        Ok(())
    }

    /// The native snapshot is **not implemented** pending clean-room discovery of the focus
    /// event payload keys and iteration strategy. It answers a structured failure with the
    /// reason instead of parsing a guessed shape. `find`, `windows` and every gated op that
    /// rebuilds a snapshot on the native path receive this failure.
    pub async fn snapshot(&mut self, _max_nodes: usize) -> Result<Vec<AxElement>, IdeviceError> {
        Err(snapshot_placeholder_error())
    }
}

async fn call_reply(
    ch: &mut Channel<'_, Box<dyn ReadWrite + 'static>>,
    selector: &str,
    args: Vec<AuxValue>,
) -> Result<Option<Value>, IdeviceError> {
    ch.call_method(Some(Value::String(selector.to_string())), Some(args), true)
        .await?;
    let message = ch.read_message().await?;
    Ok(message.data)
}

fn snapshot_placeholder_error() -> IdeviceError {
    IdeviceError::UnexpectedResponse(CLEAN_ROOM_SNAPSHOT_REASON.into())
}

async fn call_async(
    ch: &mut Channel<'_, Box<dyn ReadWrite + 'static>>,
    selector: &str,
    args: Vec<AuxValue>,
) -> Result<(), IdeviceError> {
    ch.call_method(Some(Value::String(selector.to_string())), Some(args), false)
        .await
}

fn archive(value: Value) -> AuxValue {
    AuxValue::archived_value(value)
}

fn dict(entries: Vec<(&str, Value)>) -> Value {
    let mut d = Dictionary::new();
    for (key, value) in entries {
        d.insert(key.to_string(), value);
    }
    Value::Dictionary(d)
}

fn first_number(value: &Value) -> Option<u64> {
    match value {
        Value::Integer(i) => i.as_unsigned(),
        Value::Array(items) => items.iter().find_map(first_number),
        Value::Dictionary(d) => d.values().find_map(first_number),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snapshot_placeholder_names_the_reason() {
        // The payload keys were removed with the GPL-derived content. The placeholder must
        // name the reason; it must not return an empty or guessed snapshot.
        let error = snapshot_placeholder_error();
        assert!(error.to_string().contains(CLEAN_ROOM_SNAPSHOT_REASON));
    }
}
