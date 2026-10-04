use axum::{
    body::Body,
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::Response,
};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

pub async fn serve(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Body::empty())
            .unwrap();
    }
    let path = uri.path().trim_start_matches('/');
    let asset = ASSETS.iter().find(|a| a.0 == path).or_else(|| {
        // SPA routes may use index.html; missing resources and API routes must remain 404.
        if path == "api"
            || path.starts_with("api/")
            || path.rsplit('/').next().is_some_and(|p| p.contains('.'))
        {
            None
        } else {
            ASSETS.iter().find(|a| a.0 == "index.html")
        }
    });
    let Some((name, bytes, mime, etag)) = asset else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.split(',').any(|t| t.trim() == *etag || t.trim() == "*"));
    Response::builder()
        .status(if not_modified {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, *mime)
        .header(header::ETAG, *etag)
        .header(
            header::CACHE_CONTROL,
            if name.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .header("x-content-type-options", "nosniff")
        .body(if not_modified || method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(*bytes)
        })
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn embedded_assets_cache_and_missing_routes() {
        let root = serve(Method::GET, Uri::from_static("/"), HeaderMap::new()).await;
        assert_eq!(root.status(), StatusCode::OK);
        assert_eq!(root.headers()[header::CACHE_CONTROL], "no-cache");
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, root.headers()[header::ETAG].clone());
        assert_eq!(
            serve(Method::GET, Uri::from_static("/"), headers)
                .await
                .status(),
            StatusCode::NOT_MODIFIED
        );
        let wasm = serve(
            Method::GET,
            Uri::from_static("/rules.wasm"),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(wasm.headers()[header::CONTENT_TYPE], "application/wasm");
        for path in ["/missing.js", "/api/missing"] {
            assert_eq!(
                serve(Method::GET, path.parse().unwrap(), HeaderMap::new())
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            serve(
                Method::GET,
                Uri::from_static("/table/1234"),
                HeaderMap::new()
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            serve(Method::POST, Uri::from_static("/"), HeaderMap::new())
                .await
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
}
