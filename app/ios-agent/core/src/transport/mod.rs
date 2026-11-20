//! The idevice-backed transport (feature `device`).
//!
//! * [`ax`] — the native accessibility client over DTX.
//! * [`native`] — the RSD connection and the [`crate::surface::IosSurface`] implementation.

pub mod ax;
pub mod native;

pub use native::{
    default_loopback_endpoint, map_idevice_error, NativeSurface, DEFAULT_RSD_PORT,
    IOS_LOOPBACK_HOST,
};
