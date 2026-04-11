use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::*;
use wrust_shared::{
    CreateSessionRequest, CreateSessionResponse, JoinSessionRequest, JoinSessionResponse, PeerRole,
    PresenceSession, SessionMetadata, SignalMessage, SESSION_TTL_SECS,
};

const DO_BINDING: &str = "SESSION_DO";
const KV_BINDING: &str = "SESSIONS_KV";
const SESSION_KEY_PREFIX: &str = "session:";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionState {
    metadata: SessionMetadata,
    pin_hash: Option<String>,
    sender_peer_id: Option<String>,
    approved_receivers: HashSet<String>,
    known_receivers: HashSet<String>,
    pending_tokens: HashMap<String, PendingJoin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingJoin {
    peer_id: String,
    network_hint: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CreatePayload {
    metadata: SessionMetadata,
    pin_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JoinPayload {
    pin: Option<String>,
    peer_id: String,
    network_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JoinResult {
    ok: bool,
    token: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApprovalPayload {
    peer_id: String,
    approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableError {
    error: String,
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() == Method::Options {
        return cors_preflight_response();
    }
    let is_ws_request = is_websocket_upgrade(req.headers())?;

    let result = Router::new()
        .post_async("/api/session", create_session)
        .post_async("/api/session/join", join_session)
        .get_async("/api/presence", list_presence)
        .get_async("/ws/:session_id", websocket_proxy)
        .run(req, env)
        .await;

    match result {
        Ok(mut response) => {
            if is_ws_request || response.status_code() == 101 {
                return Ok(response);
            }
            apply_cors_headers(response.headers_mut())?;
            Ok(response)
        }
        Err(error) => {
            let mut response = Response::error(error.to_string(), 500)?;
            apply_cors_headers(response.headers_mut())?;
            Ok(response)
        }
    }
}

#[durable_object]
pub struct SessionRoom {
    state: State,
    env: Env,
}

impl SessionRoom {
    async fn read_state(&self) -> Result<Option<SessionState>> {
        self.state
            .storage()
            .get::<SessionState>("session_state")
            .await
    }

    async fn write_state(&self, value: &SessionState) -> Result<()> {
        self.state.storage().put("session_state", value).await
    }

    fn ws_tags(ws: &WebSocket, state: &State) -> (Option<String>, Option<PeerRole>) {
        let tags = state.get_tags(ws);
        let mut peer_id = None;
        let mut role = None;

        for tag in tags {
            if let Some(value) = tag.strip_prefix("peer:") {
                peer_id = Some(value.to_string());
            }
            if let Some(value) = tag.strip_prefix("role:") {
                role = match value {
                    "sender" => Some(PeerRole::Sender),
                    "receiver" => Some(PeerRole::Receiver),
                    _ => None,
                };
            }
        }

        (peer_id, role)
    }

    fn send_json(ws: &WebSocket, payload: &SignalMessage) -> Result<()> {
        ws.send(payload)
    }

    fn send_to_peer(&self, peer_id: &str, payload: &SignalMessage) -> Result<bool> {
        let sockets = self.state.get_websockets();
        for ws in sockets {
            let (tagged_peer_id, _) = Self::ws_tags(&ws, &self.state);
            if tagged_peer_id.as_deref() == Some(peer_id) {
                Self::send_json(&ws, payload)?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn remove_presence(&self, session_id: &str) {
        if let Ok(kv) = self.env.kv(KV_BINDING) {
            let _ = kv
                .delete(&format!("{SESSION_KEY_PREFIX}{session_id}"))
                .await;
        }
    }
}

impl DurableObject for SessionRoom {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let path = url.path();

        if path == "/internal/create" {
            let payload: CreatePayload = req.json().await?;
            let mut session = SessionState {
                metadata: payload.metadata,
                pin_hash: payload.pin_hash,
                sender_peer_id: None,
                approved_receivers: HashSet::new(),
                known_receivers: HashSet::new(),
                pending_tokens: HashMap::new(),
            };
            session.metadata.expires_at = now_secs() + SESSION_TTL_SECS;
            self.write_state(&session).await?;
            self.state
                .storage()
                .set_alarm((session.metadata.expires_at * 1000) as i64)
                .await?;

            return json_response(&session.metadata, 200);
        }

        if path == "/internal/join" {
            let payload: JoinPayload = req.json().await?;
            let mut session = match self.read_state().await? {
                Some(v) => v,
                None => {
                    return json_response(
                        &JoinResult {
                            ok: false,
                            token: None,
                            message: Some("session not found".to_string()),
                        },
                        404,
                    );
                }
            };

            if session.metadata.expires_at <= now_secs() {
                return json_response(
                    &JoinResult {
                        ok: false,
                        token: None,
                        message: Some("session expired".to_string()),
                    },
                    410,
                );
            }

            if let Some(hash) = &session.pin_hash {
                let supplied = payload.pin.unwrap_or_default();
                if hash_pin(&supplied) != *hash {
                    return json_response(
                        &JoinResult {
                            ok: false,
                            token: None,
                            message: Some("invalid pin".to_string()),
                        },
                        403,
                    );
                }
            }

            let token = random_token();
            session.pending_tokens.insert(
                token.clone(),
                PendingJoin {
                    peer_id: payload.peer_id,
                    network_hint: payload.network_hint,
                    created_at: now_secs(),
                },
            );
            self.write_state(&session).await?;

            return json_response(
                &JoinResult {
                    ok: true,
                    token: Some(token),
                    message: None,
                },
                200,
            );
        }

        if path == "/internal/approve" {
            let payload: ApprovalPayload = req.json().await?;
            let mut session = match self.read_state().await? {
                Some(v) => v,
                None => {
                    return json_response(
                        &DurableError {
                            error: "session not found".to_string(),
                        },
                        404,
                    );
                }
            };

            if payload.approved {
                session.approved_receivers.insert(payload.peer_id.clone());
            } else {
                session.approved_receivers.remove(&payload.peer_id);
            }

            self.write_state(&session).await?;
            return Response::ok("ok");
        }

        if path == "/ws" {
            let role = url
                .query_pairs()
                .find(|(k, _)| k == "role")
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(|| "receiver".to_string());
            let peer_id = url
                .query_pairs()
                .find(|(k, _)| k == "peer_id")
                .map(|(_, v)| v.to_string())
                .unwrap_or_else(random_token);

            let token = url
                .query_pairs()
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.to_string());

            let mut session = match self.read_state().await? {
                Some(v) => v,
                None => return Response::error("session not found", 404),
            };

            if session.metadata.expires_at <= now_secs() {
                return Response::error("session expired", 410);
            }

            let pair = WebSocketPair::new()?;
            let ws = pair.server;

            if role == "sender" {
                session.sender_peer_id = Some(peer_id.clone());
            } else {
                let token_value = token.unwrap_or_default();
                let pending = session.pending_tokens.remove(&token_value);
                if pending.is_none() {
                    return Response::error("invalid join token", 403);
                }
                session.known_receivers.insert(peer_id.clone());
            }

            self.write_state(&session).await?;

            let role_tag = format!("role:{role}");
            let peer_tag = format!("peer:{peer_id}");
            self.state
                .accept_websocket_with_tags(&ws, &[role_tag.as_str(), peer_tag.as_str()]);

            let hello = SignalMessage::Hello {
                role: if role == "sender" {
                    PeerRole::Sender
                } else {
                    PeerRole::Receiver
                },
                peer_id: peer_id.clone(),
                session_id: self.state.id().to_string(),
            };
            Self::send_json(&ws, &hello)?;

            if role == "sender" {
                Self::send_json(
                    &ws,
                    &SignalMessage::SenderOnline {
                        metadata: session.metadata.clone(),
                    },
                )?;

                // If sender reconnects, replay pending receiver presence so approval flow can resume.
                for receiver_id in session.known_receivers.iter() {
                    let _ = Self::send_json(
                        &ws,
                        &SignalMessage::ApprovalRequest {
                            peer_id: receiver_id.clone(),
                            device_label: receiver_id.clone(),
                        },
                    );
                    let _ = Self::send_json(
                        &ws,
                        &SignalMessage::PeerJoined {
                            peer_id: receiver_id.clone(),
                            network_hint: None,
                        },
                    );
                }
            } else if let Some(sender_id) = session.sender_peer_id.clone() {
                let _ = self.send_to_peer(
                    &sender_id,
                    &SignalMessage::ApprovalRequest {
                        peer_id: peer_id.clone(),
                        device_label: peer_id.clone(),
                    },
                );
                let _ = self.send_to_peer(
                    &sender_id,
                    &SignalMessage::PeerJoined {
                        peer_id: peer_id.clone(),
                        network_hint: None,
                    },
                );
            }

            return Response::from_websocket(pair.client);
        }

        Response::error("unknown route", 404)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let incoming = match message {
            WebSocketIncomingMessage::String(text) => text,
            WebSocketIncomingMessage::Binary(_) => return Ok(()),
        };

        let parsed = serde_json::from_str::<SignalMessage>(&incoming);
        let signal = match parsed {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };

        let (from_peer_id, from_role) = Self::ws_tags(&ws, &self.state);
        let from_peer_id = match from_peer_id {
            Some(v) => v,
            None => return Ok(()),
        };

        let mut session = match self.read_state().await? {
            Some(v) => v,
            None => return Ok(()),
        };

        match signal {
            SignalMessage::Offer {
                from_peer_id: _,
                to_peer_id,
                sdp,
            } => {
                if from_role == Some(PeerRole::Receiver)
                    && !session.approved_receivers.contains(&from_peer_id)
                {
                    let _ = Self::send_json(
                        &ws,
                        &SignalMessage::Error {
                            code: "approval_required".to_string(),
                            message: "sender approval is required".to_string(),
                        },
                    );
                    return Ok(());
                }
                let _ = self.send_to_peer(
                    &to_peer_id,
                    &SignalMessage::Offer {
                        from_peer_id,
                        to_peer_id: to_peer_id.clone(),
                        sdp,
                    },
                );
            }
            SignalMessage::Answer {
                from_peer_id: _,
                to_peer_id,
                sdp,
            } => {
                let _ = self.send_to_peer(
                    &to_peer_id,
                    &SignalMessage::Answer {
                        from_peer_id,
                        to_peer_id: to_peer_id.clone(),
                        sdp,
                    },
                );
            }
            SignalMessage::IceCandidate {
                from_peer_id: _,
                to_peer_id,
                candidate,
                sdp_mid,
                sdp_mline_index,
            } => {
                let _ = self.send_to_peer(
                    &to_peer_id,
                    &SignalMessage::IceCandidate {
                        from_peer_id,
                        to_peer_id: to_peer_id.clone(),
                        candidate,
                        sdp_mid,
                        sdp_mline_index,
                    },
                );
            }
            SignalMessage::ApprovalResponse {
                peer_id,
                approved,
                reason,
            } => {
                if approved {
                    session.approved_receivers.insert(peer_id.clone());
                } else {
                    session.approved_receivers.remove(&peer_id);
                }
                self.write_state(&session).await?;
                let _ = self.send_to_peer(
                    &peer_id,
                    &SignalMessage::ApprovalResponse {
                        peer_id: peer_id.clone(),
                        approved,
                        reason,
                    },
                );
            }
            SignalMessage::ResumeState {
                peer_id,
                file_offsets,
            } => {
                let _ = self.send_to_peer(
                    &peer_id,
                    &SignalMessage::ResumeState {
                        peer_id: from_peer_id,
                        file_offsets,
                    },
                );
            }
            SignalMessage::TransferIntent {
                to_peer_id,
                tree,
                total_size,
            } => {
                let _ = self.send_to_peer(
                    &to_peer_id,
                    &SignalMessage::TransferIntent {
                        to_peer_id: to_peer_id.clone(),
                        tree,
                        total_size,
                    },
                );
            }
            SignalMessage::KeepAlive => {
                Self::send_json(&ws, &SignalMessage::KeepAlive)?;
            }
            SignalMessage::Hello { .. }
            | SignalMessage::SenderOnline { .. }
            | SignalMessage::PeerJoined { .. }
            | SignalMessage::PeerLeft { .. }
            | SignalMessage::ApprovalRequest { .. }
            | SignalMessage::Error { .. } => {}
        }

        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        let (peer_id, role) = Self::ws_tags(&ws, &self.state);
        let peer_id = match peer_id {
            Some(v) => v,
            None => return Ok(()),
        };

        let mut session = match self.read_state().await? {
            Some(v) => v,
            None => return Ok(()),
        };

        match role {
            Some(PeerRole::Sender) => {
                session.sender_peer_id = None;
            }
            Some(PeerRole::Receiver) => {
                session.approved_receivers.remove(&peer_id);
                session.known_receivers.remove(&peer_id);
                if let Some(sender_id) = session.sender_peer_id.clone() {
                    let _ = self.send_to_peer(
                        &sender_id,
                        &SignalMessage::PeerLeft {
                            peer_id: peer_id.clone(),
                        },
                    );
                }
            }
            None => {}
        }

        // Keep session state until TTL expiry to allow reconnects and late joins.
        // Transient websocket disconnects should not invalidate the session code.
        self.write_state(&session).await?;

        Ok(())
    }

    async fn alarm(&self) -> Result<Response> {
        for socket in self.state.get_websockets() {
            let _ = socket.close(Some(1000), Some("session expired"));
        }
        self.state.storage().delete_all().await?;
        self.remove_presence(&self.state.id().to_string()).await;
        Response::ok("expired")
    }
}

async fn create_session(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: CreateSessionRequest = req.json().await?;
    let session_id = random_code();

    let metadata = SessionMetadata {
        name: body.name,
        file_count: body.file_count,
        total_size: body.total_size,
        has_pin: body.has_pin,
        public_presence: body.public_presence,
        created_at: now_secs(),
        expires_at: now_secs() + SESSION_TTL_SECS,
        network_hint: body.network_hint,
    };

    let pin_hash = req
        .headers()
        .get("x-session-pin")?
        .map(|pin| hash_pin(&pin));

    let namespace = ctx.durable_object(DO_BINDING)?;
    let stub = namespace.id_from_name(&session_id)?.get_stub()?;

    let headers = Headers::new();
    headers.set("content-type", "application/json")?;

    let mut init = RequestInit::new();
    init.with_headers(headers);
    init.with_method(Method::Post);
    init.with_body(Some(serde_json::to_string(&CreatePayload {
        metadata: metadata.clone(),
        pin_hash,
    })?
    .into()));

    let create_req = Request::new_with_init("https://session/internal/create", &init)?;
    let mut do_response = match stub.fetch_with_request(create_req).await {
        Ok(response) => response,
        Err(error) => {
            return Response::error(format!("durable object create failed: {error}"), 500);
        }
    };

    if do_response.status_code() >= 400 {
        let status = do_response.status_code();
        let message = do_response
            .text()
            .await
            .unwrap_or_else(|_| "unknown durable object error".to_string());
        return Response::error(
            format!("durable object create endpoint failed ({status}): {message}"),
            500,
        );
    }

    if metadata.public_presence {
        if let Ok(kv) = ctx.kv(KV_BINDING) {
            let entry = PresenceSession {
                session_id: session_id.clone(),
                name: metadata.name.clone(),
                file_count: metadata.file_count,
                total_size: metadata.total_size,
                expires_at: metadata.expires_at,
                network_hint: metadata.network_hint.clone(),
            };
            let _ = kv
                .put(&format!("{SESSION_KEY_PREFIX}{session_id}"), &entry)?
                .expiration_ttl(SESSION_TTL_SECS)
                .execute()
                .await;
        }
    }

    let host = req.url()?.host_str().unwrap_or_default().to_string();
    let ws_url = format!("wss://{host}/ws/{session_id}");

    json_response(
        &CreateSessionResponse {
            session_id,
            expires_in: SESSION_TTL_SECS,
            ws_url,
        },
        200,
    )
}

async fn join_session(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: JoinSessionRequest = req.json().await?;
    let session_id = body.session_id.to_uppercase();

    let namespace = ctx.durable_object(DO_BINDING)?;
    let stub = namespace.id_from_name(&session_id)?.get_stub()?;

    let peer_id = format!("peer-{}", random_token());

    let headers = Headers::new();
    headers.set("content-type", "application/json")?;

    let mut init = RequestInit::new();
    init.with_headers(headers);
    init.with_method(Method::Post);
    init.with_body(Some(serde_json::to_string(&JoinPayload {
        pin: body.pin,
        peer_id: peer_id.clone(),
        network_hint: body.network_hint,
    })?
    .into()));

    let join_req = Request::new_with_init("https://session/internal/join", &init)?;
    let mut response = stub.fetch_with_request(join_req).await?;

    if response.status_code() >= 400 {
        let status = response.status_code();
        let body_text = response.text().await?;
        let parsed = serde_json::from_str::<JoinResult>(&body_text).ok();
        let message = parsed
            .and_then(|value| value.message)
            .or_else(|| Some(body_text));

        return json_response(
            &JoinSessionResponse {
                ok: false,
                ws_url: String::new(),
                requires_sender_approval: true,
                message,
            },
            status,
        );
    }

    let result: JoinResult = response.json().await?;
    if !result.ok {
        return json_response(
            &JoinSessionResponse {
                ok: false,
                ws_url: String::new(),
                requires_sender_approval: true,
                message: result.message,
            },
            403,
        );
    }

    let host = req.url()?.host_str().unwrap_or_default().to_string();
    let ws_url = format!(
        "wss://{host}/ws/{session_id}?role=receiver&peer_id={}&token={}",
        encode_uri_component(&peer_id),
        encode_uri_component(result.token.as_deref().unwrap_or_default())
    );

    json_response(
        &JoinSessionResponse {
            ok: true,
            ws_url,
            requires_sender_approval: true,
            message: Some("awaiting sender approval".to_string()),
        },
        200,
    )
}

async fn list_presence(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let url = req.url()?;
    let network_hint = url
        .query_pairs()
        .find(|(k, _)| k == "network_hint")
        .map(|(_, v)| v.to_string());

    let kv = match ctx.kv(KV_BINDING) {
        Ok(v) => v,
        Err(_) => return json_response(&Vec::<PresenceSession>::new(), 200),
    };

    let list = kv
        .list()
        .prefix(SESSION_KEY_PREFIX.to_string())
        .limit(100)
        .execute()
        .await?;

    let mut out = Vec::new();
    for key in list.keys {
        let maybe_item = kv.get(&key.name).json::<PresenceSession>().await?;
        if let Some(item) = maybe_item {
            if item.expires_at <= now_secs() {
                continue;
            }
            if let Some(hint) = &network_hint {
                if let Some(item_hint) = &item.network_hint {
                    if item_hint != hint {
                        continue;
                    }
                }
            }
            out.push(item);
        }
    }

    json_response(&out, 200)
}

async fn websocket_proxy(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let session_id = match ctx.param("session_id") {
        Some(v) => v.to_string().to_uppercase(),
        None => return Response::error("missing session id", 400),
    };

    let namespace = ctx.durable_object(DO_BINDING)?;
    let location_hint = req
        .headers()
        .get("cf-ipcountry")?
        .unwrap_or_else(|| "wnam".to_string())
        .to_lowercase();

    let stub = namespace
        .id_from_name(&session_id)?
        .get_stub_with_location_hint(&location_hint)?;

    let url = req.url()?;
    let query = url.query().unwrap_or_default();
    let do_url = if query.is_empty() {
        "https://session/ws".to_string()
    } else {
        format!("https://session/ws?{query}")
    };

    let mut proxied = Request::new(&do_url, Method::Get)?;
    let source_headers = req.headers();
    let proxied_headers = proxied.headers_mut()?;

    for key in [
        "Connection",
        "Upgrade",
        "Sec-WebSocket-Key",
        "Sec-WebSocket-Version",
        "Sec-WebSocket-Protocol",
        "Sec-WebSocket-Extensions",
        "Origin",
    ] {
        if let Some(value) = source_headers.get(key)? {
            proxied_headers.set(key, &value)?;
        }
    }

    let response = stub.fetch_with_request(proxied).await?;
    Ok(response)
}

fn json_response<T: Serialize>(value: &T, status: u16) -> Result<Response> {
    let mut response = ResponseBuilder::new()
        .with_status(status)
        .from_json(value)?;
    apply_cors_headers(response.headers_mut())?;
    Ok(response)
}

fn cors_preflight_response() -> Result<Response> {
    let mut response = Response::empty()?;
    response.headers_mut().set("Allow", "GET,POST,OPTIONS")?;
    apply_cors_headers(response.headers_mut())?;
    Ok(response)
}

fn apply_cors_headers(headers: &Headers) -> Result<()> {
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type,X-Session-Pin")?;
    headers.set("Access-Control-Max-Age", "86400")?;
    Ok(())
}

fn is_websocket_upgrade(headers: &Headers) -> Result<bool> {
    let upgrade = headers
        .get("Upgrade")?
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(upgrade == "websocket")
}

fn random_code() -> String {
    let chars = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut out = String::with_capacity(4);
    for _ in 0..4 {
        let idx = (js_sys::Math::random() * chars.len() as f64) as usize;
        let index = idx.min(chars.len().saturating_sub(1));
        out.push(chars[index] as char);
    }
    out
}

fn random_token() -> String {
    let mut out = String::with_capacity(16);
    let chars = b"abcdefghijklmnopqrstuvwxyz0123456789";
    for _ in 0..16 {
        let idx = (js_sys::Math::random() * chars.len() as f64) as usize;
        let index = idx.min(chars.len().saturating_sub(1));
        out.push(chars[index] as char);
    }
    out
}

fn now_secs() -> u64 {
    (js_sys::Date::now() / 1000.0) as u64
}

fn hash_pin(pin: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(pin.as_bytes());
    hex::encode(digest.finalize())
}

fn encode_uri_component(input: &str) -> String {
    js_sys::encode_uri_component(input)
        .as_string()
        .unwrap_or_else(|| input.to_string())
}
