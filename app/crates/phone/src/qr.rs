//! A link's QR, as SVG: black on white with the margin readers ask for.

use qrcodegen::{QrCode, QrCodeEcc};

pub(crate) fn svg(text: &str) -> String {
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium).expect("a link fits in a QR");
    let margin = 4;
    let side = qr.size() + 2 * margin;
    let modules: String = (0..qr.size())
        .flat_map(|y| (0..qr.size()).map(move |x| (x, y)))
        .filter(|&(x, y)| qr.get_module(x, y))
        .map(|(x, y)| format!("M{},{}h1v1h-1z", x + margin, y + margin))
        .collect();
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {side} {side}\" shape-rendering=\"crispEdges\">\
<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/><path d=\"{modules}\" fill=\"#000\"/></svg>"
    )
}
