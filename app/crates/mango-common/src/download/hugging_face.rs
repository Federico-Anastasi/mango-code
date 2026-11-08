//! Hugging Face for «Other models»: search for a model, recognize a link, list the GGUF files of a repo (with size
//! and sha256 hash, as the public API gives them) and read the start of a GGUF to know what it asks of memory. The
//! real download is `install_model`, from the catalog.

use super::{http_agent, hugging_face_token, HF};
use crate::tr;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Duration;

/// How long Hugging Face may stay silent before a call is given up.
const MAX_WAIT: Duration = Duration::from_secs(30);

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

/// Recognizes a link to a repo (`https://huggingface.co/p/n`, `.../blob/main/f.gguf`, `hf.co/p/n:Q4_K_M`) or a
/// plain `owner/name`. Anything else (a word to search for, a link elsewhere) is `None`.
pub fn parse_reference(text: &str) -> Option<Reference> {
    let t = text.trim();
    let without_scheme = t.strip_prefix("https://").or_else(|| t.strip_prefix("http://"));
    let after_host = ["huggingface.co/", "hf.co/"].iter().find_map(|h| without_scheme.unwrap_or(t).strip_prefix(h));
    let (path, from_link) = match (after_host, without_scheme) {
        (Some(p), _) => (p, true),
        (None, None) => (t, false),
        (None, Some(_)) => return None,
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
        Some(&("blob" | "resolve")) if parts.len() > 4 => (Some(parts[3]), Some(parts[4..].join("/"))),
        Some(&("tree" | "blob" | "resolve")) if parts.len() > 3 => (Some(parts[3]), None),
        _ => (None, None),
    };
    Some(Reference { repo: format!("{}/{name}", parts[0]), path, quant, revision: revision.filter(|r| *r != "main").map(String::from) })
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_encoder(f: &HfFile) -> bool {
    file_name(&f.path).to_ascii_lowercase().starts_with("mmproj")
}

/// A piece of a split model: the name without `-00001-of-00003.gguf` and the piece number.
fn piece(path: &str) -> Option<(&str, u32)> {
    let (rest, total) = path.strip_suffix(".gguf")?.rsplit_once("-of-")?;
    let (base, n) = rest.rsplit_once('-')?;
    let digits = |s: &str| s.len() == 5 && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(n) || !digits(total) {
        return None;
    }
    Some((base, n.parse().ok()?))
}

fn is_quantization(t: &str) -> bool {
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
            Some((b, n)) => (b.to_string(), n),
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

/// The repo's image encoder (`mmproj*.gguf`), if any: F16 if there is more than one, otherwise the smallest.
pub fn image_encoder(repo: &Repo) -> Option<HfFile> {
    let encoders: Vec<&HfFile> = repo.files.iter().filter(|f| is_encoder(f)).collect();
    let f16 = encoders.iter().find(|f| file_name(&f.path).split(['-', '.', '_']).any(|p| p.eq_ignore_ascii_case("f16")));
    f16.or_else(|| encoders.iter().min_by_key(|f| f.size)).map(|f| (*f).clone())
}

/// Searches GGUF models by name, most downloaded first.
pub fn search(text: &str) -> Result<Vec<SearchResult>> {
    search_at(HF.trim_end_matches('/'), text)
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
    repo_at(HF.trim_end_matches('/'), id, revision)
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
    let info: Info = get_json(&format!("{base}/api/models/{id}/revision/{}", revision.unwrap_or("main")))?;
    let mut files = Vec::new();
    let mut page = Some(format!("{base}/api/models/{id}/tree/{}?recursive=true", info.sha));
    while let Some(url) = page {
        let response = get(&url, None)?;
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

/// The first `bytes` bytes of a repo file: a GGUF's header (metadata and tensors) is there, without the weights.
pub fn file_start(repo: &Repo, file: &HfFile, bytes: usize) -> Result<Vec<u8>> {
    file_start_at(HF.trim_end_matches('/'), repo, file, bytes)
}

fn file_start_at(base: &str, repo: &Repo, file: &HfFile, bytes: usize) -> Result<Vec<u8>> {
    let path: Vec<String> = file.path.split('/').map(encode).collect();
    let url = format!("{base}/{}/resolve/{}/{}", repo.id, repo.revision, path.join("/"));
    let mut v = Vec::new();
    // The server may reply with the whole file (206 or 200): only the start is read.
    get(&url, Some(&format!("bytes=0-{}", bytes.saturating_sub(1))))?
        .into_body()
        .into_reader()
        .take(bytes as u64)
        .read_to_end(&mut v)
        .with_context(|| tr!("lettura di {}", "reading {}", file.path))?;
    Ok(v)
}

/// Checks that Hugging Face recognizes the token.
pub fn verify_token(token: &str) -> Result<()> {
    verify_token_at(HF.trim_end_matches('/'), token)
}

fn verify_token_at(base: &str, token: &str) -> Result<()> {
    match http_agent(Some(MAX_WAIT)).get(&format!("{base}/api/whoami-v2")).header("Authorization", format!("Bearer {token}")).call() {
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

/// GET of `url` with the Hugging Face token (if any) and, if needed, a range; status errors become sentences.
fn get(url: &str, range: Option<&str>) -> Result<ureq::http::Response<ureq::Body>> {
    let mut request = http_agent(Some(MAX_WAIT)).get(url);
    if let Some(i) = range {
        request = request.header("Range", i);
    }
    if let Some(token) = hugging_face_token(url) {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    match request.call() {
        Ok(r) => Ok(r),
        Err(ureq::Error::StatusCode(c @ (401 | 403))) => bail!(
            "{}",
            tr!(
                "Hugging Face risponde {c} per {url}: il modello è protetto. Accetta i termini sulla sua pagina su Hugging Face e salva il tuo token qui sotto.",
                "Hugging Face answers {c} for {url}: the model is gated. Accept the terms on its Hugging Face page and save your token below."
            )
        ),
        Err(ureq::Error::StatusCode(404)) => bail!(
            "{}",
            tr!("Hugging Face risponde 404: {url} non esiste (o è privato)", "Hugging Face answers 404: {url} doesn't exist (or is private)")
        ),
        Err(ureq::Error::StatusCode(429)) => bail!(
            "{}",
            tr!("Hugging Face chiede di rallentare (429): riprova fra un minuto", "Hugging Face asks to slow down (429): try again in a minute")
        ),
        Err(ureq::Error::StatusCode(c)) => bail!("{}", tr!("Hugging Face risponde {c} per {url}", "Hugging Face answers {c} for {url}")),
        Err(e) => bail!("{}", tr!("rete: {e}", "network: {e}")),
    }
}

fn get_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    let body = get(url, None)?.into_body().read_to_string().with_context(|| tr!("lettura di {url}", "reading {url}"))?;
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

    #[test]
    fn the_start_of_the_file_is_read_without_downloading_all_of_it() {
        let body: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let sha = "c".repeat(40);
        let s = FakeServer::start([(&format!("/p/n/resolve/{sha}/Q4/m.gguf"), Route::file(body.clone()))]);
        let repo = Repo { id: "p/n".into(), revision: sha, gated: false, files: vec![] };
        let f = HfFile { path: "Q4/m.gguf".into(), size: body.len() as u64, sha256: "0".repeat(64) };
        assert_eq!(file_start_at(&s.url, &repo, &f, 4096).unwrap(), body[..4096]);
        assert_eq!(file_start_at(&s.url, &repo, &f, 1 << 20).unwrap(), body, "if the file is shorter, whatever there is");
        assert_eq!(s.requests()[0].range.as_deref(), Some("bytes=0-4095"));
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

    #[test]
    fn anything_else_is_not_a_reference() {
        for t in ["", "qwen 3 4b", "qwen3", "https://github.com/Qwen/Qwen3", "https://huggingface.co/", "https://huggingface.co/Qwen", "a/b/c", "https://huggingface.co/datasets/a/b"] {
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
        assert_eq!(image_encoder(&repo_with(vec![f("m.gguf", 1)])), None);
        let r = repo_with(vec![f("mmproj-BF16.gguf", 5), f("mmproj-F16.gguf", 6), f("mmproj-F32.gguf", 9), f("m.gguf", 1)]);
        assert_eq!(image_encoder(&r).unwrap().path, "mmproj-F16.gguf");
        let r = repo_with(vec![f("sub/mmproj-F32.gguf", 9), f("mmproj-BF16.gguf", 5)]);
        assert_eq!(image_encoder(&r).unwrap().path, "mmproj-BF16.gguf", "without F16, the smallest");
    }
}
