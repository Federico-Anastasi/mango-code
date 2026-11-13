//! Hugging Face for «Other models»: search for a model, recognize a link, list the GGUF files of a repo (with size
//! and sha256 hash, as the public API gives them) and read the start of a GGUF to know what it asks of memory. The
//! real download is `install_model`, from the catalog.

use super::{http_agent, hugging_face_token, hugging_face_url};
use crate::tr;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::ops::Range;
use std::time::{Duration, Instant};

/// How long Hugging Face may stay silent before a call is given up.
const MAX_WAIT: Duration = Duration::from_secs(30);
/// How long before its instant an error still counts as the deadline's (`file_part`).
const DEADLINE_SLACK: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchResult {
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
    /// It asks to accept terms, and the token, to download.
    pub gated: bool,
}

/// A repo, or a file of a repo, named by a link or by `owner/name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub repo: String,
    /// The file named by the link (`.../blob/main/x.gguf`), in the repo.
    pub path: Option<String>,
    /// The quantization named (`hf.co/owner/name:Q4_K_M`).
    pub quant: Option<String>,
    /// A revision other than `main`.
    pub revision: Option<String>,
}

/// A GGUF file of the repo: `sha256` is the one Hugging Face recorded for the whole file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HfFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    pub id: String,
    /// The commit the files are read at: downloads stay on this revision.
    pub revision: String,
    pub gated: bool,
    /// The `.gguf` files with their hash, in path order.
    pub files: Vec<HfFile>,
}

/// A quantization of the model: one file, or the pieces of a split model (`-00001-of-00003`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Variant {
    pub name: String,
    /// The first piece first: it's the one given to the engine.
    pub files: Vec<HfFile>,
}

impl Variant {
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// Recognizes a link to a repo (`https://huggingface.co/p/n`, `.../blob/main/f.gguf`, `hf.co/p/n:Q4_K_M`), also amid
/// other words, or a plain `owner/name`. Anything else (words to search for, a link elsewhere) is `None`.
pub fn parse_reference(text: &str) -> Option<Reference> {
    let text = text.trim();
    let (path, from_link) = match hugging_face_path(text) {
        Some(p) => (p, true),
        // Words with spaces between them are a search, not `owner/name`; a link elsewhere is nothing.
        None if !text.contains(char::is_whitespace) && !text.contains("://") => (text.to_string(), false),
        None => return None,
    };
    let path = path.split(['?', '#']).next()?;
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 || (!from_link && parts.len() != 2) || ["datasets", "spaces", "models", "papers", "collections", "docs"].contains(&parts[0]) {
        return None;
    }
    let (name, quant) = match parts[1].split_once(':') {
        Some((n, q)) if !q.is_empty() => (n, Some(q.to_string())),
        _ => (parts[1], None),
    };
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !valid(parts[0]) || !valid(name) {
        return None;
    }
    let (revision, path) = match parts.get(2) {
        Some(&kind @ ("tree" | "blob" | "resolve")) if parts.len() > 3 => {
            // `refs/pr/1` is a revision with slashes: encoded in the link (`refs%2Fpr%2F1`) or not.
            let (revision, rest) = if parts[3] == "refs" && parts.len() > 5 { (parts[3..6].join("/"), &parts[6..]) } else { (decode(parts[3]), &parts[4..]) };
            let path = (kind != "tree" && !rest.is_empty()).then(|| rest.iter().map(|p| decode(p)).collect::<Vec<_>>().join("/"));
            (Some(revision), path)
        }
        _ => (None, None),
    };
    Some(Reference { repo: format!("{}/{name}", parts[0]), path, quant, revision: revision.filter(|r| r != "main") })
}

/// The path after the host of the first Hugging Face link in `text`: the words around it are not part of it, but a
/// link broken by a space or a line break next to a `/` (copied from a chat) is put back together.
fn hugging_face_path(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let start = words.iter().position(|w| after_host(w).is_some())?;
    let mut path = after_host(words[start])?.to_string();
    for w in &words[start + 1..] {
        if !(path.is_empty() || path.ends_with('/') || w.starts_with('/')) {
            break;
        }
        path.push_str(w);
    }
    Some(path)
}

/// What follows Hugging Face's host in a word that is a link to it.
fn after_host(word: &str) -> Option<&str> {
    let rest = strip_prefix_ignoring_case(word, "https://").or_else(|| strip_prefix_ignoring_case(word, "http://")).unwrap_or(word);
    ["www.huggingface.co/", "huggingface.co/", "hf.co/"].iter().find_map(|h| strip_prefix_ignoring_case(rest, h))
}

/// `text` without `prefix`, whatever the case of its letters (`HTTPS://HF.co/`).
fn strip_prefix_ignoring_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len()).filter(|head| head.eq_ignore_ascii_case(prefix)).map(|_| &text[prefix.len()..])
}

/// A piece of an address with its `%XX` turned back into characters.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b.get(i + 1..i + 3).filter(|h| h.iter().all(u8::is_ascii_hexdigit)).and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// The file that reads the images (`mmproj-F16.gguf`, `Model-mmproj-Q8_0.gguf`), not the model.
pub fn is_encoder(f: &HfFile) -> bool {
    file_name(&f.path).to_ascii_lowercase().contains("mmproj")
}

/// A piece of a split model (`model-00002-of-00003.gguf`): the name without `-00002-of-00003.gguf`, the piece's number
/// and how many there are.
pub fn piece(path: &str) -> Option<(&str, u32, u32)> {
    let (rest, total) = path.strip_suffix(".gguf")?.rsplit_once("-of-")?;
    let (base, n) = rest.rsplit_once('-')?;
    let digits = |s: &str| s.len() == 5 && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(n) || !digits(total) {
        return None;
    }
    let (n, total): (u32, u32) = (n.parse().ok()?, total.parse().ok()?);
    (1..=total).contains(&n).then_some((base, n, total))
}

/// «Q4_K_M», «IQ3_M», «F16», «MXFP4»: a word that names a quantization.
pub fn is_quantization(t: &str) -> bool {
    let t = t.to_ascii_uppercase();
    ["F16", "BF16", "F32", "MXFP4"].contains(&t.as_str()) || t.strip_prefix("IQ").or_else(|| t.strip_prefix('Q')).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()))
}

/// «Q4_K_M», «UD-Q5_K_XL»: the last part of the name that tells the quantization.
fn quantization_name(base: &str) -> Option<String> {
    let parts: Vec<&str> = file_name(base).split(['-', '.']).collect();
    let i = parts.iter().rposition(|p| is_quantization(p))?;
    Some(if i > 0 && parts[i - 1].eq_ignore_ascii_case("UD") { format!("{}-{}", parts[i - 1], parts[i]) } else { parts[i].to_string() })
}

/// The repo's quantizations: the `.gguf` files that aren't an image encoder, with split models joined, smallest
/// first.
pub fn variants(repo: &Repo) -> Vec<Variant> {
    let mut groups: Vec<(String, Vec<(u32, &HfFile)>)> = Vec::new();
    for f in repo.files.iter().filter(|f| !is_encoder(f)) {
        let (base, n) = match piece(&f.path) {
            Some((b, n, _)) => (b.to_string(), n),
            None => (f.path.trim_end_matches(".gguf").to_string(), 0),
        };
        match groups.iter_mut().find(|g| g.0 == base) {
            Some(g) => g.1.push((n, f)),
            None => groups.push((base, vec![(n, f)])),
        }
    }
    let names: Vec<String> = groups.iter().map(|(b, _)| quantization_name(b).unwrap_or_else(|| file_name(b).to_string())).collect();
    let mut v: Vec<Variant> = groups
        .into_iter()
        .enumerate()
        .map(|(i, (base, mut pieces))| {
            pieces.sort_by_key(|p| p.0);
            // Two files with the same quantization in different folders: the path tells them apart.
            let name = if names.iter().filter(|n| **n == names[i]).count() > 1 { base } else { names[i].clone() };
            Variant { name, files: pieces.into_iter().map(|p| p.1.clone()).collect() }
        })
        .collect();
    v.sort_by(|a, b| a.bytes().cmp(&b.bytes()).then_with(|| a.name.cmp(&b.name)));
    v
}

/// The image encoder (`mmproj*.gguf`) among `files`, if any: F16 if there is more than one, otherwise the smallest.
pub fn image_encoder(files: &[HfFile]) -> Option<HfFile> {
    let encoders: Vec<&HfFile> = files.iter().filter(|f| is_encoder(f)).collect();
    let f16 = encoders.iter().find(|f| file_name(&f.path).split(['-', '.', '_']).any(|p| p.eq_ignore_ascii_case("f16")));
    f16.or_else(|| encoders.iter().min_by_key(|f| f.size)).map(|f| (*f).clone())
}

/// Searches GGUF models by name, most downloaded first.
pub fn search(text: &str) -> Result<Vec<SearchResult>> {
    search_at(&hugging_face_url(), text)
}

fn search_at(base: &str, text: &str) -> Result<Vec<SearchResult>> {
    #[derive(Deserialize)]
    struct Item {
        id: String,
        #[serde(default)]
        downloads: u64,
        #[serde(default)]
        likes: u64,
        /// `false`, or `"auto"` / `"manual"`.
        #[serde(default)]
        gated: serde_json::Value,
    }
    let url = format!("{base}/api/models?search={}&filter=gguf&sort=downloads&direction=-1&limit=20", encode(text));
    let items: Vec<Item> = get_json(&url)?;
    Ok(items.into_iter().map(|v| SearchResult { gated: is_gated(&v.gated), id: v.id, downloads: v.downloads, likes: v.likes }).collect())
}

/// The repo `id` (at revision `revision`, or the latest) with its GGUF files.
pub fn repo(id: &str, revision: Option<&str>) -> Result<Repo> {
    repo_at(&hugging_face_url(), id, revision)
}

fn repo_at(base: &str, id: &str, revision: Option<&str>) -> Result<Repo> {
    #[derive(Deserialize)]
    struct Info {
        sha: String,
        #[serde(default)]
        gated: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Item {
        #[serde(rename = "type")]
        kind: String,
        path: String,
        lfs: Option<Lfs>,
    }
    #[derive(Deserialize)]
    struct Lfs {
        oid: String,
        size: u64,
    }
    let info: Info = get_json(&format!("{base}/api/models/{id}/revision/{}", encode(revision.unwrap_or("main"))))?;
    let mut files = Vec::new();
    let mut page = Some(format!("{base}/api/models/{id}/tree/{}?recursive=true", info.sha));
    while let Some(url) = page {
        let response = get(&url, None, None)?;
        page = response.headers().get("link").and_then(|l| l.to_str().ok()).and_then(next_page).filter(|p| p.starts_with(base));
        let body = response.into_body().read_to_string().with_context(|| tr!("lettura di {url}", "reading {url}"))?;
        let items: Vec<Item> = serde_json::from_str(&body).with_context(|| tr!("risposta di {url} non valida", "invalid reply from {url}"))?;
        // A GGUF without a hash (not in LFS) can't be verified: it isn't offered.
        files.extend(items.into_iter().filter(|v| v.kind == "file" && v.path.to_ascii_lowercase().ends_with(".gguf")).filter_map(|v| {
            let lfs = v.lfs?;
            Some(HfFile { path: v.path, size: lfs.size, sha256: lfs.oid })
        }));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Repo { id: id.to_string(), revision: info.sha, gated: is_gated(&info.gated), files })
}

/// The bytes `range` of a repo file (fewer if the file ends first): a GGUF's header (metadata and tensors) is at its
/// start, without the weights. Past `deadline` it stops, and the error says Hugging Face is too slow.
pub fn file_part(repo: &Repo, file: &HfFile, range: Range<usize>, deadline: Instant) -> Result<Vec<u8>> {
    file_part_at(&hugging_face_url(), repo, file, range, deadline)
}

fn file_part_at(base: &str, repo: &Repo, file: &HfFile, range: Range<usize>, deadline: Instant) -> Result<Vec<u8>> {
    let path: Vec<String> = file.path.split('/').map(encode).collect();
    let url = format!("{base}/{}/resolve/{}/{}", repo.id, repo.revision, path.join("/"));
    let read = || -> Result<Vec<u8>> {
        let response = get(&url, Some(&format!("bytes={}-{}", range.start, range.end.saturating_sub(1))), Some(deadline))?;
        // A server that ignores the range replies 200 with the whole file: what comes before the range is skipped.
        let skip = if response.status().as_u16() == 206 { 0 } else { range.start as u64 };
        let mut body = response.into_body().into_reader();
        let mut v = Vec::new();
        std::io::copy(&mut body.by_ref().take(skip), &mut std::io::sink())
            .and_then(|_| body.take(range.len() as u64).read_to_end(&mut v))
            .with_context(|| tr!("lettura di {}", "reading {}", file.path))?;
        Ok(v)
    };
    // The timeout that enforces the deadline counts in whole milliseconds and can fire a moment before the instant: an
    // error that close to it is the deadline's.
    read().map_err(|e| match Instant::now() + DEADLINE_SLACK >= deadline {
        true => crate::user_error(&tr!("Hugging Face risponde troppo piano: riprova fra poco.", "Hugging Face is answering too slowly: try again shortly."), format!("{e:#}")),
        false => e,
    })
}

/// Checks that Hugging Face recognizes the token.
pub fn verify_token(token: &str) -> Result<()> {
    verify_token_at(&hugging_face_url(), token)
}

fn verify_token_at(base: &str, token: &str) -> Result<()> {
    match http_agent(base, Some(MAX_WAIT)).get(&format!("{base}/api/whoami-v2")).header("Authorization", format!("Bearer {token}")).call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::StatusCode(401)) => bail!(
            "{}",
            tr!(
                "Hugging Face non riconosce questo token: controlla di averlo copiato intero",
                "Hugging Face doesn't recognize this token: check that you copied all of it"
            )
        ),
        Err(e) => bail!("{}", tr!("non riesco a controllare il token con Hugging Face ({e})", "I can't check the token with Hugging Face ({e})")),
    }
}

/// GET of `url` with the Hugging Face token (if any) and, if needed, a range, all within `deadline`; a refusal becomes a
/// sentence that says why.
fn get(url: &str, range: Option<&str>, deadline: Option<Instant>) -> Result<ureq::http::Response<ureq::Body>> {
    get_as(url, range, deadline, hugging_face_token(url))
}

fn get_as(url: &str, range: Option<&str>, deadline: Option<Instant>, token: Option<String>) -> Result<ureq::http::Response<ureq::Body>> {
    // The refusals are read here, with their headers: `X-Error-Code` tells a gated model from one that isn't there.
    let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
    let mut request = http_agent(url, Some(MAX_WAIT)).get(url).config().http_status_as_error(false).timeout_global(left).build();
    if let Some(i) = range {
        request = request.header("Range", i);
    }
    if let Some(t) = &token {
        request = request.header("Authorization", format!("Bearer {t}"));
    }
    let response = request.call().map_err(|e| crate::internet::network_failure(e, url))?;
    let status = response.status().as_u16();
    if status < 400 {
        return Ok(response);
    }
    let code = response.headers().get("x-error-code").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let detail = if code.is_empty() { format!("{status} {url}") } else { format!("{status} {code} {url}") };
    let text = crate::user_text(&refusal(status, code, token.is_some()), detail);
    let missing_for_the_token = status == 404 && token.is_some() && !matches!(code, "EntryNotFound" | "RevisionNotFound");
    if matches!(status, 401 | 403) || code == "GatedRepo" || missing_for_the_token {
        return Err(TokenRefusal(text).into());
    }
    Err(anyhow::anyhow!(text))
}

/// A refusal of Hugging Face that the user's token answers: a gated model, a 401, a 403, or a 404 with a token (a private
/// model it can't read). The interface puts the way to the token under its sentence (`is_token_refusal`).
#[derive(Debug)]
pub struct TokenRefusal(String);

impl std::fmt::Display for TokenRefusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for TokenRefusal {}

/// The error, or one of its causes, is a refusal that the token answers.
pub fn is_token_refusal(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| cause.is::<TokenRefusal>())
}

/// Why Hugging Face refuses, in words. Without a token it answers 401 both for a model that isn't there and for a
/// private one. With a token, a 401 is the token itself (a valid one gets 403 or 404): Hugging Face ignores a bad token
/// for what is public, and refuses it for the rest; a 404 is a wrong link, or a private model the token can't read. A
/// gated model says so (`GatedRepo`).
fn refusal(status: u16, code: &str, with_token: bool) -> String {
    match (status, code) {
        (401, _) if with_token => tr!(
            "Il tuo token di Hugging Face non è valido o è scaduto: salvane uno nuovo in Collegamenti.",
            "Your Hugging Face token is not valid or has expired: save a new one in Connections."
        ),
        (_, "GatedRepo") => tr!(
            "Questo modello chiede di accettare le sue condizioni: aprilo su Hugging Face, accettale e salva il tuo token in Collegamenti.",
            "This model asks you to accept its terms: open it on Hugging Face, accept them and save your token in Connections."
        ),
        (_, "EntryNotFound") => tr!(
            "Questo file non c'è più nel modello su Hugging Face: apri il modello dalla sua pagina e scegli un altro file.",
            "This file is no longer in the model on Hugging Face: open the model from its page and choose another file."
        ),
        (_, "RevisionNotFound") => tr!(
            "La versione del modello che il link indica non c'è su Hugging Face: usa il link della pagina del modello.",
            "The version of the model the link points to isn't on Hugging Face: use the link of the model's page."
        ),
        (404, _) if with_token => tr!(
            "Non trovo questo modello su Hugging Face: controlla il link. Se è privato, controlla in Collegamenti che il tuo token lo possa leggere.",
            "I can't find this model on Hugging Face: check the link. If it is private, check in Connections that your token can read it."
        ),
        (401 | 404, _) => tr!(
            "Non trovo questo modello su Hugging Face: controlla il link. Se è privato, salva in Collegamenti un tuo token che lo può leggere.",
            "I can't find this model on Hugging Face: check the link. If it is private, save in Connections a token of yours that can read it."
        ),
        (403, _) => tr!(
            "Il tuo token di Hugging Face non può leggere questo modello: controlla i suoi permessi.",
            "Your Hugging Face token can't read this model: check its permissions."
        ),
        (429, _) => tr!("Hugging Face chiede di aspettare un momento: riprova fra un minuto.", "Hugging Face asks to wait a moment: try again in a minute."),
        _ => tr!(
            "Hugging Face non risponde come dovrebbe (errore {status}): riprova fra poco.",
            "Hugging Face isn't answering as it should (error {status}): try again shortly."
        ),
    }
}

fn get_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    let body = get(url, None, None)?.into_body().read_to_string().with_context(|| tr!("lettura di {url}", "reading {url}"))?;
    serde_json::from_str(&body).with_context(|| tr!("risposta di {url} non valida", "invalid reply from {url}"))
}

/// The API's `gated` field is `false`, or `"auto"` / `"manual"`.
fn is_gated(gated: &serde_json::Value) -> bool {
    !matches!(gated, serde_json::Value::Bool(false) | serde_json::Value::Null)
}

/// The address of the next page, from the `Link` header (`<url>; rel="next"`).
fn next_page(link: &str) -> Option<String> {
    link.split(',').find(|p| p.contains("rel=\"next\"")).and_then(|p| p.split_once('<')?.1.split_once('>')).map(|(url, _)| url.to_string())
}

/// A piece of an address: everything that isn't a letter, digit or `-._~` becomes `%XX`.
fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[cfg(test)]
mod tests {
    use super::super::fake_server::{FakeServer, Route};
    use super::*;

    fn json(v: serde_json::Value) -> Route {
        Route::file(v.to_string().into_bytes())
    }

    #[test]
    fn the_search_gives_repos_with_numbers() {
        let s = FakeServer::start([(
            "/api/models?search=qwen3&filter=gguf&sort=downloads&direction=-1&limit=20",
            json(serde_json::json!([
                { "id": "Qwen/Qwen3-4B-GGUF", "downloads": 1200, "likes": 30, "gated": false },
                { "id": "meta/Closed-GGUF", "downloads": 5, "likes": 1, "gated": "manual" }
            ])),
        )]);
        let r = search_at(&s.url, "qwen3").unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], SearchResult { id: "Qwen/Qwen3-4B-GGUF".into(), downloads: 1200, likes: 30, gated: false });
        assert!(r[1].gated);
    }

    #[test]
    fn the_repo_gives_the_ggufs_with_hash_and_the_revision() {
        let sha = "a".repeat(40);
        let oid = "b".repeat(64);
        let s = FakeServer::start([
            ("/api/models/p/n/revision/main", json(serde_json::json!({ "sha": sha, "gated": "auto" }))),
            (
                &format!("/api/models/p/n/tree/{sha}?recursive=true"),
                json(serde_json::json!([
                    { "type": "directory", "path": "Q4" },
                    { "type": "file", "path": "README.md", "size": 100 },
                    { "type": "file", "path": "Q4/m-Q4_K_M.gguf", "size": 133, "lfs": { "oid": oid, "size": 4000000000u64 } },
                    { "type": "file", "path": "no-lfs.gguf", "size": 5 }
                ])),
            ),
        ]);
        let r = repo_at(&s.url, "p/n", None).unwrap();
        assert_eq!(r.revision, sha);
        assert!(r.gated);
        assert_eq!(r.files, [HfFile { path: "Q4/m-Q4_K_M.gguf".into(), size: 4_000_000_000, sha256: oid }], "only the GGUFs that have a hash");
    }

    #[test]
    fn a_repo_that_does_not_exist_or_is_closed_says_so() {
        let s = FakeServer::start([]);
        let e = format!("{:#}", repo_at(&s.url, "p/does-not-exist", None).unwrap_err());
        assert!(e.contains("p/does-not-exist") && e.contains("404"), "{e}");
    }

    /// Each refusal of Hugging Face says why in words; the address and the code stay in the technical detail.
    #[test]
    fn a_refusal_says_why_in_words() {
        let sha = "d".repeat(40);
        let s = FakeServer::start([
            ("/api/models/p/private/revision/main", Route::refuse(401, "")),
            ("/api/models/p/no-access/revision/main", Route::refuse(403, "")),
            ("/api/models/p/busy/revision/main", Route::refuse(429, "")),
            ("/api/models/p/broken/revision/main", Route::refuse(502, "")),
            (&format!("/p/gated/resolve/{sha}/m.gguf"), Route::refuse(401, "GatedRepo")),
        ]);
        let phrase = |e: anyhow::Error| {
            let e = e.to_string();
            let (phrase, detail) = e.split_once(&tr!("(dettaglio tecnico", "(technical detail")).unwrap_or_else(|| panic!("no detail: {e}"));
            assert!(!phrase.contains(&s.url) && detail.contains(&s.url), "{e}");
            phrase.trim().to_string()
        };
        let repo = |id: &str| phrase(repo_at(&s.url, id, None).unwrap_err());
        assert!(repo("p/private").contains(&tr!("Non trovo questo modello", "I can't find this model")), "{}", repo("p/private"));
        assert!(repo("p/private").contains(&tr!("privato", "private")));
        assert!(repo("p/missing").contains(&tr!("Non trovo questo modello", "I can't find this model")), "a 404 too");
        assert!(repo("p/no-access").contains(&tr!("permessi", "permissions")), "{}", repo("p/no-access"));
        assert!(repo("p/busy").contains(&tr!("riprova fra un minuto", "try again in a minute")), "{}", repo("p/busy"));
        assert!(repo("p/broken").contains("502"), "{}", repo("p/broken"));

        let gated = Repo { id: "p/gated".into(), revision: sha, gated: true, files: vec![] };
        let f = HfFile { path: "m.gguf".into(), size: 100, sha256: "0".repeat(64) };
        let e = file_part_at(&s.url, &gated, &f, 0..64, later()).unwrap_err();
        assert!(is_token_refusal(&e.context("a step above")), "a gated model: the token answers it, also under a context");
        let e = phrase(file_part_at(&s.url, &gated, &f, 0..64, later()).unwrap_err());
        assert!(e.contains(&tr!("accettare le sue condizioni", "accept its terms")) && e.contains("token"), "{e}");

        // the token answers a 401 and a 403, not a model that is not there, a wait or a broken server
        let token = |id: &str| is_token_refusal(&repo_at(&s.url, id, None).unwrap_err());
        assert!(token("p/private") && token("p/no-access"));
        assert!(!token("p/missing") && !token("p/busy") && !token("p/broken"));
    }

    /// With a token, a 401 is the token (also in the search, which goes through the same call); a file that isn't in the
    /// repo or a version that isn't there have sentences of their own, not «the model isn't there».
    #[test]
    fn a_refused_token_a_missing_file_and_a_missing_version_say_so() {
        let s = FakeServer::start([
            ("/api/models?search=x", Route::refuse(401, "")),
            ("/p/n/resolve/r/gone.gguf", Route::refuse(404, "EntryNotFound")),
            ("/api/models/p/n/revision/old", Route::refuse(404, "RevisionNotFound")),
            ("/p/gated/resolve/r/m.gguf", Route::refuse(401, "GatedRepo")),
            ("/p/admitted-not/resolve/r/m.gguf", Route::refuse(403, "GatedRepo")),
            ("/api/models/p/gone/revision/main", Route::refuse(404, "RepoNotFound")),
        ]);
        let text = |e: anyhow::Error| e.to_string();
        let e = text(get_as(&format!("{}/api/models?search=x", s.url), None, None, Some("hf_old".into())).unwrap_err());
        assert!(e.starts_with(&tr!("Il tuo token di Hugging Face non è valido o è scaduto", "Your Hugging Face token is not valid or has expired")) && !e.contains("hf_old"), "{e}");
        let e = text(get_as(&format!("{}/api/models?search=x", s.url), None, None, None).unwrap_err());
        assert!(e.starts_with(&tr!("Non trovo questo modello", "I can't find this model")), "without a token: {e}");
        // a gated model refuses a bad token with 401 too (a good one not yet admitted gets 403)
        let e = text(get_as(&format!("{}/p/gated/resolve/r/m.gguf", s.url), None, None, Some("hf_old".into())).unwrap_err());
        assert!(e.starts_with(&tr!("Il tuo token di Hugging Face non è valido", "Your Hugging Face token is not valid")), "{e}");
        let e = text(get_as(&format!("{}/p/admitted-not/resolve/r/m.gguf", s.url), None, None, Some("hf_good".into())).unwrap_err());
        assert!(e.starts_with(&tr!("Questo modello chiede di accettare", "This model asks you to accept")), "{e}");
        let gone = HfFile { path: "gone.gguf".into(), size: 100, sha256: "0".repeat(64) };
        let e = text(file_part_at(&s.url, &repo_with(vec![]), &gone, 0..64, later()).unwrap_err());
        assert!(e.starts_with(&tr!("Questo file non c'è più", "This file is no longer")), "{e}");
        let e = text(repo_at(&s.url, "p/n", Some("old")).unwrap_err());
        assert!(e.starts_with(&tr!("La versione del modello", "The version of the model")), "{e}");

        // with a token already saved, a model that isn't there is the link or what the token can read, with the way
        // to the token; without a token the sentence asks for one, and no way to it
        let missing = format!("{}/api/models/p/missing/revision/main", s.url);
        let e = get_as(&missing, None, None, Some("hf_good".into())).unwrap_err();
        let phrase = crate::user_phrase(&e);
        assert!(phrase.contains(&tr!("controlla il link", "check the link")) && phrase.contains(&tr!("che il tuo token lo possa leggere", "that your token can read it")), "{phrase}");
        assert!(!phrase.contains(&tr!("salva in Collegamenti", "save in Connections")) && is_token_refusal(&e), "{phrase}");
        let e = get_as(&format!("{}/api/models/p/gone/revision/main", s.url), None, None, Some("hf_good".into())).unwrap_err();
        assert!(crate::user_phrase(&e).contains(&tr!("che il tuo token lo possa leggere", "that your token can read it")) && is_token_refusal(&e), "with its code too");
        let e = get_as(&missing, None, None, None).unwrap_err();
        assert!(crate::user_phrase(&e).contains(&tr!("salva in Collegamenti un tuo token", "save in Connections a token")) && !is_token_refusal(&e));
        // a missing file or version has its own sentence, with or without a token
        assert!(!is_token_refusal(&file_part_at(&s.url, &repo_with(vec![]), &gone, 0..64, later()).unwrap_err()));
    }

    /// A deadline far away.
    fn later() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn the_start_of_the_file_is_read_without_downloading_all_of_it() {
        let body: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let sha = "c".repeat(40);
        let s = FakeServer::start([(&format!("/p/n/resolve/{sha}/Q4/m.gguf"), Route::file(body.clone()))]);
        let repo = Repo { id: "p/n".into(), revision: sha, gated: false, files: vec![] };
        let f = HfFile { path: "Q4/m.gguf".into(), size: body.len() as u64, sha256: "0".repeat(64) };
        assert_eq!(file_part_at(&s.url, &repo, &f, 0..4096, later()).unwrap(), body[..4096]);
        assert_eq!(file_part_at(&s.url, &repo, &f, 0..1 << 20, later()).unwrap(), body, "if the file is shorter, whatever there is");
        assert_eq!(s.requests()[0].range.as_deref(), Some("bytes=0-4095"));
        // a later part: only its bytes are asked for, and a server that ignores the range gives them all the same
        assert_eq!(file_part_at(&s.url, &repo, &f, 4096..8192, later()).unwrap(), body[4096..8192]);
        assert_eq!(s.requests()[2].range.as_deref(), Some("bytes=4096-8191"));
        let whole = FakeServer::start([(&format!("/p/n/resolve/{}/Q4/m.gguf", "c".repeat(40)), Route { ignore_range: true, ..Route::file(body.clone()) })]);
        assert_eq!(file_part_at(&whole.url, &repo, &f, 4096..8192, later()).unwrap(), body[4096..8192]);
    }

    /// A server that stops sending halfway doesn't hold the analysis beyond its deadline, and the sentence says why.
    #[test]
    fn a_start_that_does_not_arrive_in_time_stops_at_the_deadline() {
        let body = vec![7u8; 100_000];
        let s = FakeServer::start([("/p/n/resolve/r/m.gguf", Route { stall_at: Some(1000), ignore_range: true, ..Route::file(body) })]);
        let f = HfFile { path: "m.gguf".into(), size: 100_000, sha256: "0".repeat(64) };
        let t0 = Instant::now();
        let e = file_part_at(&s.url, &repo_with(vec![]), &f, 0..50_000, Instant::now() + Duration::from_millis(500)).unwrap_err().to_string();
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
        assert!(e.starts_with(&tr!("Hugging Face risponde troppo piano", "Hugging Face is answering too slowly")), "{e}");
    }

    /// A revision with slashes (`refs/pr/1`) is read from the link encoded or not, and asked for encoded.
    #[test]
    fn a_revision_with_slashes_is_read_and_asked_for_whole() {
        let pr = reference("p/n", Some("m-Q4_K_M.gguf"), None, Some("refs/pr/1"));
        assert_eq!(parse_reference("https://huggingface.co/p/n/blob/refs%2Fpr%2F1/m-Q4_K_M.gguf"), pr);
        assert_eq!(parse_reference("https://huggingface.co/p/n/resolve/refs/pr/1/m-Q4_K_M.gguf?download=true"), pr);
        assert_eq!(parse_reference("https://huggingface.co/p/n/tree/refs%2Fpr%2F1"), reference("p/n", None, None, Some("refs/pr/1")));
        let sha = "e".repeat(40);
        let s = FakeServer::start([
            ("/api/models/p/n/revision/refs%2Fpr%2F1", json(serde_json::json!({ "sha": sha }))),
            (&format!("/api/models/p/n/tree/{sha}?recursive=true"), json(serde_json::json!([]))),
        ]);
        assert_eq!(repo_at(&s.url, "p/n", Some("refs/pr/1")).unwrap().revision, sha);
    }

    #[test]
    fn the_next_page_comes_from_the_link_header() {
        let l = r#"<https://huggingface.co/api/models/p/n/tree/x?recursive=true&cursor=abc>; rel="next", <https://huggingface.co/api/y>; rel="prev""#;
        assert_eq!(next_page(l).as_deref(), Some("https://huggingface.co/api/models/p/n/tree/x?recursive=true&cursor=abc"));
        assert_eq!(next_page(r#"<https://huggingface.co/api/y>; rel="prev""#), None);
        assert_eq!(encode("qwen 3/4b"), "qwen%203%2F4b");
    }

    #[test]
    fn the_token_is_checked_before_saving_it() {
        let s = FakeServer::start([("/api/whoami-v2", json(serde_json::json!({ "name": "me" })))]);
        verify_token_at(&s.url, "hf_good").unwrap();
        let none = FakeServer::start([]);
        let e = format!("{:#}", verify_token_at(&none.url, "hf_bad").unwrap_err());
        assert!(e.contains("token") && !e.contains("hf_bad"), "the token doesn't end up in the messages: {e}");
    }

    fn reference(repo: &str, path: Option<&str>, quant: Option<&str>, rev: Option<&str>) -> Option<Reference> {
        Some(Reference { repo: repo.into(), path: path.map(Into::into), quant: quant.map(Into::into), revision: rev.map(Into::into) })
    }

    #[test]
    fn recognizes_links_to_repos() {
        assert_eq!(parse_reference("Qwen/Qwen3-4B-GGUF"), reference("Qwen/Qwen3-4B-GGUF", None, None, None));
        assert_eq!(parse_reference("  https://huggingface.co/Qwen/Qwen3-4B-GGUF  "), reference("Qwen/Qwen3-4B-GGUF", None, None, None));
        assert_eq!(parse_reference("https://huggingface.co/Qwen/Qwen3-4B-GGUF/"), reference("Qwen/Qwen3-4B-GGUF", None, None, None));
        assert_eq!(parse_reference("huggingface.co/Qwen/Qwen3-4B-GGUF/tree/main"), reference("Qwen/Qwen3-4B-GGUF", None, None, None));
        assert_eq!(
            parse_reference("https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/Qwen3-4B-Q4_K_M.gguf"),
            reference("Qwen/Qwen3-4B-GGUF", Some("Qwen3-4B-Q4_K_M.gguf"), None, None)
        );
        assert_eq!(
            parse_reference("https://huggingface.co/p/n/resolve/abc123/Q4_K_M/m-00001-of-00002.gguf?download=true"),
            reference("p/n", Some("Q4_K_M/m-00001-of-00002.gguf"), None, Some("abc123"))
        );
        assert_eq!(parse_reference("hf.co/bartowski/x-GGUF:Q4_K_M"), reference("bartowski/x-GGUF", None, Some("Q4_K_M"), None));
        assert_eq!(parse_reference("https://hf.co/bartowski/x-GGUF:q8_0"), reference("bartowski/x-GGUF", None, Some("q8_0"), None));
    }

    /// Every form a user can paste for Ling 3.0 Tiny: the model's page, a file's page or its download, `owner/name`, with
    /// `?download=true`, spaces, a line break, the final slash, `hf.co`, `www.` or capital letters.
    #[test]
    fn every_form_a_user_can_paste_names_the_repo_and_the_file() {
        let repo = "inclusionAI/Ling-3.0-tiny-GGUF";
        let file = Some("Ling-3.0-tiny-Q4_K_M.gguf");
        let forms = [
            ("inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("inclusionAI/Ling-3.0-tiny-GGUF/", None, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF/", None, None),
            ("  https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF \r\n", None, None),
            ("huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("http://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("https://www.huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("HTTPS://HuggingFace.co/inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("https://hf.co/inclusionAI/Ling-3.0-tiny-GGUF", None, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF/tree/main", None, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF?library=llama-cpp#files", None, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_M.gguf", file, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF/resolve/main/Ling-3.0-tiny-Q4_K_M.gguf", file, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF/resolve/main/Ling-3.0-tiny-Q4_K_M.gguf?download=true", file, None),
            ("https://huggingface.co/inclusionAI/\nLing-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_M.gguf", file, None),
            ("hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M", None, Some("Q4_K_M")),
            ("inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M", None, Some("Q4_K_M")),
            // the link amid other words: only the link counts
            ("prova questo https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF grazie!", None, None),
            ("https://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF/blob/main/Ling-3.0-tiny-Q4_K_M.gguf (il Q4)", file, None),
            ("Ecco:\nhttps://huggingface.co/inclusionAI/Ling-3.0-tiny-GGUF\nè quello piccolo", None, None),
        ];
        for (text, path, quant) in forms {
            assert_eq!(parse_reference(text), reference(repo, path, quant, None), "{text:?}");
        }
    }

    #[test]
    fn anything_else_is_not_a_reference() {
        for t in ["", "qwen 3 4b", "ling 3.0/tiny", "qwen3", "https://github.com/Qwen/Qwen3", "guarda https://github.com/Qwen/Qwen3", "https://huggingface.co/", "https://huggingface.co/Qwen", "a/b/c", "https://huggingface.co/datasets/a/b"] {
            assert_eq!(parse_reference(t), None, "{t:?}");
        }
    }

    fn f(path: &str, size: u64) -> HfFile {
        HfFile { path: path.into(), size, sha256: "0".repeat(64) }
    }

    fn repo_with(files: Vec<HfFile>) -> Repo {
        Repo { id: "p/n".into(), revision: "r".into(), gated: false, files }
    }

    #[test]
    fn variants_join_the_pieces_and_leave_out_the_encoder() {
        let r = repo_with(vec![
            f("m-Q8_0.gguf", 800),
            f("mmproj-F16.gguf", 50),
            f("m-mmproj-Q8_0.gguf", 40),
            f("m-Q4_K_M.gguf", 400),
            f("UD-Q5_K_XL/m-UD-Q5_K_XL-00002-of-00002.gguf", 200),
            f("UD-Q5_K_XL/m-UD-Q5_K_XL-00001-of-00002.gguf", 500),
            f("m-BF16.gguf", 1600),
        ]);
        let v = variants(&r);
        assert_eq!(v.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["Q4_K_M", "UD-Q5_K_XL", "Q8_0", "BF16"], "smallest first");
        assert_eq!(v[1].bytes(), 700);
        assert_eq!(
            v[1].files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["UD-Q5_K_XL/m-UD-Q5_K_XL-00001-of-00002.gguf", "UD-Q5_K_XL/m-UD-Q5_K_XL-00002-of-00002.gguf"],
            "the first piece first"
        );
    }

    #[test]
    fn without_a_quantization_in_the_name_the_variant_is_named_like_the_file() {
        let v = variants(&repo_with(vec![f("final-model.gguf", 10)]));
        assert_eq!(v[0].name, "final-model");
    }

    #[test]
    fn the_image_encoder_prefers_f16() {
        assert_eq!(image_encoder(&[f("m.gguf", 1)]), None);
        let r = [f("mmproj-BF16.gguf", 5), f("mmproj-F16.gguf", 6), f("mmproj-F32.gguf", 9), f("m.gguf", 1)];
        assert_eq!(image_encoder(&r).unwrap().path, "mmproj-F16.gguf");
        let r = [f("sub/mmproj-F32.gguf", 9), f("mmproj-BF16.gguf", 5)];
        assert_eq!(image_encoder(&r).unwrap().path, "mmproj-BF16.gguf", "without F16, the smallest");
    }
}
