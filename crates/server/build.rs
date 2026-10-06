use std::{
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("无法读取前端构建目录") {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../web/dist");
    println!("cargo:rerun-if-changed={}", root.display());
    assert!(
        root.join("index.html").is_file(),
        "前端未构建：请先运行 npm ci 和 npm run build，再编译服务端"
    );
    let mut files = vec![];
    collect(&root, &mut files);
    files.sort();
    let mut output = String::from("pub static ASSETS: &[(&str, &[u8], &str, &str)] = &[\n");
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        let name = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let mime = match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
            "html" => "text/html; charset=utf-8",
            "js" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "wasm" => "application/wasm",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "json" => "application/json",
            "webmanifest" => "application/manifest+json",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        fs::read(&path).unwrap().hash(&mut hash);
        let etag = format!("\"{:016x}\"", hash.finish());
        output.push_str(&format!(
            "({name:?}, include_bytes!({:?}), {mime:?}, {etag:?}),\n",
            path.canonicalize().unwrap().to_str().unwrap()
        ));
    }
    output.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("assets.rs"),
        output,
    )
    .unwrap();
}
