//! Talks to HDHomeRun devices.
//!
//! * [`DeviceBackend`] is the small set of primitives a way of reaching a device
//!   must offer: discover, get, set and scan. [`CliBackend`] implements it by
//!   running `hdhomerun_config`.
//! * [`Hdhr`] builds the typed operations the API needs (tuner status, programs,
//!   device info, tuning) once, on top of any backend, using the `hdhr-core`
//!   parsers, so a new backend only has to provide the primitives.
//! * [`CloudClient`] is SiliconDust's cloud lookup, the fallback when the local
//!   broadcast finds nothing.

mod backend;
mod cli;
mod cloud;
mod error;
mod ops;

pub use backend::DeviceBackend;
pub use cli::{CliBackend, CliConfig};
pub use cloud::{CloudClient, DEFAULT_CLOUD_URL};
pub use error::BackendError;
pub use ops::{Hdhr, RetryPolicy};
