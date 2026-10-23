fn main() {
    // ATLAS_URL vira o endereço padrão embutido no binário (o settings.json local pode trocar).
    // Valida aqui para um release com URL errada falhar no build, não na máquina do usuário.
    println!("cargo:rerun-if-env-changed=ATLAS_URL");
    if let Some(url) = std::env::var("ATLAS_URL").ok().filter(|u| !u.trim().is_empty()) {
        let ok =
            url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1");
        if !ok || url.contains('@') || url.chars().any(char::is_whitespace) {
            panic!("ATLAS_URL inválida para o app desktop: use https:// (ou http://localhost em dev), sem credenciais");
        }
    }
    tauri_build::build()
}
