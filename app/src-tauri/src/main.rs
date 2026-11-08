// No console: it is an app with a window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mango_code_lib::run()
}
