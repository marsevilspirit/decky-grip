use grip_sidecar::guide_html::{localize_guide_images, parse_guide_html, sanitize_fragment};

const PUBLIC_GUIDE_FIXTURE: &str = r#"<!doctype html>
<html>
  <body>
    <div class="workshopItemTitle">P4G 社群 &amp; 支线流程</div>
    <div class="guideAuthors">By 测试作者 and 1 collaborator</div>
    <div class="guide subSections">
      <div class="subSection detailBox" id="7667220">
        <div class="subSectionTitle">四月</div>
        <div class="subSectionDesc">
          <div class="bb_h3" onclick="steal()">4/23</div>
          去河堤下方与老人对话<br>
          <strong style="color:red">保存后继续</strong>
          <a class="bb_link" href="javascript:alert(1)" onfocus="steal()">坏链接</a>
          <a class="bb_link" href="https://steamcommunity.com/sharedfiles/filedetails/?id=1">来源</a>
          <img class="bb_img" src="https://images.steamusercontent.com/ugc/example/image.png" onerror="steal()">
          <img src="https://evil.example/tracker.png">
          <table class="bb_table" onclick="steal()"><tbody><tr class="bb_table_tr"><td class="bb_table_td">日期</td><th class="bb_table_th">行动</th></tr></tbody></table>
          <script>window.pwned = true</script>
          <iframe src="https://steamcommunity.com/">iframe text</iframe>
        </div>
      </div>
      <div class="subSection detailBox" id="7725867">
        <div class="subSectionTitle">五月</div>
        <div class="subSectionDesc"><div class="bb_h3">5/1</div>白天</div>
      </div>
    </div>
  </body>
</html>
"#;

fn guide_with_single_section(section_html: &str) -> String {
    format!(
        "<div class=\"workshopItemTitle\">预算测试指南</div>\
         <div class=\"guideAuthors\">By 测试作者</div>\
         <div class=\"subSection\" id=\"1\">\
         <div class=\"subSectionTitle\">唯一章节</div>\
         <div class=\"subSectionDesc\">{section_html}</div></div>"
    )
}

#[test]
fn extracts_public_guide_and_sanitizes_html() {
    let document = parse_guide_html("3414883877", PUBLIC_GUIDE_FIXTURE).unwrap();
    let sections = document["sections"].as_array().unwrap();

    assert_eq!(document["guideId"].as_str(), Some("3414883877"));
    assert_eq!(document["title"].as_str(), Some("P4G 社群 & 支线流程"));
    assert_eq!(
        document["author"].as_str(),
        Some("测试作者 and 1 collaborator")
    );
    assert_eq!(
        document["sourceUrl"].as_str(),
        Some("https://steamcommunity.com/sharedfiles/filedetails/?id=3414883877&l=schinese")
    );
    assert_eq!(
        sections
            .iter()
            .map(|section| section["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["7667220", "7725867"]
    );

    let first = sections[0]["html"].as_str().unwrap();
    for safe in [
        r#"<div class="bb_h3">4/23</div>"#,
        "去河堤下方与老人对话<br>",
        "<strong>保存后继续</strong>",
        r#"<a class="bb_link">来源</a>"#,
        r#"src="https://images.steamusercontent.com/ugc/example/image.png""#,
        r#"<tr class="bb_table_tr">"#,
        r#"<td class="bb_table_td">日期</td>"#,
        r#"<th class="bb_table_th">行动</th>"#,
    ] {
        assert!(first.contains(safe), "missing safe fragment: {safe}");
    }
    for unsafe_fragment in [
        "onclick",
        "onfocus",
        "onerror",
        "style=",
        "javascript:",
        "href=",
        "rel=",
        "evil.example",
        "window.pwned",
        "iframe text",
        "<script",
        "<iframe",
    ] {
        assert!(
            !first.contains(unsafe_fragment),
            "retained unsafe fragment: {unsafe_fragment}"
        );
    }
}

#[test]
fn rejects_non_guide_and_invalid_ids() {
    assert!(parse_guide_html("3414883877", "<html><body>sign in</body></html>").is_err());
    for guide_id in ["", "0", "../1", "1&x=2", "١"] {
        assert!(
            parse_guide_html(guide_id, PUBLIC_GUIDE_FIXTURE).is_err(),
            "accepted invalid guide ID: {guide_id}"
        );
    }
}

#[test]
fn sanitizer_preserves_tolerant_tokenizer_behavior() {
    assert_eq!(
        sanitize_fragment(
            "text &amp; more<div DATA-X='1>2' disabled>body\
             <script>if (left < right) { value = '&amp;'; }</ScRiPt >\
             <br /></div>tail"
        )
        .unwrap(),
        "text &amp; more<div>body<br></div>tail"
    );
    assert_eq!(
        sanitize_fragment("<div title='left>right'>body").unwrap(),
        r#"<div title="left&gt;right">body</div>"#
    );
    assert_eq!(
        sanitize_fragment("<div title='left>").unwrap(),
        "&lt;div title='left&gt;"
    );
    assert_eq!(
        sanitize_fragment("<script><img onerror=bad></scriptx></ſcript>safe</SCRIPT ><p>after")
            .unwrap(),
        "<p>after</p>"
    );
    assert_eq!(
        sanitize_fragment("before<!-- ignored forever").unwrap(),
        "before"
    );
    assert_eq!(sanitize_fragment("<style>a < b &amp; c").unwrap(), "");
    assert_eq!(sanitize_fragment("x<!broken").unwrap(), "x&lt;!broken");
}

#[test]
fn void_drop_content_tag_does_not_discard_following_content() {
    assert_eq!(
        sanitize_fragment(r#"<p>before</p><embed src="https://evil.example/media"><p>after</p>"#)
            .unwrap(),
        "<p>before</p><p>after</p>"
    );
}

#[test]
fn localizes_only_valid_images_without_attribute_order_assumptions() {
    let fragment = concat!(
        "<p>before</p>",
        "<img width='640' src='https://images.steamusercontent.com/ugc/",
        "example/image.png?x=1&amp;y=2' alt='A &amp; B' loading='lazy' ",
        "class='bb_img'>",
        "<img src='https://evil.example/image.png' loading='lazy'>",
        "<img src='https://images.steamusercontent.com/a.png' ",
        "loading='lazy' onerror='bad'>"
    );

    let localized = localize_guide_images(fragment);

    assert_eq!(
        localized,
        concat!(
            r#"<p>before</p><img alt="A &amp; B" class="bb_img" "#,
            r#"data-grip-image-url="https://images.steamusercontent.com/ugc/"#,
            r#"example/image.png?x=1&amp;y=2" loading="lazy" width="640">"#
        )
    );
    assert!(!localized.contains(" src="));
    assert!(!localized.contains("evil.example"));
    assert!(!localized.contains("onerror"));
}

#[test]
fn enforces_real_section_mount_budgets() {
    let cases = [
        ("nodes", "<br>".repeat(8_001), "node budget"),
        ("text", "x".repeat(1_048_577), "text budget"),
        (
            "escaped output",
            "&amp;".repeat(2_097_152 / 5 + 1),
            "output budget",
        ),
    ];

    for (label, section_html, expected) in cases {
        let error = parse_guide_html("3414883877", &guide_with_single_section(&section_html))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(expected),
            "{label} returned unexpected error: {error}"
        );
    }

    let nested = format!("{}x{}", "<div>".repeat(129), "</div>".repeat(129));
    let error = sanitize_fragment(&nested).unwrap_err().to_string();
    assert!(error.contains("nesting depth budget"), "{error}");
}

#[test]
fn rejects_the_513th_section() {
    let sections = (1..=513)
        .map(|id| {
            format!(
                "<div class=\"subSection\" id=\"{id}\">\
                 <div class=\"subSectionTitle\">标题</div>\
                 <div class=\"subSectionDesc\">正文</div></div>"
            )
        })
        .collect::<String>();
    let source = format!(
        "<div class=\"workshopItemTitle\">指南</div>\
         <div class=\"guideAuthors\">By 作者</div><div>{sections}</div>"
    );

    let error = parse_guide_html("3414883877", &source)
        .unwrap_err()
        .to_string();
    assert!(error.contains("too many sections"), "{error}");
}
