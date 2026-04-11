//! Shared protocol definitions for wrust.

use serde::{Deserialize, Serialize};

pub const SESSION_TTL_SECS: u64 = 600;
pub const DEFAULT_CHUNK_SIZE: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    pub r#type: String,
    pub name: String,
    pub file_count: u64,
    pub total_size: u64,
    pub has_pin: bool,
    pub public_presence: bool,
    pub network_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub expires_in: u64,
    pub ws_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinSessionRequest {
    pub r#type: String,
    pub session_id: String,
    pub pin: Option<String>,
    pub network_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinSessionResponse {
    pub ok: bool,
    pub ws_url: String,
    pub requires_sender_approval: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetadata {
    pub name: String,
    pub file_count: u64,
    pub total_size: u64,
    pub has_pin: bool,
    pub public_presence: bool,
    pub created_at: u64,
    pub expires_at: u64,
    pub network_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceSession {
    pub session_id: String,
    pub name: String,
    pub file_count: u64,
    pub total_size: u64,
    pub expires_at: u64,
    pub network_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalMessage {
    Hello {
        role: PeerRole,
        peer_id: String,
        session_id: String,
    },
    SenderOnline {
        metadata: SessionMetadata,
    },
    PeerJoined {
        peer_id: String,
        network_hint: Option<String>,
    },
    PeerLeft {
        peer_id: String,
    },
    Offer {
        from_peer_id: String,
        to_peer_id: String,
        sdp: String,
    },
    Answer {
        from_peer_id: String,
        to_peer_id: String,
        sdp: String,
    },
    IceCandidate {
        from_peer_id: String,
        to_peer_id: String,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    },
    TransferIntent {
        to_peer_id: String,
        tree: Vec<FileNode>,
        total_size: u64,
    },
    ApprovalRequest {
        peer_id: String,
        device_label: String,
    },
    ApprovalResponse {
        peer_id: String,
        approved: bool,
        reason: Option<String>,
    },
    ResumeState {
        peer_id: String,
        file_offsets: Vec<FileOffset>,
    },
    Error {
        code: String,
        message: String,
    },
    KeepAlive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeerRole {
    Sender,
    Receiver,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime: String,
    pub size: u64,
    pub hash: Option<String>,
    pub children: Vec<FileNode>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOffset {
    pub file_id: String,
    pub chunk_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DataMessage {
    FileMetadata {
        id: String,
        name: String,
        size: u64,
        mime: String,
        path: String,
        chunk_size: u32,
        total_chunks: u32,
        hash: Option<String>,
    },
    FileChunk {
        file_id: String,
        chunk_index: u32,
        offset: u64,
        payload_len: u32,
        payload: Vec<u8>,
    },
    FileDone {
        file_id: String,
    },
    TransferDone,
    Ack {
        file_id: String,
        chunk_index: u32,
    },
    ResumeRequest {
        offsets: Vec<FileOffset>,
    },
}

pub fn flatten_files(tree: &[FileNode]) -> Vec<FileNode> {
    let mut out = Vec::new();
    for node in tree {
        flatten_one(node, &mut out);
    }
    out
}

fn flatten_one(node: &FileNode, out: &mut Vec<FileNode>) {
    if node.is_dir {
        for child in &node.children {
            flatten_one(child, out);
        }
    } else {
        out.push(node.clone());
    }
}
