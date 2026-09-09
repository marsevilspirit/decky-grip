use crate::positions::{PositionStore, position_value};
use crate::reader_positions::ReaderPositionStore;
use crate::storage::StoreError;
use serde_json::{Map, Value, json};

const PROTOCOL_VERSION: u64 = 2;
const PROTOCOL_CAPABILITIES: [&str; 6] = [
    "positions",
    "reader_positions",
    "guides",
    "images",
    "hotkey",
    "multiplex",
];
pub(crate) const MAX_REQUEST_BYTES: usize = 64 * 1024;

pub(crate) fn request_fields(value: &Value) -> Result<(&str, Option<&Value>), StoreError> {
    let object = value
        .as_object()
        .ok_or(StoreError::Protocol("request must be a JSON object"))?;
    if object.len() < 2
        || object.len() > 3
        || !object.contains_key("id")
        || !object.contains_key("method")
        || object
            .keys()
            .any(|key| !matches!(key.as_str(), "id" | "method" | "params"))
    {
        return Err(StoreError::Protocol(
            "request contains unknown or missing fields",
        ));
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or(StoreError::Protocol("method must be a string"))?;
    Ok((method, object.get("params")))
}

pub(crate) fn empty_params(params: Option<&Value>) -> Result<(), StoreError> {
    match params {
        None => Ok(()),
        Some(Value::Object(object)) if object.is_empty() => Ok(()),
        _ => Err(StoreError::Protocol("method takes no parameters")),
    }
}

pub(crate) fn params_with_fields<'a>(
    params: Option<&'a Value>,
    fields: &[&str],
) -> Result<&'a Map<String, Value>, StoreError> {
    let object = params
        .and_then(Value::as_object)
        .ok_or(StoreError::Protocol("params must be a JSON object"))?;
    if object.len() != fields.len() || !fields.iter().all(|field| object.contains_key(*field)) {
        return Err(StoreError::Protocol(
            "params contain unknown or missing fields",
        ));
    }
    Ok(object)
}

fn guide_key_param(params: Option<&Value>) -> Result<&str, StoreError> {
    let object = params_with_fields(params, &["guide_key"])?;
    let guide_key =
        object
            .get("guide_key")
            .and_then(Value::as_str)
            .ok_or(StoreError::Validation(
                "guide_key must have the form <app_id>:<guide_id>",
            ))?;
    Ok(guide_key)
}

pub(crate) fn protocol_info() -> Value {
    json!({
        "capabilities": PROTOCOL_CAPABILITIES,
        "version": PROTOCOL_VERSION,
    })
}

pub(crate) fn dispatch(
    store: &PositionStore,
    reader_store: &ReaderPositionStore,
    method: &str,
    params: Option<&Value>,
) -> Result<Value, StoreError> {
    match method {
        "positions.snapshot" => {
            empty_params(params)?;
            store.snapshot()
        }
        "positions.save" => {
            let object = params_with_fields(params, &["guide_key", "scroll_top"])?;
            let guide_key =
                object
                    .get("guide_key")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_key must have the form <app_id>:<guide_id>",
                    ))?;
            let scroll_top = object.get("scroll_top").expect("scroll_top was checked");
            Ok(position_value(&store.save(guide_key, scroll_top)?))
        }
        "positions.repair" => {
            empty_params(params)?;
            store.repair()
        }
        "positions.repair_all" => {
            empty_params(params)?;
            Ok([
                ("positions".to_owned(), store.repair()),
                ("readerPositions".to_owned(), reader_store.repair()),
            ]
            .into_iter()
            .map(|(name, result)| {
                (name, result.unwrap_or_else(|error| {
                json!({"repaired": false, "backup": null, "error": error.message()})
            }))
            })
            .collect())
        }
        "reader_positions.get" => reader_store.get(guide_key_param(params)?),
        "reader_positions.save" => {
            let object = params_with_fields(
                params,
                &[
                    "guide_key",
                    "scroll_top",
                    "section_id",
                    "anchor_text",
                    "anchor_offset",
                ],
            )?;
            let guide_key =
                object
                    .get("guide_key")
                    .and_then(Value::as_str)
                    .ok_or(StoreError::Validation(
                        "guide_key must have the form <app_id>:<guide_id>",
                    ))?;
            reader_store.save(
                guide_key,
                object.get("scroll_top").expect("scroll_top was checked"),
                object.get("section_id").expect("section_id was checked"),
                object.get("anchor_text").expect("anchor_text was checked"),
                object
                    .get("anchor_offset")
                    .expect("anchor_offset was checked"),
            )
        }
        "reader_positions.repair" => {
            empty_params(params)?;
            reader_store.repair()
        }
        _ => Err(StoreError::Protocol("unknown method")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;
    use std::fs;

    #[test]
    fn repair_all_validates_once_and_repairs_stores_independently() {
        for primary_fails in [true, false] {
            let directory = TestDirectory::new("positions.json");
            let blocked = directory.0.join("not-a-file");
            fs::create_dir(&blocked).unwrap();
            let valid = directory.path();
            let corrupt = b"broken original bytes";
            fs::write(&valid, corrupt).unwrap();
            let (primary, reader) = if primary_fails {
                (blocked.clone(), valid.clone())
            } else {
                (valid.clone(), blocked.clone())
            };
            let store = PositionStore::new(primary);
            let reader_store = ReaderPositionStore::new(reader);
            assert!(
                dispatch(
                    &store,
                    &reader_store,
                    "positions.repair_all",
                    Some(&json!({"extra": true}))
                )
                .is_err()
            );
            assert_eq!(fs::read(&valid).unwrap(), corrupt);
            let result = dispatch(&store, &reader_store, "positions.repair_all", None).unwrap();
            let (failed, repaired) = if primary_fails {
                ("positions", "readerPositions")
            } else {
                ("readerPositions", "positions")
            };
            assert_eq!(result[failed]["repaired"], false);
            assert_eq!(result[failed]["backup"], Value::Null);
            assert!(
                result[failed]["error"]
                    .as_str()
                    .is_some_and(|error| !error.is_empty())
            );
            assert_eq!(result[repaired]["repaired"], true);
            assert_eq!(
                fs::read(result[repaired]["backup"].as_str().unwrap()).unwrap(),
                corrupt
            );
            assert!(blocked.is_dir());
        }
    }
}
