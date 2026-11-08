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

#[derive(Debug)]
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
}

impl GgufHeader {
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

fn string(r: &mut impl Read) -> Result<String> {
    let n = u64_(r)?;
    if n > 1 << 24 {
        bail!("string of {n} bytes in the header: invalid file");
    }
    let mut v = vec![0; n as usize];
    r.read_exact(&mut v)?;
    Ok(String::from_utf8(v)?)
}

/// A metadata string: `None` (and skipped) if it is longer than `MAX_STRING`.
fn short_string<R: Read + Seek>(r: &mut R) -> Result<Option<String>> {
    let n = u64_(r)?;
    if n > MAX_STRING {
        r.seek(SeekFrom::Current(n as i64))?;
        return Ok(None);
    }
    let mut v = vec![0; n as usize];
    r.read_exact(&mut v)?;
    Ok(Some(String::from_utf8_lossy(&v).into_owned()))
}

fn skip_value<R: Read + Seek>(r: &mut R, ty: u32) -> Result<()> {
    match ty {
        T_STRING => short_string(r).map(|_| ()),
        T_ARRAY => {
            let et = u32_(r)?;
            let n = u64_(r)?;
            skip_vector(r, et, n)
        }
        _ => match SCALAR_SIZE.get(ty as usize) {
            Some(&sz) if sz > 0 => Ok(r.seek(SeekFrom::Current(sz as i64)).map(|_| ())?),
            _ => bail!("unknown GGUF metadata type: {ty}"),
        },
    }
}

/// Skips the `n` elements of type `et` of a vector.
fn skip_vector<R: Read + Seek>(r: &mut R, et: u32, n: u64) -> Result<()> {
    match SCALAR_SIZE.get(et as usize) {
        Some(&sz) if sz > 0 => {
            r.seek(SeekFrom::Current((n * sz) as i64))?;
        }
        _ => {
            for _ in 0..n {
                skip_value(r, et)?;
            }
        }
    }
    Ok(())
}

/// A metadata vector: if they are integers in small quantity (one per layer) it is kept, otherwise skipped.
fn read_vector<R: Read + Seek>(r: &mut R, key: String, vectors: &mut HashMap<String, Vec<u64>>) -> Result<()> {
    let et = u32_(r)?;
    let n = u64_(r)?;
    if n > MAX_VECTOR || !INT_TYPES.contains(&et) {
        return skip_vector(r, et, n);
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
pub fn parse_header<R: Read + Seek>(mut r: R, len: u64) -> Result<GgufHeader> {
    let mut magic = [0; 4];
    r.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        bail!("not a GGUF file");
    }
    let version = u32_(&mut r)?;
    if version < 2 {
        bail!("GGUF version {version} not supported");
    }
    let n_tensors = u64_(&mut r)?;
    let n_kv = u64_(&mut r)?;
    let mut ints = HashMap::new();
    let mut strings = HashMap::new();
    let mut vectors = HashMap::new();
    for _ in 0..n_kv {
        let key = string(&mut r)?;
        let ty = u32_(&mut r)?;
        match ty {
            T_STRING => {
                if let Some(v) = short_string(&mut r)? {
                    strings.insert(key, v);
                }
            }
            T_ARRAY => read_vector(&mut r, key, &mut vectors)?,
            // floats, booleans and the types that aren't numbers aren't needed
            6 | 7 | 12 => skip_value(&mut r, ty)?,
            _ if (ty as usize) < SCALAR_SIZE.len() && SCALAR_SIZE[ty as usize] > 0 => {
                if let Some(v) = read_int(&mut r, ty)? {
                    ints.insert(key, v);
                }
            }
            _ => skip_value(&mut r, ty)?,
        }
    }
    let arch = strings.get("general.architecture").cloned().context("general.architecture is missing")?;
    let mut infos = Vec::with_capacity(n_tensors as usize);
    for _ in 0..n_tensors {
        let name = string(&mut r)?;
        let n_dims = u32_(&mut r)?;
        r.seek(SeekFrom::Current(8 * i64::from(n_dims)))?;
        let _type = u32_(&mut r)?;
        infos.push((name, u64_(&mut r)?));
    }
    let align = ints.get("general.alignment").copied().unwrap_or(DEFAULT_ALIGNMENT);
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
    Ok(GgufHeader { arch, ints, strings, vectors, tensors })
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
fn layer_cache(h: &GgufHeader, il: usize, ctk: &str, ctv: &str) -> Result<u64> {
    let heads = h.per_layer("attention.head_count", il);
    let n_kv = h.per_layer("attention.head_count_kv", il).or(heads).with_context(|| format!("{}.attention.head_count is missing from the header", h.arch))?;
    let length = |k: &str| -> Result<u64> {
        match h.int_opt(k) {
            Some(l) => Ok(l),
            None => Ok(h.int("embedding_length")? / heads.with_context(|| format!("{}.{k} is missing from the header", h.arch))?),
        }
    };
    let ((kb, ke), (vb, ve)) = (cache_type(ctk)?, cache_type(ctv)?);
    Ok((n_kv * length("attention.key_length")? * kb).div_ceil(ke) + (n_kv * length("attention.value_length")? * vb).div_ceil(ve))
}

/// Bytes of state of a recurrent layer: the matrix (state_size x inner_size) plus the convolution window, f32.
fn layer_state(h: &GgufHeader) -> Result<u64> {
    let (ss, inner, kernel) = (h.int("ssm.state_size")?, h.int("ssm.inner_size")?, h.int("ssm.conv_kernel")?);
    // `group_count` exists only in grouped models (DeltaNet, Mamba 2): in the others there are no groups.
    let groups = h.int_opt("ssm.group_count").unwrap_or(0);
    Ok((ss * inner + (kernel - 1) * (inner + 2 * groups * ss)) * 4)
}

/// The model's shape for the split. `ctk`/`ctv`: cache types as in the engine's arguments (`f16` if not specified).
pub fn read_shape(path: &Path, ctk: &str, ctv: &str) -> Result<ModelShape> {
    let h = read_header(path)?;
    let n_block = h.int("block_count")? as usize;
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
}

/// The memory any model asks beyond the weights, from its header. With an f16 cache and no sliding windows: the
/// estimate is on the high side.
pub fn model_memory(h: &GgufHeader) -> Result<GgufMemory> {
    let n_block = h.int("block_count")? as usize;
    let n_mtp = h.int_opt("nextn_predict_layers").unwrap_or(0) as usize;
    let n_layers = n_block.checked_sub(n_mtp).context("more MTP layers than layers")?;
    let recurrent = recurrent_layers(h, n_layers);
    let n_recurrent = recurrent.iter().filter(|&&r| r).count() as u64;
    let mut kv_bytes = 0;
    for il in (0..n_block).filter(|&il| !recurrent.get(il).copied().unwrap_or(false)) {
        // A vector of KV heads with 0 says that layer has no attention (short convolution).
        if h.per_layer("attention.head_count_kv", il) != Some(0) {
            kv_bytes += layer_cache(h, il, "f16", "f16")?;
        }
    }
    let state = if n_recurrent > 0 { n_recurrent * layer_state(h)? } else { 0 };
    Ok(GgufMemory { kv_kib_token: kv_bytes.div_ceil(1024), state_mib: state.div_ceil(1 << 20), ctx_max: h.int_opt("context_length").and_then(|c| u32::try_from(c).ok()) })
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
    /// the header only; the file is extended to the end of the data (without writing it).
    pub fn write_with(path: &std::path::Path, arch: &str, ints: &[(&str, u32)], strings: &[(&str, &str)], vectors: &[(&str, &[u32])], tensors: &[(&str, u64)]) {
        let mut w = Vec::new();
        w.extend(b"GGUF");
        w.extend(3u32.to_le_bytes());
        w.extend((tensors.len() as u64).to_le_bytes());
        w.extend(((ints.len() + strings.len() + vectors.len()) as u64 + 2).to_le_bytes());
        s(&mut w, "general.architecture");
        w.extend(8u32.to_le_bytes());
        s(&mut w, arch);
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
        for (name, bytes) in tensors {
            s(&mut w, name);
            w.extend(1u32.to_le_bytes());
            w.extend(1u64.to_le_bytes());
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
        let m = model_memory(&h).unwrap();
        // 8 KV heads x (80 + 80) x 2 bytes = 2560 B per layer and token, x 36 layers = 90 KiB
        assert_eq!(m, GgufMemory { kv_kib_token: 90, state_mib: 0, ctx_max: Some(40960) });
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
        let m = model_memory(&read_header(&p).unwrap()).unwrap();
        // 2 attention layers: 4 x (256 + 256) x 2 = 4096 B each = 8 KiB; 2 recurrent ones of 3,268,608 B = 6.2 MiB
        assert_eq!((m.kv_kib_token, m.state_mib), (8, 7));
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
        assert_eq!(model_memory(&h).unwrap().kv_kib_token, 4);
    }

    #[test]
    fn without_the_numbers_to_estimate_the_cache_the_error_says_which_is_missing() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("odd.gguf");
        test_util::write_with(&p, "odd", &[("odd.block_count", 2)], &[], &[], &[("blk.0.attn_k.weight", 10), ("blk.1.attn_k.weight", 10)]);
        let e = model_memory(&read_header(&p).unwrap()).unwrap_err().to_string();
        assert!(e.contains("odd.attention.head_count"), "{e}");
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
        assert!(read_header(&p).unwrap_err().to_string().contains("GGUF"));
    }
}
