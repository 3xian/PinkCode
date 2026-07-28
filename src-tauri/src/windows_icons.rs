//! Windows window / taskbar icons.
//!
//! Tauri embeds `icons/icon.ico` into the PE resource, but the *runtime*
//! window icon path (`CachedIcon::new_ico`) only keeps ICO entry[0] as a
//! single RGBA bitmap and applies it via `ICON_SMALL`. The shell then scales
//! that one frame for the taskbar (`ICON_BIG`) → soft / blurry glyphs on
//! 125–200% DPI.
//!
//! After the window exists, reload native sizes from the multi-resolution
//! PE icon so title-bar and taskbar each get a crisp rung.

// Gated at the `mod` site in lib.rs (`#[cfg(windows)] mod windows_icons`).

use tauri::{Manager, WebviewWindow};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, SM_CXICON,
    SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
};

/// Resource id written by tauri-winres (`32512 ICON "…/icon.ico"`).
const IDI_APPICON: u16 = 32512;

/// Apply multi-size PE icons to every window that currently exists.
pub fn apply_to_app(app: &tauri::App) {
    for window in app.webview_windows().values() {
        apply_to_window(window);
    }
}

pub fn apply_to_window(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    apply_to_hwnd(hwnd);
}

fn apply_to_hwnd(hwnd: HWND) {
    // Prefer per-window DPI metrics so 125/150/200% pick the right ICO rung.
    let (sm_w, sm_h, big_w, big_h) = unsafe {
        let dpi = GetDpiForWindow(hwnd);
        if dpi > 0 {
            (
                GetSystemMetricsForDpi(SM_CXSMICON, dpi),
                GetSystemMetricsForDpi(SM_CYSMICON, dpi),
                GetSystemMetricsForDpi(SM_CXICON, dpi),
                GetSystemMetricsForDpi(SM_CYICON, dpi),
            )
        } else {
            (
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
                GetSystemMetrics(SM_CXICON),
                GetSystemMetrics(SM_CYICON),
            )
        }
    };

    let small = load_app_icon(sm_w, sm_h);
    let big = load_app_icon(big_w, big_h);

    unsafe {
        if let Some(icon) = small {
            let _ = SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_SMALL as usize)),
                Some(LPARAM(icon.0 as isize)),
            );
        }
        if let Some(icon) = big {
            let _ = SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_BIG as usize)),
                Some(LPARAM(icon.0 as isize)),
            );
        }
    }
}

fn load_app_icon(
    width: i32,
    height: i32,
) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    if width <= 0 || height <= 0 {
        return None;
    }

    unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).ok()?;
        // MAKEINTRESOURCE: low word is the numeric id.
        let name = PCWSTR(IDI_APPICON as usize as *const u16);
        // Sized load from the multi-res PE ICO. Do not DestroyIcon while the
        // window still references the handle (process-lifetime leak of 2 icons).
        let handle = LoadImageW(
            Some(module.into()),
            name,
            IMAGE_ICON,
            width,
            height,
            Default::default(),
        )
        .ok()?;
        Some(windows::Win32::UI::WindowsAndMessaging::HICON(handle.0))
    }
}
