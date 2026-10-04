//! The HDHomeRun Signal HTTP server: the REST API under `/api/v1` and the
//! built frontend, on top of `hdhr-client`.

pub mod app;
pub mod config;
mod discovery;
mod error;
pub mod hub;
pub mod limits;
pub mod openapi;
mod origin;
mod routes;
pub mod schema;
pub mod state;
mod stream;
