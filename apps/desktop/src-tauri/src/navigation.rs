//! Para onde a janela principal pode navegar.
//!
//! A janela só mostra o Atlas (mesma origem de `atlasUrl`), as páginas locais do app e o login
//! do Google (o Atlas web entra com Google por redirecionamento). Qualquer outro link http(s)
//! abre no navegador padrão; o resto (file:, data:, javascript:, protocolos de outros apps) é
//! bloqueado. Nenhuma dessas origens tem acesso a comandos do Tauri: o app não declara
//! capability `remote`.

use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDecision {
    /// Carrega na própria janela.
    Allow,
    /// Abre no navegador padrão e cancela a navegação na janela.
    OpenExternal,
    /// Cancela sem abrir nada.
    Block,
}

/// Origens de login que precisam rodar dentro da janela para a sessão ficar no app.
/// O pareamento por navegador + deep link (etapa #99) vai tornar isto desnecessário.
const IN_APP_AUTH_ORIGINS: &[&str] = &["https://accounts.google.com"];

pub fn decide_navigation(target: &Url, atlas: &Url) -> NavDecision {
    if is_local_app_url(target) || same_origin(target, atlas) {
        return NavDecision::Allow;
    }
    match target.scheme() {
        "about" if matches!(target.path(), "blank" | "srcdoc") => NavDecision::Allow,
        "https" if is_in_app_auth(target) => NavDecision::Allow,
        "http" | "https" | "mailto" | "tel" => NavDecision::OpenExternal,
        _ => NavDecision::Block,
    }
}

/// Páginas embutidas no app (splash/offline). No Windows o Tauri serve em
/// `http://tauri.localhost`; no Linux/macOS, em `tauri://localhost`.
fn is_local_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn is_in_app_auth(url: &Url) -> bool {
    IN_APP_AUTH_ORIGINS
        .iter()
        .filter_map(|o| Url::parse(o).ok())
        .any(|allowed| same_origin(url, &allowed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atlas() -> Url {
        Url::parse("https://atlas.exemplo.com/").unwrap()
    }

    fn decide(raw: &str) -> NavDecision {
        decide_navigation(&Url::parse(raw).unwrap(), &atlas())
    }

    #[test]
    fn mesma_origem_do_atlas_fica_na_janela() {
        assert_eq!(decide("https://atlas.exemplo.com/"), NavDecision::Allow);
        assert_eq!(decide("https://atlas.exemplo.com/p/chat?id=1#x"), NavDecision::Allow);
        assert_eq!(decide("https://atlas.exemplo.com:443/v1/auth"), NavDecision::Allow);
    }

    #[test]
    fn origem_parecida_nao_e_a_mesma() {
        assert_eq!(decide("https://atlas.exemplo.com.evil.io/"), NavDecision::OpenExternal);
        assert_eq!(decide("https://evil.io/atlas.exemplo.com"), NavDecision::OpenExternal);
        assert_eq!(decide("http://atlas.exemplo.com/"), NavDecision::OpenExternal);
        assert_eq!(decide("https://atlas.exemplo.com:8443/"), NavDecision::OpenExternal);
        assert_eq!(decide("https://sub.atlas.exemplo.com/"), NavDecision::OpenExternal);
    }

    #[test]
    fn paginas_locais_do_app_ficam_na_janela() {
        assert_eq!(decide("tauri://localhost/index.html?target=x"), NavDecision::Allow);
        assert_eq!(decide("http://tauri.localhost/index.html"), NavDecision::Allow);
        assert_eq!(decide("tauri://evil/index.html"), NavDecision::Block);
    }

    #[test]
    fn links_externos_abrem_no_navegador() {
        assert_eq!(decide("https://github.com/ali-ali18/Atlas"), NavDecision::OpenExternal);
        assert_eq!(decide("http://exemplo.com"), NavDecision::OpenExternal);
        assert_eq!(decide("mailto:oi@exemplo.com"), NavDecision::OpenExternal);
        assert_eq!(decide("tel:+5511999999999"), NavDecision::OpenExternal);
    }

    #[test]
    fn login_do_google_fica_na_janela() {
        assert_eq!(
            decide("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
            NavDecision::Allow
        );
        assert_eq!(
            decide("https://accounts.google.com.evil.io/"),
            NavDecision::OpenExternal
        );
        assert_eq!(decide("http://accounts.google.com/"), NavDecision::OpenExternal);
    }

    #[test]
    fn esquemas_perigosos_sao_bloqueados() {
        for raw in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "blob:https://atlas.exemplo.com/123",
            "ms-settings:privacy",
            "about:config",
        ] {
            assert_eq!(decide(raw), NavDecision::Block, "{raw}");
        }
    }

    #[test]
    fn about_blank_e_srcdoc_sao_permitidos() {
        assert_eq!(decide("about:blank"), NavDecision::Allow);
        assert_eq!(decide("about:srcdoc"), NavDecision::Allow);
    }

    #[test]
    fn atlas_local_em_dev() {
        let dev = Url::parse("http://localhost:3000/").unwrap();
        let go = |raw: &str| decide_navigation(&Url::parse(raw).unwrap(), &dev);
        assert_eq!(go("http://localhost:3000/p/chat"), NavDecision::Allow);
        assert_eq!(go("http://localhost:4000/"), NavDecision::OpenExternal);
    }
}
