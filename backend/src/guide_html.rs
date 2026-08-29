use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fmt;
use url::Url;

pub(crate) const MAX_SECTIONS: usize = 512;
pub(crate) const MAX_PAGE_NODES: usize = 200_000;
pub(crate) const MAX_PAGE_DEPTH: usize = 128;
pub(crate) const MAX_PAGE_TEXT_CHARS: usize = 8 * 1024 * 1024;
pub(crate) const MAX_LABEL_CHARS: usize = 4_096;
pub(crate) const MAX_SANITIZED_HTML_BYTES: usize = 12 * 1024 * 1024;
pub(crate) const MAX_FRAGMENT_NODES: usize = 8_000;
pub(crate) const MAX_FRAGMENT_DEPTH: usize = 128;
pub(crate) const MAX_FRAGMENT_TEXT_CHARS: usize = 1024 * 1024;
pub(crate) const MAX_FRAGMENT_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

const MAX_MARKUP_CHARS: usize = 16_384;
const MAX_ATTRIBUTES: usize = 256;
const MAX_CHARACTER_REFERENCE_CHARS: usize = 64;

type Attributes = Vec<(String, Option<String>)>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuideHtmlError(String);

impl GuideHtmlError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for GuideHtmlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for GuideHtmlError {}

#[derive(Debug)]
struct TokenizerError(&'static str);

impl fmt::Display for TokenizerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

#[derive(Debug)]
enum ParseFailure {
    Tokenizer(TokenizerError),
    Sink(GuideHtmlError),
}

fn public_parse_error(error: ParseFailure, malformed: &'static str) -> GuideHtmlError {
    match error {
        ParseFailure::Sink(error) => error,
        ParseFailure::Tokenizer(error) => {
            let _detail = error.0;
            GuideHtmlError::new(malformed)
        }
    }
}

impl From<TokenizerError> for ParseFailure {
    fn from(error: TokenizerError) -> Self {
        Self::Tokenizer(error)
    }
}

impl From<GuideHtmlError> for ParseFailure {
    fn from(error: GuideHtmlError) -> Self {
        Self::Sink(error)
    }
}

trait HtmlSink {
    fn handle_starttag(
        &mut self,
        _tag: &str,
        _attributes: Attributes,
    ) -> Result<(), GuideHtmlError> {
        Ok(())
    }

    fn handle_startendtag(
        &mut self,
        tag: &str,
        attributes: Attributes,
    ) -> Result<(), GuideHtmlError> {
        self.handle_starttag(tag, attributes)?;
        self.handle_endtag(tag)
    }

    fn handle_endtag(&mut self, _tag: &str) -> Result<(), GuideHtmlError> {
        Ok(())
    }

    fn handle_data(&mut self, _data: &str) -> Result<(), GuideHtmlError> {
        Ok(())
    }
}

struct HtmlParser<S> {
    sink: S,
    buffer: String,
    rawtext_tag: Option<&'static str>,
    deferred_data: Vec<String>,
    #[cfg(test)]
    compactions: usize,
}

impl<S: HtmlSink> HtmlParser<S> {
    fn new(sink: S) -> Self {
        Self {
            sink,
            buffer: String::new(),
            rawtext_tag: None,
            deferred_data: Vec::new(),
            #[cfg(test)]
            compactions: 0,
        }
    }

    fn feed(&mut self, data: &str) -> Result<(), ParseFailure> {
        self.buffer.push_str(data);
        self.parse_available(false)
    }

    fn close(&mut self) -> Result<(), ParseFailure> {
        self.parse_available(true)?;
        self.emit_data("")
    }

    fn into_sink(self) -> S {
        self.sink
    }

    fn emit_data(&mut self, data: &str) -> Result<(), ParseFailure> {
        if self.deferred_data.is_empty() && data.is_empty() {
            return Ok(());
        }
        let joined;
        let raw = if self.deferred_data.is_empty() {
            data
        } else {
            self.deferred_data.push(data.to_owned());
            joined = self.deferred_data.concat();
            self.deferred_data.clear();
            &joined
        };
        if raw.is_empty() {
            return Ok(());
        }
        let decoded = html_escape::decode_html_entities(raw);
        self.sink.handle_data(&decoded).map_err(ParseFailure::Sink)
    }

    fn defer_data(&mut self, data: &str) {
        if !data.is_empty() {
            self.deferred_data.push(data.to_owned());
        }
    }

    fn parse_available(&mut self, final_input: bool) -> Result<(), ParseFailure> {
        let source = std::mem::take(&mut self.buffer);
        let mut offset = 0;
        while offset < source.len() {
            if let Some(tag) = self.rawtext_tag {
                match find_rawtext_end(&source, offset, tag, final_input) {
                    Some(end) => {
                        self.emit_data(&source[offset..end])?;
                        offset = end;
                        self.rawtext_tag = None;
                        continue;
                    }
                    None if final_input => {
                        self.emit_data(&source[offset..])?;
                        offset = source.len();
                    }
                    None => {
                        let safe_end = rawtext_safe_end(&source, offset, tag);
                        self.defer_data(&source[offset..safe_end]);
                        offset = safe_end;
                    }
                }
                break;
            }

            let Some(relative_markup) = source[offset..].find('<') else {
                if final_input {
                    self.emit_data(&source[offset..])?;
                    offset = source.len();
                } else {
                    let safe_end = safe_text_end(&source, offset);
                    self.defer_data(&source[offset..safe_end]);
                    offset = safe_end;
                }
                break;
            };
            let markup = offset + relative_markup;
            if markup > offset {
                self.emit_data(&source[offset..markup])?;
                offset = markup;
            } else if !self.deferred_data.is_empty() {
                self.emit_data("")?;
            }

            let Some(consumed) = self.consume_markup(&source, offset, final_input)? else {
                break;
            };
            offset = consumed;
        }

        if offset > 0 {
            #[cfg(test)]
            {
                self.compactions += 1;
            }
            self.buffer.push_str(&source[offset..]);
        } else {
            self.buffer = source;
        }
        Ok(())
    }

    fn consume_markup(
        &mut self,
        source: &str,
        start: usize,
        final_input: bool,
    ) -> Result<Option<usize>, ParseFailure> {
        if source[start..].starts_with("<!--") {
            if let Some(relative_end) = source[start + 4..].find("-->") {
                return Ok(Some(start + 4 + relative_end + 3));
            }
            if source[start..].chars().count() > MAX_MARKUP_CHARS {
                return Err(TokenizerError("HTML comment exceeds the size limit").into());
            }
            return Ok(final_input.then_some(source.len()));
        }

        if source[start..].starts_with("<!") || source[start..].starts_with("<?") {
            let tag_start = start + 2;
            return match tag_end(source, tag_start)? {
                Some(end) => Ok(Some(end + 1)),
                None if !final_input => Ok(None),
                None => {
                    self.emit_data("<")?;
                    Ok(Some(start + 1))
                }
            };
        }

        if source[start..].starts_with("</") {
            let name_start = start + 2;
            let Some(name_end) = tag_name_end(source, name_start) else {
                if !final_input && name_start == source.len() {
                    return Ok(None);
                }
                self.emit_data("<")?;
                return Ok(Some(start + 1));
            };
            return match tag_end(source, name_end)? {
                Some(end) => {
                    let tag = source[name_start..name_end].to_ascii_lowercase();
                    self.sink.handle_endtag(&tag)?;
                    Ok(Some(end + 1))
                }
                None if !final_input => Ok(None),
                None => {
                    self.emit_data("<")?;
                    Ok(Some(start + 1))
                }
            };
        }

        let name_start = start + 1;
        let Some(name_end) = tag_name_end(source, name_start) else {
            if !final_input && name_start == source.len() {
                return Ok(None);
            }
            self.emit_data("<")?;
            return Ok(Some(start + 1));
        };
        let Some(end) = tag_end(source, name_end)? else {
            if !final_input {
                return Ok(None);
            }
            self.emit_data("<")?;
            return Ok(Some(start + 1));
        };

        let tag = source[name_start..name_end].to_ascii_lowercase();
        let raw_attributes = &source[name_end..end];
        let stripped = raw_attributes.trim_end_matches(char::is_whitespace);
        let self_closing = stripped.strip_suffix('/').is_some_and(|before| {
            before.is_empty()
                || before.chars().next_back().is_some_and(|character| {
                    character.is_whitespace() || matches!(character, '\'' | '"')
                })
        });
        let attribute_source = if self_closing {
            &stripped[..stripped.len() - 1]
        } else {
            raw_attributes
        };
        let attributes = parse_attributes(attribute_source)?;
        if self_closing {
            self.sink.handle_startendtag(&tag, attributes)?;
        } else {
            self.sink.handle_starttag(&tag, attributes)?;
            self.rawtext_tag = match tag.as_str() {
                "script" => Some("script"),
                "style" => Some("style"),
                _ => None,
            };
        }
        Ok(Some(end + 1))
    }
}

fn tag_name_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let first = *bytes.get(start)?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let mut end = start + 1;
    while bytes.get(end).is_some_and(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
    }) {
        end += 1;
    }
    Some(end)
}

fn tag_end(source: &str, start: usize) -> Result<Option<usize>, TokenizerError> {
    let mut quote = None;
    for (seen, (relative, character)) in source[start..].char_indices().enumerate() {
        if seen > MAX_MARKUP_CHARS {
            return Err(TokenizerError("HTML tag exceeds the size limit"));
        }
        if let Some(expected) = quote {
            if character == expected {
                quote = None;
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character == '>' {
            return Ok(Some(start + relative));
        }
    }
    if source[start..].chars().count() > MAX_MARKUP_CHARS {
        Err(TokenizerError("HTML tag exceeds the size limit"))
    } else {
        Ok(None)
    }
}

fn parse_attributes(source: &str) -> Result<Attributes, TokenizerError> {
    if source.chars().count() > MAX_MARKUP_CHARS {
        return Err(TokenizerError("HTML tag exceeds the size limit"));
    }
    let mut attributes = Vec::new();
    let mut index = 0;
    while index < source.len() {
        index = skip_whitespace(source, index);
        if index >= source.len() {
            break;
        }
        if source[index..].starts_with('/') {
            index += 1;
            continue;
        }

        let name_start = index;
        while let Some((character, next)) = char_at(source, index) {
            if character.is_whitespace() || matches!(character, '=' | '/' | '>' | '"' | '\'') {
                break;
            }
            index = next;
        }
        if index == name_start {
            index = char_at(source, index).map_or(source.len(), |(_, next)| next);
            continue;
        }
        let name = source[name_start..index].to_lowercase();
        index = skip_whitespace(source, index);

        let mut value = None;
        if source[index..].starts_with('=') {
            index += 1;
            index = skip_whitespace(source, index);
            let raw;
            if let Some((quote @ ('\'' | '"'), next)) = char_at(source, index) {
                index = next;
                let value_start = index;
                while let Some((character, next)) = char_at(source, index) {
                    if character == quote {
                        break;
                    }
                    index = next;
                }
                raw = &source[value_start..index];
                if index < source.len() {
                    index = char_at(source, index).map_or(source.len(), |(_, next)| next);
                }
            } else {
                let value_start = index;
                while let Some((character, next)) = char_at(source, index) {
                    if character.is_whitespace() {
                        break;
                    }
                    index = next;
                }
                raw = &source[value_start..index];
            }
            value = Some(html_escape::decode_html_entities(raw).into_owned());
        }
        attributes.push((name, value));
        if attributes.len() > MAX_ATTRIBUTES {
            return Err(TokenizerError("HTML tag contains too many attributes"));
        }
    }
    Ok(attributes)
}

fn char_at(source: &str, index: usize) -> Option<(char, usize)> {
    let character = source[index..].chars().next()?;
    Some((character, index + character.len_utf8()))
}

fn skip_whitespace(source: &str, mut index: usize) -> usize {
    while let Some((character, next)) = char_at(source, index) {
        if !character.is_whitespace() {
            break;
        }
        index = next;
    }
    index
}

fn safe_text_end(source: &str, start: usize) -> usize {
    let Some(relative_ampersand) = source[start..].rfind('&') else {
        return source.len();
    };
    let ampersand = start + relative_ampersand;
    let candidate = &source[ampersand..];
    if candidate.chars().count() <= MAX_CHARACTER_REFERENCE_CHARS
        && possible_character_reference(candidate)
    {
        ampersand
    } else {
        source.len()
    }
}

fn possible_character_reference(candidate: &str) -> bool {
    let Some(rest) = candidate.strip_prefix('&') else {
        return false;
    };
    if let Some(numeric) = rest.strip_prefix('#') {
        let digits = numeric
            .strip_prefix('x')
            .or_else(|| numeric.strip_prefix('X'))
            .unwrap_or(numeric);
        digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    } else {
        rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
    }
}

fn rawtext_safe_end(source: &str, start: usize, tag: &str) -> usize {
    let closing = format!("</{tag}");
    let available = &source[start..];
    for size in (1..=closing.len().min(available.len())).rev() {
        let suffix_start = available.len() - size;
        if available.is_char_boundary(suffix_start)
            && closing
                .as_bytes()
                .starts_with(&available.as_bytes()[suffix_start..].to_ascii_lowercase())
        {
            return source.len() - size;
        }
    }
    source.len()
}

fn find_rawtext_end(source: &str, start: usize, tag: &str, final_input: bool) -> Option<usize> {
    let closing = format!("</{tag}");
    let bytes = source.as_bytes();
    let mut search = start;
    while search < source.len() {
        let relative = source[search..].find("</")?;
        let candidate = search + relative;
        let end = candidate + closing.len();
        if end <= source.len()
            && bytes[candidate..end].eq_ignore_ascii_case(closing.as_bytes())
            && (end == source.len()
                || source[end..]
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_whitespace() || character == '>'))
        {
            if !final_input && end == source.len() {
                return None;
            }
            return Some(candidate);
        }
        search = candidate + 2;
    }
    None
}

fn is_void_tag(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn drops_content(tag: &str) -> bool {
    matches!(
        tag,
        "script" | "style" | "iframe" | "object" | "embed" | "form" | "svg" | "math" | "template"
    )
}

fn allowed_tag(tag: &str) -> bool {
    matches!(
        tag,
        "a" | "b"
            | "blockquote"
            | "br"
            | "code"
            | "div"
            | "em"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "hr"
            | "i"
            | "img"
            | "li"
            | "ol"
            | "p"
            | "pre"
            | "s"
            | "span"
            | "strike"
            | "strong"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "tr"
            | "u"
            | "ul"
    )
}

fn allowed_class(class: &str) -> bool {
    matches!(
        class,
        "bb_blockquote"
            | "bb_code"
            | "bb_h1"
            | "bb_h2"
            | "bb_h3"
            | "bb_h4"
            | "bb_h5"
            | "bb_h6"
            | "bb_img"
            | "bb_link"
            | "bb_ol"
            | "bb_table"
            | "bb_table_td"
            | "bb_table_th"
            | "bb_table_tr"
            | "bb_ul"
    )
}

fn escape_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn escape_attribute(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#x27;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn normalized_decimal(value: &str) -> Option<String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed = value.parse::<u32>().ok()?;
    (parsed > 0 && parsed <= 16_384).then(|| parsed.to_string())
}

fn is_allowed_image_host(hostname: &str) -> bool {
    ["steamstatic.com", "steamusercontent.com"]
        .iter()
        .any(|suffix| hostname == *suffix || hostname.ends_with(&format!(".{suffix}")))
}

fn canonical_image_url(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 4_096
        || value.bytes().any(|byte| {
            !(0x21..=0x7e).contains(&byte)
                || matches!(
                    byte,
                    b'<' | b'>' | b'"' | b'{' | b'}' | b'|' | b'\\' | b'^' | b'`'
                )
        })
    {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    if !parsed.scheme().eq_ignore_ascii_case("https")
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
    {
        return None;
    }

    let scheme_end = value.find("://")?;
    let remainder = &value[scheme_end + 3..];
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.starts_with('[') {
        return None;
    }
    let (raw_host, explicit_port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if explicit_port.is_some_and(|port| port != "443") {
        return None;
    }
    let hostname = raw_host.trim_end_matches('.').to_ascii_lowercase();
    if hostname.is_empty() || !is_allowed_image_host(&hostname) {
        return None;
    }
    parsed.host_str()?;

    let mut canonical = format!("https://{hostname}");
    if explicit_port.is_some() {
        canonical.push_str(":443");
    }
    canonical.push_str(parsed.path());
    if let Some(query) = parsed.query() {
        canonical.push('?');
        canonical.push_str(query);
    }
    Some(canonical)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FragmentStats {
    pub(crate) nodes: usize,
    pub(crate) text_chars: usize,
    pub(crate) output_bytes: usize,
}

struct FragmentSanitizer {
    parts: Vec<String>,
    stack: Vec<(String, bool)>,
    open_counts: HashMap<String, usize>,
    drop_depth: usize,
    node_count: usize,
    text_chars: usize,
    output_bytes: usize,
}

impl FragmentSanitizer {
    fn new() -> Self {
        Self {
            parts: Vec::new(),
            stack: Vec::new(),
            open_counts: HashMap::new(),
            drop_depth: 0,
            node_count: 0,
            text_chars: 0,
            output_bytes: 0,
        }
    }

    fn record_node(&mut self) -> Result<(), GuideHtmlError> {
        self.node_count += 1;
        if self.node_count > MAX_FRAGMENT_NODES {
            return Err(GuideHtmlError::new("guide HTML exceeds the node budget"));
        }
        Ok(())
    }

    fn record_text(&mut self, data: &str) -> Result<(), GuideHtmlError> {
        self.text_chars += data.chars().count();
        if self.text_chars > MAX_FRAGMENT_TEXT_CHARS {
            return Err(GuideHtmlError::new("guide HTML exceeds the text budget"));
        }
        Ok(())
    }

    fn append(&mut self, part: String) -> Result<(), GuideHtmlError> {
        self.output_bytes += part.len();
        if self.output_bytes > MAX_FRAGMENT_OUTPUT_BYTES {
            return Err(GuideHtmlError::new("guide HTML exceeds the output budget"));
        }
        self.parts.push(part);
        Ok(())
    }

    fn push(&mut self, tag: &str, emitted: bool) -> Result<(), GuideHtmlError> {
        if self.stack.len() >= MAX_FRAGMENT_DEPTH {
            return Err(GuideHtmlError::new(
                "guide HTML exceeds the nesting depth budget",
            ));
        }
        self.stack.push((tag.to_owned(), emitted));
        *self.open_counts.entry(tag.to_owned()).or_default() += 1;
        Ok(())
    }

    fn pop(&mut self) -> (String, bool) {
        let (tag, emitted) = self.stack.pop().expect("fragment stack was checked");
        let count = self
            .open_counts
            .get_mut(&tag)
            .expect("fragment open count matches stack");
        *count -= 1;
        if *count == 0 {
            self.open_counts.remove(&tag);
        }
        (tag, emitted)
    }

    fn serialize_attributes(tag: &str, attributes: Attributes) -> Option<String> {
        let mut values = BTreeMap::new();
        for (name, value) in attributes {
            if let Some(value) = value {
                values.insert(name.to_lowercase(), value);
            }
        }
        let mut serialized = BTreeMap::new();

        let classes: HashSet<_> = values
            .get("class")
            .into_iter()
            .flat_map(|value| value.split_whitespace())
            .filter(|class| allowed_class(class))
            .collect();
        if !classes.is_empty() {
            let mut classes: Vec<_> = classes.into_iter().collect();
            classes.sort_unstable();
            serialized.insert("class", classes.join(" "));
        }

        for name in ["title", "alt"] {
            if let Some(value) = values
                .get(name)
                .filter(|value| value.chars().count() <= 1_024)
            {
                serialized.insert(name, value.clone());
            }
        }
        for name in ["width", "height", "colspan", "rowspan"] {
            if let Some(value) = values.get(name).and_then(|value| normalized_decimal(value)) {
                serialized.insert(name, value);
            }
        }

        if tag == "img" {
            let source = values
                .get("src")
                .and_then(|value| canonical_image_url(value))?;
            serialized.insert("loading", "lazy".to_owned());
            serialized.insert("src", source);
        }

        Some(
            serialized
                .into_iter()
                .map(|(name, value)| format!(" {name}=\"{}\"", escape_attribute(&value)))
                .collect(),
        )
    }

    fn finish(mut self) -> Result<(String, FragmentStats), GuideHtmlError> {
        while !self.stack.is_empty() {
            let (tag, emitted) = self.pop();
            if self.drop_depth > 0 {
                if drops_content(&tag) {
                    self.drop_depth -= 1;
                }
            } else if emitted {
                self.append(format!("</{tag}>"))?;
            }
        }
        self.drop_depth = 0;
        let html = self.parts.concat().trim().to_owned();
        Ok((
            html,
            FragmentStats {
                nodes: self.node_count,
                text_chars: self.text_chars,
                output_bytes: self.output_bytes,
            },
        ))
    }
}

impl HtmlSink for FragmentSanitizer {
    fn handle_starttag(&mut self, tag: &str, attributes: Attributes) -> Result<(), GuideHtmlError> {
        self.record_node()?;
        if self.drop_depth > 0 {
            if drops_content(tag) && !is_void_tag(tag) {
                self.drop_depth += 1;
            }
            if !is_void_tag(tag) {
                self.push(tag, false)?;
            }
            return Ok(());
        }
        if drops_content(tag) {
            if !is_void_tag(tag) {
                self.drop_depth = 1;
                self.push(tag, false)?;
            }
            return Ok(());
        }

        let mut emitted = allowed_tag(tag);
        let serialized = emitted.then(|| Self::serialize_attributes(tag, attributes));
        if let Some(Some(attributes)) = serialized {
            self.append(format!("<{tag}{attributes}>"))?;
        } else {
            emitted = false;
        }
        if !is_void_tag(tag) {
            self.push(tag, emitted)?;
        }
        Ok(())
    }

    fn handle_endtag(&mut self, tag: &str) -> Result<(), GuideHtmlError> {
        if self.open_counts.get(tag).copied().unwrap_or(0) == 0 {
            return Ok(());
        }
        while !self.stack.is_empty() {
            let (open_tag, emitted) = self.pop();
            if self.drop_depth > 0 {
                if drops_content(&open_tag) {
                    self.drop_depth -= 1;
                }
            } else if emitted {
                self.append(format!("</{open_tag}>"))?;
            }
            if open_tag == tag {
                break;
            }
        }
        Ok(())
    }

    fn handle_data(&mut self, data: &str) -> Result<(), GuideHtmlError> {
        if data.is_empty() {
            return Ok(());
        }
        self.record_node()?;
        self.record_text(data)?;
        if self.drop_depth == 0 {
            self.append(escape_text(data))?;
        }
        Ok(())
    }
}

pub(crate) fn sanitize_fragment_with_stats(
    fragment: &str,
) -> Result<(String, FragmentStats), GuideHtmlError> {
    let mut parser = HtmlParser::new(FragmentSanitizer::new());
    parser
        .feed(fragment)
        .map_err(|error| public_parse_error(error, "guide contains malformed HTML"))?;
    parser
        .close()
        .map_err(|error| public_parse_error(error, "guide contains malformed HTML"))?;
    parser.into_sink().finish()
}

pub fn sanitize_fragment(fragment: &str) -> Result<String, GuideHtmlError> {
    sanitize_fragment_with_stats(fragment).map(|(html, _)| html)
}

#[derive(Default)]
struct ImageTagSink {
    attributes: Option<Attributes>,
    invalid: bool,
}

impl HtmlSink for ImageTagSink {
    fn handle_starttag(&mut self, tag: &str, attributes: Attributes) -> Result<(), GuideHtmlError> {
        if tag != "img" || self.attributes.is_some() {
            self.invalid = true;
        } else {
            self.attributes = Some(attributes);
        }
        Ok(())
    }

    fn handle_startendtag(
        &mut self,
        tag: &str,
        attributes: Attributes,
    ) -> Result<(), GuideHtmlError> {
        self.handle_starttag(tag, attributes)
    }

    fn handle_endtag(&mut self, _tag: &str) -> Result<(), GuideHtmlError> {
        self.invalid = true;
        Ok(())
    }

    fn handle_data(&mut self, data: &str) -> Result<(), GuideHtmlError> {
        if !data.is_empty() {
            self.invalid = true;
        }
        Ok(())
    }
}

fn localized_image_tag(source: &str) -> String {
    let mut parser = HtmlParser::new(ImageTagSink::default());
    if parser.feed(source).is_err() || parser.close().is_err() {
        return String::new();
    }
    let sink = parser.into_sink();
    let Some(attributes) = sink.attributes else {
        return String::new();
    };
    if sink.invalid {
        return String::new();
    }

    let mut values = BTreeMap::new();
    for (name, value) in attributes {
        if !matches!(
            name.as_str(),
            "alt" | "class" | "height" | "loading" | "src" | "title" | "width"
        ) || values.contains_key(&name)
        {
            return String::new();
        }
        let Some(value) = value else {
            return String::new();
        };
        values.insert(name, value);
    }
    if values.get("loading").map(String::as_str) != Some("lazy") {
        return String::new();
    }
    let Some(source) = values
        .get("src")
        .and_then(|value| canonical_image_url(value))
    else {
        return String::new();
    };

    if let Some(classes) = values.get_mut("class") {
        let tokens: Vec<_> = classes.split_whitespace().collect();
        if tokens.is_empty() || tokens.iter().any(|token| !allowed_class(token)) {
            return String::new();
        }
        let mut unique: Vec<_> = tokens
            .into_iter()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        unique.sort_unstable();
        *classes = unique.join(" ");
    }
    for name in ["title", "alt"] {
        if values
            .get(name)
            .is_some_and(|value| value.chars().count() > 1_024)
        {
            return String::new();
        }
    }
    for name in ["width", "height"] {
        if let Some(value) = values.get_mut(name) {
            let Some(normalized) = normalized_decimal(value) else {
                return String::new();
            };
            *value = normalized;
        }
    }

    values.remove("src");
    values.insert("data-grip-image-url".to_owned(), source);
    let attributes: String = values
        .into_iter()
        .map(|(name, value)| format!(" {name}=\"{}\"", escape_attribute(&value)))
        .collect();
    format!("<img{attributes}>")
}

fn find_image_start(fragment: &str, offset: usize) -> Option<usize> {
    let bytes = fragment.as_bytes();
    let mut search = offset;
    while search < fragment.len() {
        let relative = fragment[search..].find('<')?;
        let candidate = search + relative;
        let name_end = candidate + 4;
        if name_end <= fragment.len()
            && bytes[candidate..name_end].eq_ignore_ascii_case(b"<img")
            && (name_end == fragment.len()
                || fragment[name_end..]
                    .chars()
                    .next()
                    .is_some_and(|character| {
                        character.is_whitespace() || matches!(character, '/' | '>')
                    }))
        {
            return Some(candidate);
        }
        search = candidate + 1;
    }
    None
}

pub fn localize_guide_images(fragment: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut offset = 0;
    loop {
        let Some(start) = find_image_start(fragment, offset) else {
            parts.push(fragment[offset..].to_owned());
            break;
        };
        parts.push(fragment[offset..start].to_owned());
        let mut quote = None;
        let mut end = None;
        for (relative, character) in fragment[start + 4..].char_indices() {
            if let Some(expected) = quote {
                if character == expected {
                    quote = None;
                }
            } else if matches!(character, '\'' | '"') {
                quote = Some(character);
            } else if character == '>' {
                end = Some(start + 4 + relative + 1);
                break;
            }
        }
        let Some(end) = end else {
            break;
        };
        parts.push(localized_image_tag(&fragment[start..end]));
        offset = end;
    }
    parts.concat()
}

#[derive(Default)]
struct WorkingSection {
    id: String,
    title: Option<String>,
    html: Option<String>,
}

struct GuideSection {
    id: String,
    title: String,
    html: String,
}

struct GuidePageParser {
    stack: Vec<String>,
    open_counts: HashMap<String, usize>,
    title_depth: Option<usize>,
    author_depth: Option<usize>,
    section_root_depth: Option<usize>,
    section_title_depth: Option<usize>,
    section_description_depth: Option<usize>,
    title_parts: Vec<String>,
    author_parts: Vec<String>,
    title_chars: usize,
    author_chars: usize,
    section: Option<WorkingSection>,
    section_title_parts: Vec<String>,
    section_title_chars: usize,
    sanitizer: Option<FragmentSanitizer>,
    node_count: usize,
    text_chars: usize,
    sanitized_html_bytes: usize,
    title: String,
    author: String,
    sections: Vec<GuideSection>,
}

impl GuidePageParser {
    fn new() -> Self {
        Self {
            stack: Vec::new(),
            open_counts: HashMap::new(),
            title_depth: None,
            author_depth: None,
            section_root_depth: None,
            section_title_depth: None,
            section_description_depth: None,
            title_parts: Vec::new(),
            author_parts: Vec::new(),
            title_chars: 0,
            author_chars: 0,
            section: None,
            section_title_parts: Vec::new(),
            section_title_chars: 0,
            sanitizer: None,
            node_count: 0,
            text_chars: 0,
            sanitized_html_bytes: 0,
            title: String::new(),
            author: String::new(),
            sections: Vec::new(),
        }
    }

    fn record_node(&mut self) -> Result<(), GuideHtmlError> {
        self.node_count += 1;
        if self.node_count > MAX_PAGE_NODES {
            return Err(GuideHtmlError::new("guide exceeds the node budget"));
        }
        Ok(())
    }

    fn record_text(&mut self, data: &str) -> Result<(), GuideHtmlError> {
        self.text_chars += data.chars().count();
        if self.text_chars > MAX_PAGE_TEXT_CHARS {
            return Err(GuideHtmlError::new("guide exceeds the text budget"));
        }
        Ok(())
    }

    fn push(&mut self, tag: &str) -> Result<(), GuideHtmlError> {
        if self.stack.len() >= MAX_PAGE_DEPTH {
            return Err(GuideHtmlError::new(
                "guide exceeds the nesting depth budget",
            ));
        }
        self.stack.push(tag.to_owned());
        *self.open_counts.entry(tag.to_owned()).or_default() += 1;
        Ok(())
    }

    fn pop(&mut self) -> String {
        let tag = self.stack.pop().expect("guide page stack was checked");
        let count = self
            .open_counts
            .get_mut(&tag)
            .expect("guide page open count matches stack");
        *count -= 1;
        if *count == 0 {
            self.open_counts.remove(&tag);
        }
        tag
    }

    fn append_label(
        parts: &mut Vec<String>,
        current_chars: &mut usize,
        data: &str,
        label: &str,
    ) -> Result<(), GuideHtmlError> {
        *current_chars += data.chars().count();
        if *current_chars > MAX_LABEL_CHARS {
            return Err(GuideHtmlError::new(format!(
                "guide {label} exceeds the text budget"
            )));
        }
        parts.push(data.to_owned());
        Ok(())
    }

    fn normalize_text(parts: &[String]) -> String {
        parts
            .concat()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn close_at_depth(&mut self, tag: &str, depth: usize) -> Result<(), GuideHtmlError> {
        match self.section_description_depth {
            Some(description_depth) if depth > description_depth => {
                if let Some(sanitizer) = &mut self.sanitizer {
                    sanitizer.handle_endtag(tag)?;
                }
            }
            Some(description_depth) if depth == description_depth => {
                let sanitizer = self
                    .sanitizer
                    .take()
                    .expect("section description has a sanitizer");
                let (html, stats) = sanitizer.finish()?;
                self.section
                    .as_mut()
                    .expect("section description has a section")
                    .html = Some(html);
                self.sanitized_html_bytes += stats.output_bytes;
                if self.sanitized_html_bytes > MAX_SANITIZED_HTML_BYTES {
                    return Err(GuideHtmlError::new(
                        "guide exceeds the sanitized HTML budget",
                    ));
                }
                self.section_description_depth = None;
            }
            _ => {}
        }

        if self.section_title_depth == Some(depth) {
            let title = Self::normalize_text(&self.section_title_parts);
            self.section
                .as_mut()
                .expect("section title has a section")
                .title = Some(title);
            self.section_title_parts.clear();
            self.section_title_chars = 0;
            self.section_title_depth = None;
        }
        if self.title_depth == Some(depth) {
            self.title = Self::normalize_text(&self.title_parts);
            self.title_parts.clear();
            self.title_chars = 0;
            self.title_depth = None;
        }
        if self.author_depth == Some(depth) {
            let author = Self::normalize_text(&self.author_parts);
            self.author = if author
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("by"))
                && author[2..].chars().next().is_some_and(char::is_whitespace)
            {
                author[2..].trim_start().to_owned()
            } else {
                author
            };
            self.author_parts.clear();
            self.author_chars = 0;
            self.author_depth = None;
        }

        if self.section_root_depth == Some(depth) {
            let section = self.section.take().expect("section root has a section");
            if let (Some(title), Some(html)) = (section.title, section.html) {
                if !title.is_empty() {
                    self.sections.push(GuideSection {
                        id: section.id,
                        title,
                        html,
                    });
                }
            }
            self.section_root_depth = None;
            self.section_title_depth = None;
            self.section_description_depth = None;
            self.sanitizer = None;
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), GuideHtmlError> {
        while !self.stack.is_empty() {
            let depth = self.stack.len() - 1;
            let tag = self.pop();
            self.close_at_depth(&tag, depth)?;
        }
        Ok(())
    }
}

impl HtmlSink for GuidePageParser {
    fn handle_starttag(&mut self, tag: &str, attributes: Attributes) -> Result<(), GuideHtmlError> {
        self.record_node()?;
        let depth = self.stack.len();
        if !is_void_tag(tag) && depth >= MAX_PAGE_DEPTH {
            return Err(GuideHtmlError::new(
                "guide exceeds the nesting depth budget",
            ));
        }
        let attribute_map: BTreeMap<_, _> = attributes
            .iter()
            .filter_map(|(name, value)| value.as_ref().map(|value| (name.clone(), value.clone())))
            .collect();
        let classes: HashSet<_> = attribute_map
            .get("class")
            .into_iter()
            .flat_map(|value| value.split_whitespace())
            .collect();

        if self.section.is_none()
            && tag == "div"
            && classes.contains("subSection")
            && attribute_map.get("id").is_some_and(|id| valid_guide_id(id))
        {
            if self.sections.len() >= MAX_SECTIONS {
                return Err(GuideHtmlError::new("guide contains too many sections"));
            }
            self.section = Some(WorkingSection {
                id: attribute_map["id"].clone(),
                ..WorkingSection::default()
            });
            self.section_root_depth = Some(depth);
        }

        if self.title_depth.is_none() && classes.contains("workshopItemTitle") {
            self.title_depth = Some(depth);
            self.title_parts.clear();
            self.title_chars = 0;
        }
        if self.author_depth.is_none() && classes.contains("guideAuthors") {
            self.author_depth = Some(depth);
            self.author_parts.clear();
            self.author_chars = 0;
        }

        if self.section.is_some() {
            if self.section_title_depth.is_none() && classes.contains("subSectionTitle") {
                self.section_title_depth = Some(depth);
                self.section_title_parts.clear();
                self.section_title_chars = 0;
            } else if self.section_description_depth.is_none() && classes.contains("subSectionDesc")
            {
                self.section_description_depth = Some(depth);
                self.sanitizer = Some(FragmentSanitizer::new());
            } else if self
                .section_description_depth
                .is_some_and(|description_depth| depth > description_depth)
            {
                if let Some(sanitizer) = &mut self.sanitizer {
                    sanitizer.handle_starttag(tag, attributes)?;
                }
            }
        }

        if !is_void_tag(tag) {
            self.push(tag)?;
        }
        Ok(())
    }

    fn handle_startendtag(
        &mut self,
        tag: &str,
        attributes: Attributes,
    ) -> Result<(), GuideHtmlError> {
        self.handle_starttag(tag, attributes)?;
        if !is_void_tag(tag) {
            self.handle_endtag(tag)?;
        }
        Ok(())
    }

    fn handle_endtag(&mut self, tag: &str) -> Result<(), GuideHtmlError> {
        if is_void_tag(tag) || self.open_counts.get(tag).copied().unwrap_or(0) == 0 {
            return Ok(());
        }
        while !self.stack.is_empty() {
            let depth = self.stack.len() - 1;
            let open_tag = self.pop();
            self.close_at_depth(&open_tag, depth)?;
            if open_tag == tag {
                break;
            }
        }
        Ok(())
    }

    fn handle_data(&mut self, data: &str) -> Result<(), GuideHtmlError> {
        if data.is_empty() {
            return Ok(());
        }
        self.record_node()?;
        self.record_text(data)?;
        let depth = self.stack.len().checked_sub(1);
        if depth.is_some_and(|depth| self.title_depth.is_some_and(|start| depth >= start)) {
            Self::append_label(&mut self.title_parts, &mut self.title_chars, data, "title")?;
        }
        if depth.is_some_and(|depth| self.author_depth.is_some_and(|start| depth >= start)) {
            Self::append_label(
                &mut self.author_parts,
                &mut self.author_chars,
                data,
                "author",
            )?;
        }
        if depth.is_some_and(|depth| self.section_title_depth.is_some_and(|start| depth >= start)) {
            Self::append_label(
                &mut self.section_title_parts,
                &mut self.section_title_chars,
                data,
                "section title",
            )?;
        }
        if self.section_description_depth.is_some() {
            if let Some(sanitizer) = &mut self.sanitizer {
                sanitizer.handle_data(data)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn valid_guide_id(guide_id: &str) -> bool {
    (1..=20).contains(&guide_id.len())
        && guide_id.as_bytes()[0] != b'0'
        && guide_id.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn source_url(guide_id: &str) -> String {
    format!("https://steamcommunity.com/sharedfiles/filedetails/?id={guide_id}&l=schinese")
}

pub fn parse_guide_html(guide_id: &str, source: &str) -> Result<Value, GuideHtmlError> {
    if !valid_guide_id(guide_id) {
        return Err(GuideHtmlError::new(
            "guide_id must be a positive decimal string",
        ));
    }
    let mut parser = HtmlParser::new(GuidePageParser::new());
    parser
        .feed(source)
        .map_err(|error| public_parse_error(error, "Steam returned malformed guide HTML"))?;
    parser
        .close()
        .map_err(|error| public_parse_error(error, "Steam returned malformed guide HTML"))?;
    let mut page = parser.into_sink();
    page.finish()?;
    if page.title.is_empty() || page.author.is_empty() || page.sections.is_empty() {
        return Err(GuideHtmlError::new(
            "Steam guide content was unavailable or its page format changed",
        ));
    }
    let sections: Vec<_> = page
        .sections
        .into_iter()
        .map(|section| {
            json!({
                "html": section.html,
                "id": section.id,
                "title": section.title,
            })
        })
        .collect();
    Ok(json!({
        "author": page.author,
        "guideId": guide_id,
        "sections": sections,
        "sourceUrl": source_url(guide_id),
        "title": page.title,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Eq, PartialEq)]
    enum Event {
        Start(String, Attributes),
        StartEnd(String, Attributes),
        End(String),
        Data(String),
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Vec<Event>,
    }

    impl HtmlSink for RecordingSink {
        fn handle_starttag(
            &mut self,
            tag: &str,
            attributes: Attributes,
        ) -> Result<(), GuideHtmlError> {
            self.events.push(Event::Start(tag.to_owned(), attributes));
            Ok(())
        }

        fn handle_startendtag(
            &mut self,
            tag: &str,
            attributes: Attributes,
        ) -> Result<(), GuideHtmlError> {
            self.events
                .push(Event::StartEnd(tag.to_owned(), attributes));
            Ok(())
        }

        fn handle_endtag(&mut self, tag: &str) -> Result<(), GuideHtmlError> {
            self.events.push(Event::End(tag.to_owned()));
            Ok(())
        }

        fn handle_data(&mut self, data: &str) -> Result<(), GuideHtmlError> {
            self.events.push(Event::Data(data.to_owned()));
            Ok(())
        }
    }

    fn parse_recording(source: &str, chunks: &[usize]) -> Vec<Event> {
        let mut parser = HtmlParser::new(RecordingSink::default());
        let mut offset = 0;
        for &size in chunks {
            let end = (offset + size).min(source.len());
            parser
                .feed(&source[offset..end])
                .unwrap_or_else(|_| panic!());
            offset = end;
        }
        parser.feed(&source[offset..]).unwrap_or_else(|_| panic!());
        parser.close().unwrap_or_else(|_| panic!());
        parser.into_sink().events
    }

    #[test]
    fn chunked_feed_matches_single_feed_across_token_boundaries() {
        let source = "text &amp; more<div DATA-X='1>2' disabled>body\
                      <script>if (left < right) { value = '&amp;'; }</ScRiPt >\
                      <br /></div>tail";
        let expected = parse_recording(source, &[]);
        let one_byte_chunks = vec![1; source.len()];
        for chunks in [
            one_byte_chunks,
            vec![4, 7, 2, 19, 1, 3, 11, 5, 23],
            vec![source.find("<script>").unwrap() + 3, 2, 4, 9, 1, 17],
        ] {
            assert_eq!(parse_recording(source, &chunks), expected);
        }
    }

    #[test]
    fn incomplete_quoted_tag_waits_and_close_emits_text() {
        let mut parser = HtmlParser::new(RecordingSink::default());
        parser
            .feed("<div title='left>")
            .unwrap_or_else(|_| panic!());
        assert!(parser.sink.events.is_empty());
        parser.feed("right'>body").unwrap_or_else(|_| panic!());
        assert_eq!(
            parser.sink.events,
            vec![Event::Start(
                "div".to_owned(),
                vec![("title".to_owned(), Some("left>right".to_owned()))]
            )]
        );
        parser.close().unwrap_or_else(|_| panic!());
        assert_eq!(
            parser.sink.events,
            vec![
                Event::Start(
                    "div".to_owned(),
                    vec![("title".to_owned(), Some("left>right".to_owned()))]
                ),
                Event::Data("body".to_owned()),
            ]
        );
    }

    #[test]
    fn rawtext_does_not_tokenize_markup_or_false_end_prefixes() {
        let source = "<script><img onerror=bad></scriptx></ſcript>safe</SCRIPT ><p>after";
        let expected = vec![
            Event::Start("script".to_owned(), vec![]),
            Event::Data("<img onerror=bad></scriptx></ſcript>safe".to_owned()),
            Event::End("script".to_owned()),
            Event::Start("p".to_owned(), vec![]),
            Event::Data("after".to_owned()),
        ];
        assert_eq!(parse_recording(source, &[]), expected);
        let split = source.find("</scriptx>").unwrap() + "</script".len();
        assert_eq!(parse_recording(source, &[split]), expected);
    }

    #[test]
    fn unclosed_rawtext_and_malformed_markup_keep_safe_callbacks() {
        assert_eq!(
            parse_recording("before<!-- ignored forever", &[]),
            vec![Event::Data("before".to_owned())]
        );
        assert_eq!(
            parse_recording("<style>a < b &amp; c", &[]),
            vec![
                Event::Start("style".to_owned(), vec![]),
                Event::Data("a < b & c".to_owned()),
            ]
        );
        assert_eq!(
            parse_recording("x<!broken", &[]),
            vec![
                Event::Data("x".to_owned()),
                Event::Data("<".to_owned()),
                Event::Data("!broken".to_owned()),
            ]
        );
    }

    #[test]
    fn completed_token_stream_compacts_once_per_feed() {
        for token_count in [1_000, 8_000] {
            let mut parser = HtmlParser::new(RecordingSink::default());
            parser.feed(&"<b>x</b>".repeat(token_count)).unwrap();
            assert_eq!(parser.compactions, 1);
            assert!(parser.buffer.is_empty());
            assert_eq!(parser.sink.events.len(), token_count * 3);
        }
    }

    #[test]
    fn incremental_plain_text_does_not_grow_the_tokenizer_buffer() {
        let mut parser = HtmlParser::new(RecordingSink::default());
        let mut maximum_buffer = 0;
        for _ in 0..20_000 {
            parser.feed("x").unwrap_or_else(|_| panic!());
            maximum_buffer = maximum_buffer.max(parser.buffer.len());
        }
        parser.close().unwrap_or_else(|_| panic!());
        assert_eq!(maximum_buffer, 0);
        assert_eq!(parser.sink.events, vec![Event::Data("x".repeat(20_000))]);
    }

    #[test]
    fn one_malformed_markup_token_has_a_hard_size_limit() {
        let mut parser = HtmlParser::new(RecordingSink::default());
        let error = parser
            .feed(&format!("<div title='{}", "x".repeat(MAX_MARKUP_CHARS + 1)))
            .expect_err("oversized markup must fail");
        match error {
            ParseFailure::Tokenizer(error) => assert!(error.to_string().contains("size limit")),
            ParseFailure::Sink(error) => panic!("unexpected sink error: {error}"),
        }
    }

    #[test]
    fn unmatched_end_tags_leave_open_stacks_untouched() {
        let mut page = GuidePageParser::new();
        let mut fragment = FragmentSanitizer::new();
        for _ in 0..64 {
            page.handle_starttag("div", vec![]).unwrap();
            fragment.handle_starttag("div", vec![]).unwrap();
        }
        for _ in 0..1_000 {
            page.handle_endtag("definitely-not-open").unwrap();
            fragment.handle_endtag("definitely-not-open").unwrap();
        }
        assert_eq!(page.stack.len(), 64);
        assert_eq!(fragment.stack.len(), 64);
    }
}
