//! The event streams: `GET .../tuner/{tuner}/stream` and `GET .../antenna/stream`.
//!
//! A stream is a subscription. Opening it joins the shared poller for what it
//! watches, and closing the connection leaves it, so a page needs no start and stop
//! messages. The browser's `EventSource` reconnects by itself, and each connection
//! is a fresh subscription.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, RawQuery, State};
use axum::http::{Extensions, HeaderMap, HeaderValue};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt, stream};
use tokio_stream::wrappers::WatchStream;

use crate::error::ApiError;
use crate::hub::{Key, Subscription};
use crate::routes::{ApiResult, Query, client_key, device, tuner};
use crate::state::{AppState, StreamSlot};

/// Idle proxies close a connection that stays quiet; a comment line every so often
/// keeps it open.
const KEEPALIVE: Duration = Duration::from_secs(15);
/// How soon a browser reconnects after the connection drops.
const RETRY: Duration = Duration::from_secs(1);

/// Holds a stream's poller subscription and client slot for as long as the stream
/// is open: until the client disconnects (the response is dropped), or the stream
/// ends because the server is shutting down, whichever comes first.
struct Guarded<S> {
    inner: Pin<Box<S>>,
    guards: Option<(Subscription, StreamSlot)>,
}

impl<S: Stream> Stream for Guarded<S> {
    type Item = S::Item;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let next = self.inner.as_mut().poll_next(cx);
        if matches!(next, Poll::Ready(None)) {
            self.guards = None;
        }
        next
    }
}

pub async fn tuner_stream(
    State(state): State<Arc<AppState>>,
    Path((id, tuner_text)): Path<(String, String)>,
    extensions: Extensions,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let device = device(&id)?.to_owned();
    let tuner = tuner(&tuner_text)?;
    open(
        &state,
        extensions.get::<ConnectInfo<SocketAddr>>(),
        &headers,
        Key::Tuner { device, tuner },
    )
}

pub async fn antenna_stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    extensions: Extensions,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let device = device(&id)?.to_owned();
    // 1 to 8 tuners, as a plain decimal number.
    let tuners = Query::new(query)
        .get("tuners")
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|text| text.parse::<u8>().ok())
        .filter(|count| (1..=8).contains(count))
        .ok_or_else(|| ApiError::bad_request("Invalid tuners"))?;
    open(
        &state,
        extensions.get::<ConnectInfo<SocketAddr>>(),
        &headers,
        Key::Antenna { device, tuners },
    )
}

fn open(
    state: &Arc<AppState>,
    peer: Option<&ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
    key: Key,
) -> ApiResult<Response> {
    let client = client_key(state, peer, headers);
    let slot = state
        .acquire_stream(&client)
        .ok_or_else(|| ApiError::too_many("Too many open streams"))?;
    let subscription = state.hub.subscribe(key);

    // The latest reading right away (a stream that joins a running poller does not
    // wait for the next tick), then each new one.
    let readings = WatchStream::new(subscription.latest.clone())
        .filter_map(std::future::ready)
        .map(|message| {
            Ok::<_, Infallible>(
                Event::default()
                    .event(message.event)
                    .data(message.data.clone()),
            )
        });
    let events =
        stream::once(std::future::ready(Ok(Event::default().retry(RETRY)))).chain(readings);

    // The server shutting down ends the stream, so it does not hold shutdown up.
    let mut shutdown = state.shutdown.subscribe();
    let events = events.take_until(async move {
        let _ = shutdown.wait_for(|stopping| *stopping).await;
    });

    let guarded = Guarded {
        inner: Box::pin(events),
        guards: Some((subscription, slot)),
    };
    let mut response = Sse::new(guarded)
        .keep_alive(KeepAlive::new().interval(KEEPALIVE).text("keepalive"))
        .into_response();
    // nginx would otherwise buffer the stream.
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
