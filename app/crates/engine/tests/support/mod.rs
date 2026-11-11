//! The HTTP client of the tests: a reply of any status is a reply to read (the manager's error replies are part of what is tested).

use serde_json::Value;

pub type Reply = ureq::http::Response<ureq::Body>;

fn agent(url: &str) -> ureq::Agent {
    ureq::Agent::new_with_config(mango_common::internet::config(url).http_status_as_error(false).build())
}

pub fn get(url: &str, headers: &[(&str, &str)]) -> Reply {
    let mut request = ureq::http::Request::get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    agent(url).run(request.body(()).unwrap()).unwrap()
}

pub fn post(url: &str, headers: &[(&str, &str)], body: &str) -> Reply {
    let mut request = ureq::http::Request::post(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    agent(url).run(request.body(body.to_string()).unwrap()).unwrap()
}

pub fn code_of(reply: &Reply) -> u16 {
    reply.status().as_u16()
}

pub fn content_type(reply: &Reply) -> Option<&str> {
    reply.headers().get("content-type")?.to_str().ok()
}

pub fn text_of(mut reply: Reply) -> String {
    reply.body_mut().read_to_string().unwrap()
}

pub fn json_of(mut reply: Reply) -> Value {
    serde_json::from_reader(reply.body_mut().as_reader()).unwrap()
}

/// The reply, if it succeeded; otherwise the test fails and says what the server answered.
pub fn ok(reply: Reply) -> Reply {
    assert!(reply.status().is_success(), "the server answered {}", reply.status());
    reply
}
