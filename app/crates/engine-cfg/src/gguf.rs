//! Reads from a GGUF's header (without touching the weights) what is needed to split the model: layers, sizes,
//! cache. So no number of the model is written in two places.

use crate::split::{Layer, LayerKind, ModelShape};
use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Size in bytes of the GGUF scalar types (0 = u8 ... 12 = f64); 0 = not scalar.
const SCALAR_SIZE: [u64; 13] = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
const T_STRING: u32 = 8;
const T_ARRAY: u32 = 9;
/// The integer types (u8, i8, u16, i16, u32, i32, u64, i64).
const INT_TYPES: [u32; 8] = [0, 1, 2, 3, 4, 5, 10, 11];
const DEFAULT_ALIGNMENT: u64 = 32;
/// Strings longer than this (tokenizer tables in JSON) aren't needed and are skipped.
const MAX_STRING: u64 = 1 << 20;
/// Integer vectors longer than this have one value per token, not per layer: they are skipped.
const MAX_VECTOR: u64 = 4096;

#[derive(Debug, Clone)]
pub struct GgufHeader {
    pub arch: String,
    /// Scalar integer metadata (u8..u64, non-negative i8..i64).
    pub ints: HashMap<String, u64>,
    /// String metadata up to 1 MiB: the conversation format (`tokenizer.chat_template`), the name.
    pub strings: HashMap<String, String>,
    /// Metadata that is an integer vector with one value per layer (the KV heads of a mixed model).
    pub vectors: HashMap<String, Vec<u64>>,
    /// (name, bytes) of each tensor.
    pub tensors: Vec<(String, u64)>,
    /// The shape of each tensor (`ne[0]`, `ne[1]`...: for a projection, the input and the output width).
    pub dims: HashMap<String, Vec<u64>>,
}

impl GgufHeader {
    /// Adds the tensors of a later piece of the same split model.
    pub fn add_piece(&mut self, piece: GgufHeader) {
        self.tensors.extend(piece.tensors);
        self.dims.extend(piece.dims);
    }

    /// An integer metadata of the architecture (`block_count` for `<arch>.block_count`).
    fn int_opt(&self, k: &str) -> Option<u64> {
        self.ints.get(&format!("{}.{k}", self.arch)).copied()
    }

    fn int(&self, k: &str) -> Result<u64> {
        self.int_opt(k).with_context(|| format!("{}.{k} is missing from the header", self.arch))
    }

    /// The value of layer `il` of a metadata: from the vector if the model has one, otherwise the scalar.
    fn per_layer(&self, k: &str, il: usize) -> Option<u64> {
        match self.vectors.get(&format!("{}.{k}", self.arch)) {
            Some(v) => v.get(il).copied(),
            None => self.int_opt(k),
        }
    }
}

fn u32_(r: &mut impl Read) -> Result<u32> {
    let mut b = [0; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn u64_(r: &mut impl Read) -> Result<u64> {
    let mut b = [0; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

/// A length or a count read from the header that would need more bytes than the file has: the file is broken (or made
/// to break the reader), and the header is not believed.
fn within(bytes: u64, len: u64, what: &str) -> Result<()> {
    if bytes > len {
        bail!("{what} would take {bytes} bytes in a file of {len}: invalid file");
    }
    Ok(())
}

/// Skips `n` bytes forward.
fn skip<R: Seek>(r: &mut R, n: u64) -> Result<()> {
    r.seek(SeekFrom::Current(i64::try_from(n).context("a skip beyond any file: invalid file")?))?;
    Ok(())
}

fn string(r: &mut impl Read, len: u64) -> Result<String> {
    let n = u64_(r)?;
    if n > 1 << 24 {
        bail!("string of {n} bytes in the header: invalid file");
    }
    within(n, len, "a string")?;
    let mut v = vec![0; n as usize];
    r.read_exact(&mut v)?;
    Ok(String::from_utf8(v)?)
}

/// A metadata string: `None` (and skipped) if it is longer than `MAX_STRING`.
fn short_string<R: Read + Seek>(r: &mut R, len: u64) -> Result<Option<String>> {
    let n = u64_(r)?;
    within(n, len, "a string")?;
    if n > MAX_STRING {
        skip(r, n)?;
        return Ok(None);
    }
    let mut v = vec![0; n as usize];
    r.read_exact(&mut v)?;
    Ok(Some(String::from_utf8_lossy(&v).into_owned()))
}

fn skip_value<R: Read + Seek>(r: &mut R, ty: u32, len: u64) -> Result<()> {
    match ty {
        T_STRING => short_string(r, len).map(|_| ()),
        T_ARRAY => {
            let et = u32_(r)?;
            let n = u64_(r)?;
            skip_vector(r, et, n, len)
        }
        _ => match SCALAR_SIZE.get(ty as usize) {
            Some(&sz) if sz > 0 => skip(r, sz),
            _ => bail!("unknown GGUF metadata type: {ty}"),
        },
    }
}

/// Skips the `n` elements of type `et` of a vector.
fn skip_vector<R: Read + Seek>(r: &mut R, et: u32, n: u64, len: u64) -> Result<()> {
    match SCALAR_SIZE.get(et as usize) {
        Some(&sz) if sz > 0 => {
            let bytes = n.checked_mul(sz).context("a vector larger than any file: invalid file")?;
            within(bytes, len, "a vector")?;
            skip(r, bytes)
        }
        _ => {
            // a string or a vector takes at least the 8 bytes of its length
            within(n.saturating_mul(8), len, "a vector")?;
            (0..n).try_for_each(|_| skip_value(r, et, len))
        }
    }
}

/// A metadata vector: if they are integers in small quantity (one per layer) it is kept, otherwise skipped.
fn read_vector<R: Read + Seek>(r: &mut R, key: String, vectors: &mut HashMap<String, Vec<u64>>, len: u64) -> Result<()> {
    let et = u32_(r)?;
    let n = u64_(r)?;
    if n > MAX_VECTOR || !INT_TYPES.contains(&et) {
        return skip_vector(r, et, n, len);
    }
    let values = (0..n).map(|_| Ok(read_int(r, et)?.unwrap_or(0))).collect::<Result<Vec<u64>>>()?;
    vectors.insert(key, values);
    Ok(())
}

fn read_int<R: Read>(r: &mut R, ty: u32) -> Result<Option<u64>> {
    let mut b = [0u8; 8];
    let sz = SCALAR_SIZE[ty as usize] as usize;
    r.read_exact(&mut b[..sz])?;
    let v = u64::from_le_bytes(b);
    Ok(match ty {
        0 | 2 | 4 | 10 => Some(v),
        1 => (v as i8 >= 0).then_some(v),
        3 => (v as i16 >= 0).then_some(v),
        5 => (v as i32 >= 0).then_some(v),
        11 => (v as i64 >= 0).then_some(v),
        _ => None,
    })
}

pub fn read_header(path: &Path) -> Result<GgufHeader> {
    let file = File::open(path)?;
    let len = file.metadata()?.len();
    parse_header(BufReader::new(file), len)
}

/// The header of a GGUF `len` bytes long, read from `r`. `r` may hold only the start of the file (the rest is weights
/// that aren't needed here): if the header isn't all there the error says so (`ends_too_early`).
pub fn parse_header<R: Read + Seek>(r: R, len: u64) -> Result<GgufHeader> {
    let h = parse_piece(r, len)?;
    anyhow::ensure!(!h.arch.is_empty(), "general.architecture is missing");
    Ok(h)
}

/// The error of a file that doesn't start like a GGUF.
#[derive(Debug)]
struct NotGguf;

impl std::fmt::Display for NotGguf {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("not a GGUF file")
    }
}

impl std::error::Error for NotGguf {}

/// `parse_header`'s error is that the file isn't a GGUF at all (rather than a damaged one).
pub fn not_gguf(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.is::<NotGguf>())
}

/// Like `parse_header`, for any piece of a split model: the pieces after the first have only their tensors, without
/// the architecture (`arch` empty) or the other metadata.
pub fn parse_piece<R: Read + Seek>(mut r: R, len: u64) -> Result<GgufHeader> {
    let mut magic = [0; 4];
    r.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(NotGguf.into());
    }
    let version = u32_(&mut r)?;
    if version < 2 {
        bail!("GGUF version {version} not supported");
    }
    let n_tensors = u64_(&mut r)?;
    let n_kv = u64_(&mut r)?;
    // a tensor takes at least 24 bytes in the table (name length, dimensions, type, offset), a metadata 12
    within(n_tensors.saturating_mul(24), len, "the tensor table")?;
    within(n_kv.saturating_mul(12), len, "the metadata")?;
    let mut ints = HashMap::new();
    let mut strings = HashMap::new();
    let mut vectors = HashMap::new();
    for _ in 0..n_kv {
        let key = string(&mut r, len)?;
        let ty = u32_(&mut r)?;
        match ty {
            T_STRING => {
                if let Some(v) = short_string(&mut r, len)? {
                    strings.insert(key, v);
                }
            }
            T_ARRAY => read_vector(&mut r, key, &mut vectors, len)?,
            // floats, booleans and the types that aren't numbers aren't needed
            6 | 7 | 12 => skip_value(&mut r, ty, len)?,
            _ if (ty as usize) < SCALAR_SIZE.len() && SCALAR_SIZE[ty as usize] > 0 => {
                if let Some(v) = read_int(&mut r, ty)? {
                    ints.insert(key, v);
                }
            }
            _ => skip_value(&mut r, ty, len)?,
        }
    }
    let arch = strings.get("general.architecture").cloned().unwrap_or_default();
    let mut infos = Vec::with_capacity(n_tensors as usize);
    let mut dims = HashMap::new();
    for _ in 0..n_tensors {
        let name = string(&mut r, len)?;
        let n_dims = u32_(&mut r)?;
        // GGML_MAX_DIMS
        if n_dims > 4 {
            bail!("tensor {name} with {n_dims} dimensions: invalid file");
        }
        let shape = (0..n_dims).map(|_| u64_(&mut r)).collect::<Result<Vec<u64>>>()?;
        let _type = u32_(&mut r)?;
        infos.push((name.clone(), u64_(&mut r)?));
        dims.insert(name, shape);
    }
    let align = ints.get("general.alignment").copied().unwrap_or(DEFAULT_ALIGNMENT);
    if !align.is_power_of_two() {
        bail!("alignment {align}: invalid file");
    }
    let data_start = r.stream_position()?.div_ceil(align) * align;
    // A tensor's size is the distance from the next one (the table only gives the offset).
    infos.sort_by_key(|t| t.1);
    let mut tensors = Vec::with_capacity(infos.len());
    for (i, (name, off)) in infos.iter().enumerate() {
        let end = infos.get(i + 1).map_or(len.saturating_sub(data_start), |n| n.1);
        if end < *off {
            bail!("tensor {name} beyond the end of the file: truncated GGUF?");
        }
        tensors.push((name.clone(), end - off));
    }
    Ok(GgufHeader { arch, ints, strings, vectors, tensors, dims })
}

/// `parse_header`'s error is that the bytes read end before the header does: with more bytes it may succeed.
pub fn ends_too_early(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::UnexpectedEof))
}

/// Bytes per block and elements per block of a K/V cache type (`-ctk`, `-ctv`).
pub(crate) fn cache_type(name: &str) -> Result<(u64, u64)> {
    Ok(match name {
        "f32" => (4, 1),
        "f16" | "bf16" => (2, 1),
        "q8_0" => (34, 32),
        "q5_1" => (24, 32),
        "q5_0" => (22, 32),
        "q4_1" => (20, 32),
        "q4_0" | "iq4_nl" => (18, 32),
        _ => bail!("cache type {name:?} not recognized"),
    })
}

/// Which of the first `n` layers are recurrent (DeltaNet, Mamba): they have `ssm_*` tensors.
fn recurrent_layers(h: &GgufHeader, n: usize) -> Vec<bool> {
    let mut v = vec![false; n];
    for (name, _) in &h.tensors {
        let Some((idx, tail)) = name.strip_prefix("blk.").and_then(|r| r.split_once('.')) else { continue };
        if let Some(r) = idx.parse::<usize>().ok().and_then(|il| v.get_mut(il)) {
            *r |= tail.starts_with("ssm_");
        }
    }
    v
}

/// Bytes of K+V cache per token of an attention layer, with cache types `ctk` and `ctv`. If the model doesn't say
/// `key_length` and `value_length` they are `embedding_length / head_count`.
/// The products of the cache and state counts saturate: an absurd number in the header makes the model fit nowhere,
/// never small.
fn layer_cache(h: &GgufHeader, il: usize, ctk: &str, ctv: &str) -> Result<u64> {
    let heads = h.per_layer("attention.head_count", il);
    let n_kv = h.per_layer("attention.head_count_kv", il).or(heads).with_context(|| format!("{}.attention.head_count is missing from the header", h.arch))?;
    let length = |k: &str| -> Result<u64> {
        match h.int_opt(k) {
            Some(l) => Ok(l),
            None => {
                let heads = heads.with_context(|| format!("{}.{k} is missing from the header", h.arch))?;
                anyhow::ensure!(heads > 0, "{}.attention.head_count is 0 and {}.{k} is missing", h.arch, h.arch);
                Ok(h.int("embedding_length")? / heads)
            }
        }
    };
    let ((kb, ke), (vb, ve)) = (cache_type(ctk)?, cache_type(ctv)?);
    let keys = n_kv.saturating_mul(length("attention.key_length")?).saturating_mul(kb).div_ceil(ke);
    // A latent-attention model (`key_length_mla`) caches only the keys: the engine rebuilds the values from them
    // (llama.cpp, `llama_kv_cache`: `has_v = !is_mla`).
    if h.int_opt("attention.key_length_mla").is_some() && h.int_opt("attention.value_length_mla").is_some() {
        return Ok(keys);
    }
    Ok(keys.saturating_add(n_kv.saturating_mul(length("attention.value_length")?).saturating_mul(vb).div_ceil(ve)))
}

/// Bytes of state of a recurrent layer, f32. DeltaNet and Mamba: the matrix (state_size x inner_size) plus the
/// convolution window. Kimi Delta Attention (`kda.head_dim`): a square matrix per head plus the convolution windows
/// of Q, K and V (llama.cpp, `llama_hparams::n_embd_s` and `n_embd_r`).
fn layer_state(h: &GgufHeader) -> Result<u64> {
    let window = h.int("ssm.conv_kernel")?.saturating_sub(1);
    if let Some(head) = h.int_opt("kda.head_dim") {
        let heads = h.int("attention.head_count")?;
        let matrices = head.saturating_mul(head).saturating_mul(heads);
        return Ok(matrices.saturating_add(window.saturating_mul(3).saturating_mul(heads).saturating_mul(head)).saturating_mul(4));
    }
    let (ss, inner) = (h.int("ssm.state_size")?, h.int("ssm.inner_size")?);
    // `group_count` exists only in grouped models (DeltaNet, Mamba 2): in the others there are no groups.
    let groups = h.int_opt("ssm.group_count").unwrap_or(0);
    let convolution = window.saturating_mul(inner.saturating_add(groups.saturating_mul(2).saturating_mul(ss)));
    Ok(ss.saturating_mul(inner).saturating_add(convolution).saturating_mul(4))
}

/// The model's shape for the split. `ctk`/`ctv`: cache types as in the engine's arguments (`f16` if not specified).
pub fn read_shape(path: &Path, ctk: &str, ctv: &str) -> Result<ModelShape> {
    let h = read_header(path)?;
    let n_block = h.int("block_count")?;
    anyhow::ensure!(n_block <= MAX_BLOCKS, "{}.block_count is {n_block}: invalid file", h.arch);
    let n_block = n_block as usize;
    let n_mtp = h.int_opt("nextn_predict_layers").unwrap_or(0) as usize;
    let n_layers = n_block.checked_sub(n_mtp).context("more MTP layers than layers")?;

    let size_of = |name: &str| h.tensors.iter().find(|t| t.0 == name).map(|t| t.1);
    let output = size_of("output.weight").context("output.weight is missing (tied embedding not supported)")?
        + size_of("output_norm.weight").unwrap_or(0);

    let mut weight = vec![0u64; n_block];
    for (name, bytes) in &h.tensors {
        let Some(rest) = name.strip_prefix("blk.") else { continue };
        let Some((idx, _)) = rest.split_once('.') else { continue };
        let il: usize = idx.parse().with_context(|| format!("tensor name {name:?}"))?;
        if il < n_block {
            weight[il] += bytes;
        }
    }

    let recurrent = recurrent_layers(&h, n_layers);
    let state = if recurrent.iter().any(|&r| r) { layer_state(&h)? } else { 0 };
    let attention = |il: usize| -> Result<Layer> {
        Ok(Layer { kind: LayerKind::Attention, weight_bytes: weight[il], cache_bytes_per_token: layer_cache(&h, il, ctk, ctv)?, state_bytes: 0 })
    };
    let layers = (0..n_layers)
        .map(|il| if recurrent[il] { Ok(Layer { kind: LayerKind::Recurrent, weight_bytes: weight[il], cache_bytes_per_token: 0, state_bytes: state }) } else { attention(il) })
        .collect::<Result<_>>()?;
    // The MTP layers are full attention (with the same cache), even in a hybrid model.
    let mtp = (n_layers..n_block).map(attention).collect::<Result<_>>()?;
    Ok(ModelShape { layers, mtp, output_bytes: output })
}

/// How much memory a model asks beyond the weights, as the catalog says it (`memory`), and the context it holds.
#[derive(Debug, PartialEq, Eq)]
pub struct GgufMemory {
    /// K+V cache per token at f16, full-attention layers only.
    pub kv_kib_token: u64,
    /// Fixed state of the recurrent layers.
    pub state_mib: u64,
    pub ctx_max: Option<u32>,
    /// The numbers are an estimate, because the header lacks something the count needs (an architecture the count
    /// doesn't know yet, a missing field): what is missing, in technical words. `None` when they are counted.
    pub estimated: Option<String>,
}

/// The width taken when the header doesn't say it: the widest of the common models (Llama 70B).
const WIDEST_EMBEDDING: u64 = 8192;
/// The f32 values of a recurrent layer's state for each unit of the model's width, when the header doesn't say how the
/// state is made: the known kinds stay well below (Mamba ~32, Kimi Delta Attention ~140, Gated DeltaNet ~400).
const STATE_VALUES_PER_WIDTH: u64 = 1024;
/// More layers than any model has: a `block_count` beyond this, or beyond the layers the tensors name, is not believed.
const MAX_BLOCKS: u64 = 4096;
/// The numbers beyond which a header is absurd: they stay this large (the model fits nowhere) without making the
/// plan's arithmetic overflow.
const MAX_KV_KIB_TOKEN: u64 = 1 << 30;
const MAX_STATE_MIB: u64 = 1 << 30;

/// The memory any model asks beyond the weights, from its header. With an f16 cache and no sliding windows: the
/// estimate is on the high side. What the header doesn't let count takes the most a layer can ask (an attention
/// layer: `attention_bound`; a recurrent one: `STATE_VALUES_PER_WIDTH`), and `estimated` says what was missing.
pub fn model_memory(h: &GgufHeader) -> GgufMemory {
    let mut missing: Option<String> = None;
    let mut known = |counted: Result<u64>, bound: &dyn Fn() -> u64| {
        counted.unwrap_or_else(|e| {
            missing.get_or_insert_with(|| format!("{e:#}"));
            bound()
        })
    };
    let width = || h.int_opt("embedding_length").unwrap_or(WIDEST_EMBEDDING);
    // The layers the tensors name; without a believable `block_count`, those are the layers.
    let named = h.tensors.iter().filter_map(|(n, _)| n.strip_prefix("blk.")?.split_once('.')?.0.parse::<u64>().ok()).filter(|&il| il < MAX_BLOCKS).max().map_or(0, |m| m + 1);
    let block_count = h.int("block_count").and_then(|n| {
        anyhow::ensure!(n <= named, "{}.block_count is {n}, beyond the {named} layers the tensors name", h.arch);
        Ok(n)
    });
    let n_block = known(block_count, &|| named) as usize;
    let n_mtp = h.int_opt("nextn_predict_layers").unwrap_or(0);
    let n_layers = known((n_block as u64).checked_sub(n_mtp).context("more MTP layers than layers"), &|| n_block as u64) as usize;
    let recurrent = recurrent_layers(h, n_layers);
    let n_recurrent = recurrent.iter().filter(|&&r| r).count() as u64;
    let mut kv_bytes: u64 = 0;
    for il in (0..n_block).filter(|&il| !recurrent.get(il).copied().unwrap_or(false)) {
        // A vector of KV heads with 0 says that layer has no attention (short convolution).
        if h.per_layer("attention.head_count_kv", il) != Some(0) {
            kv_bytes = kv_bytes.saturating_add(known(layer_cache(h, il, "f16", "f16"), &|| attention_bound(h, il, width())));
        }
    }
    let state = if n_recurrent > 0 { n_recurrent.saturating_mul(known(layer_state(h), &|| width().saturating_mul(STATE_VALUES_PER_WIDTH * 4))) } else { 0 };
    GgufMemory {
        kv_kib_token: kv_bytes.div_ceil(1024).min(MAX_KV_KIB_TOKEN),
        state_mib: state.div_ceil(1 << 20).min(MAX_STATE_MIB),
        ctx_max: h.int_opt("context_length").and_then(|c| u32::try_from(c).ok()),
        estimated: missing,
    }
}

/// The most the f16 K and V cache of attention layer `il` can ask per token when the header doesn't say it: the output
/// widths of its K and V projections (or of the fused QKV one), from the tensors' shapes. Without those, K and V twice
/// as wide as the model each: heads x head size reaches twice the width in some models (Qwen3-0.6B: 16 x 128 on 1024).
fn attention_bound(h: &GgufHeader, il: usize, width: u64) -> u64 {
    let out = |t: &str| h.dims.get(&format!("blk.{il}.{t}")).and_then(|d| d.get(1)).copied();
    let projections = match (out("attn_k.weight"), out("attn_v.weight")) {
        (Some(k), Some(v)) => Some(k.saturating_add(v)),
        _ => out("attn_qkv.weight"),
    };
    projections.unwrap_or_else(|| width.saturating_mul(4)).saturating_mul(2)
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::io::Write;

    fn s(w: &mut Vec<u8>, t: &str) {
        w.extend((t.len() as u64).to_le_bytes());
        w.extend(t.as_bytes());
    }

    /// Writes a minimal GGUF of architecture `qwen35`: integer metadata and tensors with the header only.
    pub fn write(path: &std::path::Path, ints: &[(&str, u32)], tensors: &[(&str, u64)]) {
        write_with(path, "qwen35", ints, &[], &[], tensors);
    }

    /// Writes a minimal GGUF: metadata (integers, strings, integer vectors, a string array to skip) and tensors with
    /// the header only; the file is extended to the end of the data (without writing it). An empty `arch` writes none,
    /// like the pieces after the first of a split model.
    pub fn write_with(path: &std::path::Path, arch: &str, ints: &[(&str, u32)], strings: &[(&str, &str)], vectors: &[(&str, &[u32])], tensors: &[(&str, u64)]) {
        let shaped: Vec<(&str, u64, &[u64])> = tensors.iter().map(|&(n, b)| (n, b, [1u64].as_slice())).collect();
        write_shaped(path, arch, ints, strings, vectors, &shaped);
    }

    /// Like `write_with`, with each tensor's shape.
    pub fn write_shaped(path: &std::path::Path, arch: &str, ints: &[(&str, u32)], strings: &[(&str, &str)], vectors: &[(&str, &[u32])], tensors: &[(&str, u64, &[u64])]) {
        let mut w = Vec::new();
        w.extend(b"GGUF");
        w.extend(3u32.to_le_bytes());
        w.extend((tensors.len() as u64).to_le_bytes());
        w.extend(((ints.len() + strings.len() + vectors.len()) as u64 + 1 + u64::from(!arch.is_empty())).to_le_bytes());
        if !arch.is_empty() {
            s(&mut w, "general.architecture");
            w.extend(8u32.to_le_bytes());
            s(&mut w, arch);
        }
        s(&mut w, "tokenizer.ggml.tokens");
        w.extend(9u32.to_le_bytes());
        w.extend(8u32.to_le_bytes());
        w.extend(3u64.to_le_bytes());
        for t in ["a", "bb", "ccc"] {
            s(&mut w, t);
        }
        for (k, v) in ints {
            s(&mut w, k);
            w.extend(4u32.to_le_bytes());
            w.extend(v.to_le_bytes());
        }
        for (k, v) in strings {
            s(&mut w, k);
            w.extend(8u32.to_le_bytes());
            s(&mut w, v);
        }
        for (k, v) in vectors {
            s(&mut w, k);
            w.extend(9u32.to_le_bytes());
            w.extend(4u32.to_le_bytes());
            w.extend((v.len() as u64).to_le_bytes());
            v.iter().for_each(|x| w.extend(x.to_le_bytes()));
        }
        let mut off = 0u64;
        for (name, bytes, shape) in tensors {
            s(&mut w, name);
            w.extend((shape.len() as u32).to_le_bytes());
            shape.iter().for_each(|d| w.extend(d.to_le_bytes()));
            w.extend(0u32.to_le_bytes());
            w.extend(off.to_le_bytes());
            off += bytes.div_ceil(32) * 32;
        }
        let data_start = (w.len() as u64).div_ceil(32) * 32;
        w.resize(data_start as usize, 0);
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(&w).unwrap();
        // The last tensor ends at `bytes` (without trailing alignment).
        let last = tensors.last().map_or(0, |t| t.1);
        f.set_len(data_start + off - last.div_ceil(32) * 32 + last).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_shape_and_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("m.gguf");
        let ints = [
            ("qwen35.block_count", 5),
            ("qwen35.nextn_predict_layers", 1),
            ("qwen35.attention.head_count_kv", 4),
            ("qwen35.attention.key_length", 256),
            ("qwen35.attention.value_length", 256),
            ("qwen35.ssm.state_size", 128),
            ("qwen35.ssm.inner_size", 6144),
            ("qwen35.ssm.conv_kernel", 4),
            ("qwen35.ssm.group_count", 16),
        ];
        let tensors = [
            ("token_embd.weight", 1000),
            ("blk.0.ssm_out.weight", 300),
            ("blk.0.ffn_up.weight", 700),
            ("blk.1.attn_k.weight", 500),
            ("blk.2.ssm_out.weight", 400),
            ("blk.3.attn_k.weight", 600),
            ("blk.4.nextn.weight", 99),
            ("output.weight", 2000),
            ("output_norm.weight", 40),
        ];
        test_util::write(&p, &ints, &tensors);
        let m = read_shape(&p, "q8_0", "q8_0").unwrap();
        assert_eq!(m.layers.len(), 4, "the MTP layer is separate");
        assert_eq!(m.mtp, [Layer { kind: LayerKind::Attention, weight_bytes: 128, cache_bytes_per_token: 2176, state_bytes: 0 }]);
        let kinds: Vec<_> = m.layers.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, [LayerKind::Recurrent, LayerKind::Attention, LayerKind::Recurrent, LayerKind::Attention]);
        // the sizes are distances between offsets aligned to 32 bytes: 300 -> 320, 700 -> 704, ...
        assert_eq!(m.layers[0].weight_bytes, 320 + 704);
        assert_eq!(m.layers[3].weight_bytes, 608);
        assert_eq!(m.output_bytes, 2016 + 40);
        assert_eq!(m.layers[1].cache_bytes_per_token, 2176);
        assert_eq!(m.layers[0].state_bytes, 3_268_608);
        assert_eq!(read_shape(&p, "f16", "f16").unwrap().layers[1].cache_bytes_per_token, 4096);
    }

    fn dense_gguf(dir: &Path) -> std::path::PathBuf {
        let p = dir.join("dense.gguf");
        // Like Qwen3-4B: no `output.weight` (tied embedding), no `key_length`, 36 layers.
        let ints = [
            ("llama.block_count", 36),
            ("llama.context_length", 40960),
            ("llama.embedding_length", 2560),
            ("llama.attention.head_count", 32),
            ("llama.attention.head_count_kv", 8),
        ];
        let tensors: Vec<(String, u64)> = std::iter::once(("token_embd.weight".to_string(), 1000))
            .chain((0..36).map(|i| (format!("blk.{i}.attn_k.weight"), 500)))
            .collect();
        let t: Vec<(&str, u64)> = tensors.iter().map(|(n, b)| (n.as_str(), *b)).collect();
        test_util::write_with(&p, "llama", &ints, &[("tokenizer.chat_template", "{{ messages }}"), ("general.name", "Test 4B")], &[], &t);
        p
    }

    #[test]
    fn the_memory_of_a_dense_model_without_output_and_without_key_length() {
        let d = tempfile::tempdir().unwrap();
        let h = read_header(&dense_gguf(d.path())).unwrap();
        assert_eq!(h.arch, "llama");
        assert_eq!(h.strings["tokenizer.chat_template"], "{{ messages }}");
        assert_eq!(h.strings["general.name"], "Test 4B");
        let m = model_memory(&h);
        // 8 KV heads x (80 + 80) x 2 bytes = 2560 B per layer and token, x 36 layers = 90 KiB
        assert_eq!(m, GgufMemory { kv_kib_token: 90, state_mib: 0, ctx_max: Some(40960), estimated: None });
    }

    #[test]
    fn the_memory_of_a_hybrid_counts_only_the_attention_layers_and_the_recurrent_ones_state() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("hybrid.gguf");
        let ints = [
            ("qwen35.block_count", 4),
            ("qwen35.attention.head_count_kv", 4),
            ("qwen35.attention.key_length", 256),
            ("qwen35.attention.value_length", 256),
            ("qwen35.ssm.state_size", 128),
            ("qwen35.ssm.inner_size", 6144),
            ("qwen35.ssm.conv_kernel", 4),
            ("qwen35.ssm.group_count", 16),
        ];
        let tensors = [("blk.0.ssm_out.weight", 300), ("blk.1.attn_k.weight", 500), ("blk.2.ssm_out.weight", 400), ("blk.3.attn_k.weight", 600)];
        test_util::write_with(&p, "qwen35", &ints, &[], &[], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        // 2 attention layers: 4 x (256 + 256) x 2 = 4096 B each = 8 KiB; 2 recurrent ones of 3,268,608 B = 6.2 MiB
        assert_eq!((m.kv_kib_token, m.state_mib, m.estimated), (8, 7, None));
    }

    #[test]
    fn a_delta_attention_hybrid_counts_its_square_state_and_only_the_keys_of_the_latent_attention() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("kda.gguf");
        // Like Ling 3.0 Tiny: no `ssm.state_size`, the recurrent layers say `kda.head_dim`; the others are latent attention.
        let ints = [
            ("bailingmoe3.block_count", 4),
            ("bailingmoe3.attention.head_count", 16),
            ("bailingmoe3.attention.key_length", 576),
            ("bailingmoe3.attention.value_length", 128),
            ("bailingmoe3.attention.key_length_mla", 192),
            ("bailingmoe3.attention.value_length_mla", 128),
            ("bailingmoe3.ssm.conv_kernel", 4),
            ("bailingmoe3.kda.head_dim", 128),
        ];
        let tensors = [("blk.0.ssm_a", 100), ("blk.1.ssm_a", 100), ("blk.2.ssm_a", 100), ("blk.3.attn_k_b.weight", 100)];
        test_util::write_with(&p, "bailingmoe3", &ints, &[], &[("bailingmoe3.attention.head_count_kv", &[0, 0, 0, 1])], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        // 1 attention layer: 1 head x 576 x 2 bytes of keys, no values = 1152 B; 3 recurrent ones of
        // (128 x 128 x 16 + 3 x 3 x 16 x 128) x 4 = 1,122,304 B = 3.2 MiB
        assert_eq!((m.kv_kib_token, m.state_mib, m.estimated), (2, 4, None));
    }

    /// A recurrent kind the count doesn't know (here the KDA hybrid without `kda.head_dim`, so its state looks for
    /// `ssm.state_size`): the attention is counted, the state takes the bound of the model's width, and the memory says
    /// it is an estimate and what was missing.
    #[test]
    fn a_recurrent_state_the_count_does_not_know_is_bounded_by_the_width_and_marked_as_estimated() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("new.gguf");
        let ints = [
            ("newarch.block_count", 4),
            ("newarch.embedding_length", 2048),
            ("newarch.attention.head_count", 16),
            ("newarch.attention.key_length", 576),
            ("newarch.attention.value_length", 128),
            ("newarch.attention.key_length_mla", 192),
            ("newarch.attention.value_length_mla", 128),
            ("newarch.ssm.conv_kernel", 4),
        ];
        let tensors = [("blk.0.ssm_a", 100), ("blk.1.ssm_a", 100), ("blk.2.ssm_a", 100), ("blk.3.attn_k_b.weight", 100)];
        test_util::write_with(&p, "newarch", &ints, &[], &[("newarch.attention.head_count_kv", &[0, 0, 0, 1])], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        // the attention as counted (2 KiB); 3 recurrent layers of 2048 x 1024 x 4 B = 8 MiB each
        assert_eq!((m.kv_kib_token, m.state_mib), (2, 24));
        assert!(m.estimated.as_deref().is_some_and(|e| e.contains("newarch.ssm.state_size")), "{m:?}");
    }

    #[test]
    fn per_layer_kv_heads_from_a_vector_exclude_the_layers_without_attention() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("mixed.gguf");
        let ints = [("lfm2.block_count", 4), ("lfm2.embedding_length", 1024), ("lfm2.attention.head_count", 16)];
        let tensors = [("blk.0.shortconv.conv.weight", 100), ("blk.1.attn_k.weight", 100), ("blk.2.shortconv.conv.weight", 100), ("blk.3.attn_k.weight", 100)];
        test_util::write_with(&p, "lfm2", &ints, &[], &[("lfm2.attention.head_count_kv", &[0, 8, 0, 8])], &tensors);
        let h = read_header(&p).unwrap();
        assert_eq!(h.vectors["lfm2.attention.head_count_kv"], [0, 8, 0, 8]);
        // 2 layers x 8 heads x (64 + 64) x 2 bytes = 4 KiB
        assert_eq!(model_memory(&h).kv_kib_token, 4);
    }

    /// Without the numbers of the cache and without the tensors' shapes, each attention layer takes K and V twice as
    /// wide as the model; without the width either, that of the widest common model. The memory says which number was
    /// missing.
    #[test]
    fn without_the_numbers_of_the_cache_each_layer_takes_twice_the_width_and_the_memory_says_which_is_missing() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("odd.gguf");
        let tensors = [("blk.0.attn_k.weight", 10), ("blk.1.attn_k.weight", 10)];
        test_util::write_with(&p, "odd", &[("odd.block_count", 2), ("odd.embedding_length", 1024)], &[], &[], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        // 2 layers x (2048 + 2048) x 2 bytes = 16 KiB
        assert_eq!(m.kv_kib_token, 16);
        assert!(m.estimated.as_deref().is_some_and(|e| e.contains("odd.attention.head_count")), "{m:?}");

        // no width and no number of layers: those the tensors name, twice as wide as the widest model (2 x 16384 x 2 x 2 x 2 B = 128 KiB)
        test_util::write_with(&p, "odd", &[], &[], &[], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        assert_eq!(m.kv_kib_token, 128);
        assert!(m.estimated.as_deref().is_some_and(|e| e.contains("odd.block_count")), "{m:?}");
    }

    /// A multi-head model whose heads x head size is wider than the model (like Qwen3-0.6B: 16 x 128 on 1024) without
    /// its head counts: the bound is never below the true cache, from the shapes of K and V when they are there and
    /// from twice the width when they aren't. With the shapes, a narrower K and V (fewer KV heads) count as narrow.
    #[test]
    fn the_bound_of_an_attention_layer_holds_heads_wider_than_the_model() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("mha.gguf");
        let ints = [("mha.block_count", 2), ("mha.embedding_length", 1024)];
        // the true cache: 16 KV heads x (128 + 128) x 2 bytes = 8 KiB a layer, 16 KiB in all
        let truth = 16;
        let wide: &[u64] = &[1024, 2048];
        let shaped: Vec<(&str, u64, &[u64])> = ["blk.0.attn_k.weight", "blk.0.attn_v.weight", "blk.1.attn_k.weight", "blk.1.attn_v.weight"].map(|n| (n, 10, wide)).to_vec();
        test_util::write_shaped(&p, "mha", &ints, &[], &[], &shaped);
        let with_shapes = model_memory(&read_header(&p).unwrap());
        test_util::write_with(&p, "mha", &ints, &[], &[], &[("blk.0.attn_k.weight", 10), ("blk.1.attn_k.weight", 10)]);
        let without = model_memory(&read_header(&p).unwrap());
        assert!(with_shapes.kv_kib_token >= truth && without.kv_kib_token >= truth, "{with_shapes:?} {without:?}");
        assert_eq!((with_shapes.kv_kib_token, without.kv_kib_token), (16, 16));

        let narrow: &[u64] = &[1024, 512];
        let shaped: Vec<(&str, u64, &[u64])> = ["blk.0.attn_k.weight", "blk.0.attn_v.weight", "blk.1.attn_k.weight", "blk.1.attn_v.weight"].map(|n| (n, 10, narrow)).to_vec();
        test_util::write_shaped(&p, "mha", &ints, &[], &[], &shaped);
        // 2 layers x (512 + 512) x 2 bytes = 4 KiB
        assert_eq!(model_memory(&read_header(&p).unwrap()).kv_kib_token, 4);
    }

    /// A `block_count` beyond the layers the tensors name (or absurd) is not believed: those layers count, and the memory
    /// is an estimate. Zero heads is an error of the count, not a division by zero; numbers so large that the products
    /// overflow make the memory huge, never small.
    #[test]
    fn absurd_numbers_of_the_model_make_an_estimate_or_a_huge_memory_never_a_crash_or_a_small_one() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("absurd.gguf");
        let tensors = [("blk.0.attn_k.weight", 10), ("blk.1.attn_k.weight", 10)];
        let ints = |extra: &[(&'static str, u32)]| -> Vec<(&'static str, u32)> {
            [("x.embedding_length", 1024), ("x.attention.head_count", 8), ("x.attention.head_count_kv", 8), ("x.attention.key_length", 128), ("x.attention.value_length", 128)].iter().chain(extra).copied().collect()
        };
        for count in [3, u32::MAX] {
            test_util::write_with(&p, "x", &ints(&[("x.block_count", count)]), &[], &[], &tensors);
            let m = model_memory(&read_header(&p).unwrap());
            // the 2 named layers: 8 x 256 x 2 bytes = 4 KiB each
            assert_eq!(m.kv_kib_token, 8, "block_count {count}");
            assert!(m.estimated.as_deref().is_some_and(|e| e.contains("x.block_count")), "{m:?}");
        }

        let no_lengths = [("x.block_count", 2), ("x.embedding_length", 1024), ("x.attention.head_count", 0)];
        test_util::write_with(&p, "x", &no_lengths, &[], &[], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        assert!(m.estimated.as_deref().is_some_and(|e| e.contains("is 0")), "{m:?}");

        let huge = [("x.block_count", 2), ("x.attention.head_count_kv", u32::MAX), ("x.attention.key_length", u32::MAX), ("x.attention.value_length", u32::MAX)];
        test_util::write_with(&p, "x", &huge, &[], &[], &tensors);
        let m = model_memory(&read_header(&p).unwrap());
        assert_eq!(m.kv_kib_token, MAX_KV_KIB_TOKEN, "{m:?}");
        // 4 heads x 2^62 x 2 bytes would wrap to 0 keys: they stay huge
        let mut h = read_header(&p).unwrap();
        h.ints.extend([("x.attention.head_count_kv".to_string(), 4), ("x.attention.key_length".to_string(), 1 << 62), ("x.attention.value_length".to_string(), 1)]);
        assert_eq!(model_memory(&h).kv_kib_token, MAX_KV_KIB_TOKEN);
        let recurrent = [("x.block_count", 1), ("x.ssm.conv_kernel", 0), ("x.ssm.state_size", u32::MAX), ("x.ssm.inner_size", u32::MAX)];
        test_util::write_with(&p, "x", &recurrent, &[], &[], &[("blk.0.ssm_a", 10)]);
        assert_eq!(model_memory(&read_header(&p).unwrap()).state_mib, MAX_STATE_MIB);
    }

    /// The start of a GGUF header with `n_tensors` tensors and the metadata `kvs` (key, type, value bytes), then zeros.
    fn raw(n_tensors: u64, kvs: &[(&str, u32, Vec<u8>)]) -> Vec<u8> {
        let mut w = b"GGUF".to_vec();
        w.extend(3u32.to_le_bytes());
        w.extend(n_tensors.to_le_bytes());
        w.extend((kvs.len() as u64).to_le_bytes());
        for (k, ty, v) in kvs {
            w.extend((k.len() as u64).to_le_bytes());
            w.extend(k.as_bytes());
            w.extend(ty.to_le_bytes());
            w.extend(v);
        }
        w.resize(w.len() + 256, 0);
        w
    }

    fn le(parts: &[u64], first: u32) -> Vec<u8> {
        first.to_le_bytes().into_iter().chain(parts.iter().flat_map(|p| p.to_le_bytes())).collect()
    }

    /// A header that counts more than the file holds, or numbers that would overflow, is an invalid file: never a panic,
    /// a huge allocation, a negative skip or an alignment of zero.
    #[test]
    fn an_absurd_header_is_an_invalid_file_not_a_crash() {
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("more tensors than bytes", raw(u64::MAX / 2, &[])),
            ("alignment 0", raw(0, &[("general.alignment", 4, 0u32.to_le_bytes().to_vec())])),
            ("alignment 3", raw(0, &[("general.alignment", 4, 3u32.to_le_bytes().to_vec())])),
            // 2^61 + 1 values of 8 bytes: the product would wrap to 8
            ("a vector whose size overflows", raw(0, &[("v", T_ARRAY, le(&[(1 << 61) + 1], 10))])),
            ("a vector beyond the file", raw(0, &[("v", T_ARRAY, le(&[1 << 40], 0))])),
            ("a vector of strings beyond the file", raw(0, &[("v", T_ARRAY, le(&[1 << 62], T_STRING))])),
            ("a string beyond any file", raw(0, &[("s", T_STRING, (1u64 << 63).to_le_bytes().to_vec())])),
            ("a huge string to skip", raw(0, &[("f", 6, vec![0; 4]), ("s", T_STRING, (1u64 << 40).to_le_bytes().to_vec())])),
        ];
        let mut more_metadata = b"GGUF".to_vec();
        more_metadata.extend(3u32.to_le_bytes());
        more_metadata.extend(0u64.to_le_bytes());
        more_metadata.extend(u64::MAX.to_le_bytes());
        let mut dims = raw(1, &[("general.architecture", T_STRING, [1u64.to_le_bytes().as_slice(), b"x"].concat())]);
        let at = dims.len() - 256;
        dims.splice(at..at, [1u64.to_le_bytes().as_slice(), b"t", 1000u32.to_le_bytes().as_slice()].concat());
        for (what, bytes) in cases.into_iter().chain([("more metadata than bytes", more_metadata), ("1000 dimensions", dims)]) {
            let e = parse_piece(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap_err();
            assert!(format!("{e:#}").contains("invalid file") && !ends_too_early(&e), "{what}: {e:#}");
        }
    }

    /// By hand, on real GGUFs (only read): `MANGO_TEST_GGUFS="<a.gguf>;<b.gguf>" cargo test -p engine-cfg --lib
    /// gguf::tests::the_estimate -- --ignored --nocapture`. Each number of the architecture is taken away in turn: when
    /// the count becomes an estimate, it is never below the true count.
    #[test]
    #[ignore = "reads real GGUFs from the disk: MANGO_TEST_GGUFS says which"]
    fn the_estimate_of_a_real_model_without_one_of_its_numbers_is_never_below_the_count() {
        let files = std::env::var("MANGO_TEST_GGUFS").expect("MANGO_TEST_GGUFS");
        for f in files.split(';').filter(|f| !f.is_empty()) {
            let h = read_header(Path::new(f)).unwrap();
            let truth = model_memory(&h);
            assert!(truth.estimated.is_none(), "{f}: {truth:?}");
            let prefix = format!("{}.", h.arch);
            let keys: Vec<String> = h.ints.keys().chain(h.vectors.keys()).filter(|k| k.starts_with(&prefix)).cloned().collect();
            let mut estimated = 0;
            for k in &keys {
                let mut without = h.clone();
                without.ints.remove(k);
                without.vectors.remove(k);
                let m = model_memory(&without);
                if m.estimated.is_some() {
                    estimated += 1;
                    println!("{f}: without {k}: {} KiB/token (true {}), {} MiB (true {})", m.kv_kib_token, truth.kv_kib_token, m.state_mib, truth.state_mib);
                    assert!(m.kv_kib_token >= truth.kv_kib_token && m.state_mib >= truth.state_mib, "{f} without {k}: {m:?} under {truth:?}");
                }
            }
            println!("{f}: {} numbers, {estimated} make an estimate", keys.len());
            assert!(estimated > 0, "{f}");
        }
    }

    #[test]
    fn a_huge_string_is_skipped_and_a_truncated_file_is_recognized() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.gguf");
        let huge = "x".repeat((MAX_STRING + 10) as usize);
        test_util::write_with(&p, "llama", &[("llama.block_count", 1)], &[("tokenizer.huggingface.json", &huge), ("general.name", "ok")], &[], &[("blk.0.attn_k.weight", 10)]);
        let whole = std::fs::read(&p).unwrap();
        let h = parse_header(std::io::Cursor::new(&whole), whole.len() as u64).unwrap();
        assert!(!h.strings.contains_key("tokenizer.huggingface.json"));
        assert_eq!(h.strings["general.name"], "ok");
        assert_eq!(h.tensors, [("blk.0.attn_k.weight".to_string(), 10)]);

        // a header read only in part: the error says it ends too early
        let e = parse_header(std::io::Cursor::new(&whole[..200]), whole.len() as u64).unwrap_err();
        assert!(ends_too_early(&e), "{e:#}");
        let e = parse_header(std::io::Cursor::new(b"GGUFxxxx".as_slice()), 8).unwrap_err();
        assert!(ends_too_early(&e), "{e:#}");
        let e = parse_header(std::io::Cursor::new(b"nothing to see here, really nothing".as_slice()), 36).unwrap_err();
        assert!(!ends_too_early(&e), "{e:#}");
    }

    #[test]
    fn rejects_a_file_that_is_not_gguf() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.gguf");
        std::fs::write(&p, b"nothing to see here, really nothing").unwrap();
        let e = read_header(&p).unwrap_err();
        assert!(e.to_string().contains("GGUF") && not_gguf(&e), "{e:#}");
        // a GGUF cut short is damaged, not something else
        let e = parse_header(std::io::Cursor::new(b"GGUFxxxx".as_slice()), 8).unwrap_err();
        assert!(!not_gguf(&e), "{e:#}");
    }

    /// The pieces after the first of a split model have only their tensors: they are read anyway, and only
    /// `parse_header`, which wants a whole model, refuses them.
    #[test]
    fn a_later_piece_of_a_split_model_gives_its_tensors() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m-00002-of-00002.gguf");
        test_util::write_with(&p, "", &[("split.no", 1)], &[], &[], &[("blk.7.ssm_a", 64)]);
        let bytes = std::fs::read(&p).unwrap();
        let piece = parse_piece(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap();
        assert_eq!((piece.arch.as_str(), piece.tensors.as_slice()), ("", [("blk.7.ssm_a".to_string(), 64)].as_slice()));
        let e = parse_header(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap_err();
        assert!(e.to_string().contains("general.architecture"), "{e:#}");
    }
}
