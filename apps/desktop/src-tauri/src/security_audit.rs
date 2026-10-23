//! Testes de regressão da configuração de segurança (ADR 0001, seção Segurança).
//! Falham se alguém liberar IPC para a origem remota, ligar plugins de shell/fs ou tirar a CSP.

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn conf() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json válido")
    }

    fn capability_files() -> Vec<(String, Value)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| matches!(p.extension().and_then(|x| x.to_str()), Some("json" | "toml")))
            .map(|p| {
                let raw = std::fs::read_to_string(&p).unwrap();
                let value = if p.extension().and_then(|x| x.to_str()) == Some("json") {
                    serde_json::from_str(&raw).unwrap()
                } else {
                    // TOML não é usado hoje; trata como texto para a checagem de "remote".
                    Value::String(raw)
                };
                (p.display().to_string(), value)
            })
            .collect()
    }

    #[test]
    fn nenhuma_capability_libera_a_origem_remota() {
        for (path, cap) in capability_files() {
            let text = cap.to_string();
            assert!(!text.contains("remote"), "{path} declara acesso remoto");
        }
        let inline = conf()["app"]["security"]["capabilities"].clone();
        assert!(
            inline.is_null() || inline == Value::Array(vec![]),
            "capabilities inline no tauri.conf.json"
        );
    }

    #[test]
    fn nenhuma_permissao_de_shell_fs_ou_processo() {
        for (path, cap) in capability_files() {
            let text = cap.to_string();
            for forbidden in ["shell:", "fs:", "process:", "http:", "updater:", "global-shortcut:"] {
                assert!(!text.contains(forbidden), "{path} libera {forbidden}");
            }
        }
    }

    #[test]
    fn sem_api_global_e_com_csp_restrita() {
        let conf = conf();
        assert_eq!(conf["app"]["withGlobalTauri"], Value::Bool(false));
        let csp = conf["app"]["security"]["csp"].as_str().expect("CSP definida");
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("unsafe-eval"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn plugins_de_shell_nao_estao_nas_dependencias() {
        let cargo = include_str!("../Cargo.toml");
        for forbidden in [
            "tauri-plugin-shell",
            "tauri-plugin-fs",
            "tauri-plugin-http",
            "tauri-plugin-process",
        ] {
            assert!(
                !cargo.contains(forbidden),
                "{forbidden} não deve ser dependência direta nesta etapa"
            );
        }
    }

    #[test]
    fn updater_usa_https_e_github_releases() {
        let conf = conf();
        let endpoints = conf["plugins"]["updater"]["endpoints"].as_array().expect("endpoints");
        assert!(!endpoints.is_empty());
        for e in endpoints {
            let url = e.as_str().unwrap();
            assert!(
                url.starts_with("https://github.com/ali-ali18/agent-bot/releases/"),
                "{url}"
            );
        }
        assert!(conf["plugins"]["updater"]["dangerousInsecureTransportProtocol"].is_null());
    }
}
