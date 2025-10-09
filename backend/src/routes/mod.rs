use axum::http::HeaderValue;
use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{delete, get, patch, post},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::{auth::AuthenticatedUser, state::AppState};

pub mod auth;
pub mod correspondents;
pub mod documents;
pub mod folders;
pub mod health;
pub mod tags;
pub mod webdav;

pub fn create_router(state: AppState) -> Router<()> {
    let cors = if let Some(origins) = state.config.cors_allowed_origin.as_ref() {
        let headers: Vec<HeaderValue> = origins
            .split(',')
            .filter_map(|value| {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| {
                    trimmed
                        .parse::<HeaderValue>()
                        .expect("invalid CORS allowed origin")
                })
            })
            .collect();

        let allow_origin = AllowOrigin::list(headers);

        CorsLayer::new()
            .allow_origin(allow_origin)
            .allow_methods(tower_http::cors::AllowMethods::mirror_request())
            .allow_headers(tower_http::cors::AllowHeaders::mirror_request())
            .allow_credentials(true)
    } else {
        CorsLayer::new()
            .allow_origin(AllowOrigin::mirror_request())
            .allow_methods(tower_http::cors::AllowMethods::mirror_request())
            .allow_headers(tower_http::cors::AllowHeaders::mirror_request())
            .allow_credentials(true)
    };

    let auth_routes = Router::new()
        .route("/login", post(auth::login))
        .route("/refresh", post(auth::refresh))
        .route("/logout", post(auth::logout))
        .route("/me", get(auth::me));

    let documents_routes = Router::new()
        .route(
            "/",
            get(documents::list_documents).post(documents::upload_document),
        )
        .route("/reanalyze", post(documents::reanalyze_all_documents))
        .route("/bulk/move", post(documents::bulk_move_documents))
        .route("/bulk/tags", post(documents::bulk_update_tags))
        .route(
            "/bulk/correspondents",
            post(documents::bulk_assign_correspondents),
        )
        .route(
            "/bulk/reanalyze",
            post(documents::reanalyze_selected_documents),
        )
        .route(
            "/:id",
            get(documents::get_document)
                .delete(documents::delete_document)
                .patch(documents::update_document),
        )
        .route("/:id/download", get(documents::download_document))
        .route("/:id/assets/:asset_id", get(documents::get_document_asset))
        .route(
            "/:id/assets",
            get(documents::list_document_assets).post(documents::request_document_assets),
        )
        .route("/:id/folder", patch(documents::move_document))
        .route("/:id/tags", post(documents::assign_tags))
        .route("/:id/tags/:tag_id", delete(documents::remove_tag))
        .route(
            "/:id/correspondents",
            post(documents::assign_correspondents),
        )
        .route(
            "/:id/correspondents/:correspondent_id",
            delete(documents::remove_correspondent),
        );

    let download_routes =
        Router::new().route("/download/:token", get(documents::download_with_token));

    let folders_routes = Router::new()
        .route("/", post(folders::create_folder))
        .route("/path", post(folders::ensure_folder_path))
        .route(
            "/:id",
            delete(folders::delete_folder).patch(folders::update_folder),
        )
        .route("/:id/contents", get(folders::list_folder_contents));

    let tags_routes = Router::new()
        .route("/", get(tags::list_tags).post(tags::create_tag))
        .route("/:id", patch(tags::update_tag).delete(tags::delete_tag));

    let correspondents_routes = Router::new()
        .route(
            "/",
            get(correspondents::list_correspondents).post(correspondents::create_correspondent),
        )
        .route(
            "/:id",
            patch(correspondents::update_correspondent)
                .delete(correspondents::delete_correspondent),
        );

    let protected_state = state.clone();
    let protected_routes = Router::new()
        .nest("/api/documents", documents_routes)
        .nest("/api/folders", folders_routes)
        .nest("/api/tags", tags_routes)
        .nest("/api/correspondents", correspondents_routes)
        .layer(middleware::from_extractor_with_state::<AuthenticatedUser, _>(protected_state));

    Router::new()
        .merge(download_routes)
        .merge(protected_routes)
        .nest("/api/auth", auth_routes)
        .route("/api/health", get(health::health_check))
        .with_state(state)
        .layer(cors)
        .layer(DefaultBodyLimit::max(1024 * 1024 * 512))
}
