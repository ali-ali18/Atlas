//! Configurações locais do app (`settings.json` na pasta de configuração do usuário).
//!
//! O arquivo é opcional e editado à mão por enquanto (a tela de configurações vem depois).
//! Qualquer campo ausente, inválido ou de tipo errado cai no padrão, com um aviso: o app nunca
//! deixa de abrir por causa de um settings.json quebrado.

use std::path::Path;

use serde_json::{json, Map, Value};
use url::Url;

pub const SETTINGS_FILENAME: &str = "settings.json";
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";
const MAX_FIELD_LENGTH: usize = 2048;
const MAX_SHORTCUT_LENGTH: usize = 64;

/// URL do Atlas embutida na compilação (`ATLAS_URL`), validada no build.rs.
pub fn compiled_atlas_url() -> Url {
    // Vazia conta como ausente (variável do CI não definida).
    let raw = option_env!("ATLAS_URL")
        .filter(|u| !u.trim().is_empty())
        .unwrap_or("http://localhost:3000");
    validate_atlas_url(raw).unwrap_or_else(|_| Url::parse("http://localhost:3000").expect("URL fixa válida"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Endereço do Atlas web que a janela principal carrega.
    pub atlas_url: Url,
    /// Atalho global para mostrar a janela. `None` = desligado.
    pub global_shortcut: Option<String>,
}

impl Settings {
    pub fn defaults(atlas_url: Url) -> Self {
        Self {
            atlas_url,
            global_shortcut: Some(DEFAULT_SHORTCUT.to_string()),
        }
    }
}

/// Aceita `https://` em qualquer host e `http://` só em localhost (desenvolvimento).
/// Recusa credenciais na URL, que acabariam em log e na barra de título.
pub fn validate_atlas_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_FIELD_LENGTH {
        return Err("atlasUrl vazia ou longa demais".into());
    }
    let url = Url::parse(trimmed).map_err(|e| format!("atlasUrl inválida: {e}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("atlasUrl não pode ter usuário ou senha".into());
    }
    match url.scheme() {
        "https" if url.host_str().is_some() => Ok(url),
        "http" if is_loopback_host(&url) => Ok(url),
        "http" => Err("atlasUrl com http só é aceita para localhost; use https".into()),
        other => Err(format!("atlasUrl com esquema não suportado: {other}")),
    }
}

fn is_loopback_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// Lê o conteúdo do settings.json (ou `None` se não existe) e devolve as configurações
/// efetivas mais os avisos do que foi ignorado.
pub fn parse_settings(raw: Option<&str>, default_url: &Url) -> (Settings, Vec<String>) {
    let mut settings = Settings::defaults(default_url.clone());
    let mut warnings = Vec::new();
    let Some(raw) = raw else {
        return (settings, warnings);
    };
    if raw.trim().is_empty() {
        return (settings, warnings);
    }
    let obj = match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(obj)) => obj,
        Ok(_) => {
            warnings.push("settings.json não é um objeto JSON; usando o padrão".into());
            return (settings, warnings);
        }
        Err(e) => {
            warnings.push(format!("settings.json inválido ({e}); usando o padrão"));
            return (settings, warnings);
        }
    };

    match obj.get("atlasUrl") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => match validate_atlas_url(s) {
            Ok(url) => settings.atlas_url = url,
            Err(e) => warnings.push(format!("{e}; usando {default_url}")),
        },
        Some(_) => warnings.push("atlasUrl precisa ser texto; usando o padrão".into()),
    }

    match obj.get("globalShortcut") {
        None => {}
        // null ou "" desliga o atalho.
        Some(Value::Null) => settings.global_shortcut = None,
        Some(Value::String(s)) if s.trim().is_empty() => settings.global_shortcut = None,
        Some(Value::String(s)) if s.trim().len() <= MAX_SHORTCUT_LENGTH => {
            settings.global_shortcut = Some(s.trim().to_string())
        }
        Some(Value::String(_)) => warnings.push("globalShortcut longo demais; usando o padrão".into()),
        Some(_) => warnings.push("globalShortcut precisa ser texto ou null; usando o padrão".into()),
    }

    (settings, warnings)
}

/// Modelo gravado na primeira execução, para o usuário achar o que pode mudar.
pub fn settings_template(default_url: &Url) -> String {
    let mut obj = Map::new();
    obj.insert("atlasUrl".into(), json!(default_url.as_str()));
    obj.insert("globalShortcut".into(), json!(DEFAULT_SHORTCUT));
    let mut out = serde_json::to_string_pretty(&Value::Object(obj)).unwrap_or_default();
    out.push('\n');
    out
}

/// Carrega o settings.json do disco. Se não existir, grava o modelo (melhor esforço).
pub fn load_settings(path: &Path, default_url: &Url) -> (Settings, Vec<String>) {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse_settings(Some(&raw), default_url),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut warnings = Vec::new();
            let written = path
                .parent()
                .map(std::fs::create_dir_all)
                .unwrap_or(Ok(()))
                .and_then(|_| std::fs::write(path, settings_template(default_url)));
            if let Err(e) = written {
                warnings.push(format!("não foi possível criar {}: {e}", path.display()));
            }
            let (settings, mut more) = parse_settings(None, default_url);
            warnings.append(&mut more);
            (settings, warnings)
        }
        Err(e) => {
            let (settings, _) = parse_settings(None, default_url);
            (
                settings,
                vec![format!("não foi possível ler {}: {e}; usando o padrão", path.display())],
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_url() -> Url {
        Url::parse("https://atlas.exemplo.com/").unwrap()
    }

    #[test]
    fn sem_arquivo_usa_padroes() {
        let (s, w) = parse_settings(None, &default_url());
        assert_eq!(s, Settings::defaults(default_url()));
        assert_eq!(s.global_shortcut.as_deref(), Some(DEFAULT_SHORTCUT));
        assert!(w.is_empty());
    }

    #[test]
    fn arquivo_vazio_usa_padroes_sem_aviso() {
        let (s, w) = parse_settings(Some("  \n"), &default_url());
        assert_eq!(s, Settings::defaults(default_url()));
        assert!(w.is_empty());
    }

    #[test]
    fn le_url_e_atalho_validos() {
        let raw = r#"{"atlasUrl":"https://meu.atlas.app/app","globalShortcut":"Alt+Space"}"#;
        let (s, w) = parse_settings(Some(raw), &default_url());
        assert_eq!(s.atlas_url.as_str(), "https://meu.atlas.app/app");
        assert_eq!(s.global_shortcut.as_deref(), Some("Alt+Space"));
        assert!(w.is_empty());
    }

    #[test]
    fn json_quebrado_ou_nao_objeto_cai_no_padrao_com_aviso() {
        for raw in ["{atlasUrl:", "[1,2]", "\"texto\""] {
            let (s, w) = parse_settings(Some(raw), &default_url());
            assert_eq!(s, Settings::defaults(default_url()), "{raw}");
            assert_eq!(w.len(), 1, "{raw}");
        }
    }

    #[test]
    fn url_invalida_mantem_padrao_e_avisa() {
        for bad in [
            "ftp://atlas.exemplo.com",
            "javascript:alert(1)",
            "file:///C:/Windows",
            "http://atlas.exemplo.com",
            "https://user:senha@atlas.exemplo.com",
            "não é url",
            "",
        ] {
            let raw = serde_json::json!({ "atlasUrl": bad }).to_string();
            let (s, w) = parse_settings(Some(&raw), &default_url());
            assert_eq!(s.atlas_url, default_url(), "{bad}");
            assert_eq!(w.len(), 1, "{bad}");
        }
    }

    #[test]
    fn http_so_em_localhost() {
        assert!(validate_atlas_url("http://localhost:3000").is_ok());
        assert!(validate_atlas_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_atlas_url("http://[::1]:3000").is_ok());
        assert!(validate_atlas_url("http://192.168.0.10:3000").is_err());
        assert!(validate_atlas_url("https://192.168.0.10:3000").is_ok());
    }

    #[test]
    fn tipo_errado_avisa_e_mantem_padrao() {
        let raw = r#"{"atlasUrl":42,"globalShortcut":true}"#;
        let (s, w) = parse_settings(Some(raw), &default_url());
        assert_eq!(s, Settings::defaults(default_url()));
        assert_eq!(w.len(), 2);
    }

    #[test]
    fn atalho_null_ou_vazio_desliga() {
        for raw in [r#"{"globalShortcut":null}"#, r#"{"globalShortcut":"   "}"#] {
            let (s, w) = parse_settings(Some(raw), &default_url());
            assert_eq!(s.global_shortcut, None, "{raw}");
            assert!(w.is_empty());
        }
    }

    #[test]
    fn atalho_longo_demais_mantem_padrao() {
        let raw = serde_json::json!({ "globalShortcut": "A+".repeat(40) }).to_string();
        let (s, w) = parse_settings(Some(&raw), &default_url());
        assert_eq!(s.global_shortcut.as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn campos_desconhecidos_sao_ignorados() {
        let raw = r#"{"atlasUrl":null,"tema":"escuro"}"#;
        let (s, w) = parse_settings(Some(raw), &default_url());
        assert_eq!(s, Settings::defaults(default_url()));
        assert!(w.is_empty());
    }

    #[test]
    fn modelo_gravado_volta_igual_aos_padroes() {
        let template = settings_template(&default_url());
        let (s, w) = parse_settings(Some(&template), &default_url());
        assert_eq!(s, Settings::defaults(default_url()));
        assert!(w.is_empty());
    }

    #[test]
    fn load_cria_modelo_quando_nao_existe() {
        let dir = std::env::temp_dir().join(format!("atlas-desktop-test-{}", std::process::id()));
        let path = dir.join(SETTINGS_FILENAME);
        let _ = std::fs::remove_dir_all(&dir);
        let (s, w) = load_settings(&path, &default_url());
        assert_eq!(s, Settings::defaults(default_url()));
        assert!(w.is_empty(), "{w:?}");
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("atlasUrl"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn url_compilada_e_valida() {
        let url = compiled_atlas_url();
        assert!(validate_atlas_url(url.as_str()).is_ok());
    }
}
