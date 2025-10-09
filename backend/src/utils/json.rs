use serde_json::Value;

pub enum NullableValue {
    Omitted,
    Null,
    String(String),
}

pub fn classify_nullable(optional_value: Option<&Value>) -> Result<NullableValue, String> {
    match optional_value {
        None => Ok(NullableValue::Omitted),
        Some(Value::Null) => Ok(NullableValue::Null),
        Some(Value::String(s)) => Ok(NullableValue::String(s.to_owned())),
        Some(other) => Err(format!("expected string or null, got {other}")),
    }
}
