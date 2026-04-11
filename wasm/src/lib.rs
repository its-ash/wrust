//! WASM helpers for browser-side file transfer logic.

use blake3::Hasher;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wrust_shared::{DataMessage, FileOffset};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChunkHeader {
    file_id: String,
    chunk_index: u32,
    offset: u64,
    payload_len: u32,
}

#[wasm_bindgen]
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finalize().to_hex().to_string()
}

#[wasm_bindgen]
pub fn select_chunk_size(total_size: u64, receiver_count: u32) -> u32 {
    let base = if total_size > 4 * 1024 * 1024 * 1024 {
        256 * 1024
    } else if total_size > 512 * 1024 * 1024 {
        128 * 1024
    } else {
        64 * 1024
    };

    if receiver_count > 3 {
        (base / 2).max(32 * 1024)
    } else {
        base
    }
}

#[wasm_bindgen]
pub fn encode_metadata_packet(metadata_json: &str) -> Result<Vec<u8>, JsValue> {
    let message: DataMessage = serde_json::from_str(metadata_json)
        .map_err(|err| JsValue::from_str(&format!("invalid metadata json: {err}")))?;

    let bytes = serde_json::to_vec(&message)
        .map_err(|err| JsValue::from_str(&format!("encode metadata failed: {err}")))?;

    let mut packet = Vec::with_capacity(bytes.len() + 1);
    packet.push(1);
    packet.extend(bytes);
    Ok(packet)
}

#[wasm_bindgen]
pub fn encode_chunk_packet(
    file_id: String,
    chunk_index: u32,
    offset: u64,
    payload: &[u8],
) -> Vec<u8> {
    let header = ChunkHeader {
        file_id,
        chunk_index,
        offset,
        payload_len: payload.len() as u32,
    };

    let header_bytes = serde_json::to_vec(&header).unwrap_or_default();
    let mut packet = Vec::with_capacity(1 + 4 + header_bytes.len() + payload.len());
    packet.push(2);
    packet.extend((header_bytes.len() as u32).to_le_bytes());
    packet.extend(header_bytes);
    packet.extend(payload);
    packet
}

#[wasm_bindgen]
pub fn decode_packet(input: &[u8]) -> Result<JsValue, JsValue> {
    if input.is_empty() {
        return Err(JsValue::from_str("empty packet"));
    }

    match input[0] {
        1 => {
            let message: DataMessage = serde_json::from_slice(&input[1..])
                .map_err(|err| JsValue::from_str(&format!("metadata decode failed: {err}")))?;
            serde_wasm_bindgen::to_value(&message)
                .map_err(|err| JsValue::from_str(&format!("to js failed: {err}")))
        }
        2 => {
            if input.len() < 5 {
                return Err(JsValue::from_str("invalid chunk packet"));
            }
            let mut len_bytes = [0u8; 4];
            len_bytes.copy_from_slice(&input[1..5]);
            let header_len = u32::from_le_bytes(len_bytes) as usize;
            let header_end = 5 + header_len;
            if input.len() < header_end {
                return Err(JsValue::from_str("chunk header truncated"));
            }

            let header: ChunkHeader = serde_json::from_slice(&input[5..header_end])
                .map_err(|err| JsValue::from_str(&format!("chunk header decode failed: {err}")))?;
            let payload = input[header_end..].to_vec();

            let message = DataMessage::FileChunk {
                file_id: header.file_id,
                chunk_index: header.chunk_index,
                offset: header.offset,
                payload_len: header.payload_len,
                payload,
            };

            serde_wasm_bindgen::to_value(&message)
                .map_err(|err| JsValue::from_str(&format!("to js failed: {err}")))
        }
        _ => Err(JsValue::from_str("unknown packet type")),
    }
}

#[wasm_bindgen]
pub fn encode_resume_offsets(offsets_json: &str) -> Result<String, JsValue> {
    let offsets: Vec<FileOffset> = serde_json::from_str(offsets_json)
        .map_err(|err| JsValue::from_str(&format!("invalid offsets json: {err}")))?;
    serde_json::to_string(&DataMessage::ResumeRequest { offsets })
        .map_err(|err| JsValue::from_str(&format!("serialize resume request failed: {err}")))
}
