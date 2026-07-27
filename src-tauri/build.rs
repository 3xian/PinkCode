fn main() {
    // tauri_build embeds icons/icon.ico into the Windows PE resource, but by
    // default only re-runs when tauri.conf.json changes. Without these, a
    // plain `tauri dev` after regenerating icons keeps the old resource.lib.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build()
}
