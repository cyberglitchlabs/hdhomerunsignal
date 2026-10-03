//! Pure parsing, validation and data types for HDHomeRun devices.
//!
//! Nothing in this crate does I/O: the parsers take the text that
//! `hdhomerun_config` (or the cloud lookup) printed and return typed values,
//! and the validators decide whether a value may be handed to the tool at all.
//! The serialized shape of [`model`] types is the public JSON the frontend
//! already consumes, so field names and optionality are part of the contract.

pub mod model;
pub mod parse;
pub mod validate;
