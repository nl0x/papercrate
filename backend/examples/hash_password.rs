use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Argon2,
};
use rand::thread_rng;
use std::env;

fn main() {
    let password = env::args()
        .nth(1)
        .expect("Usage: cargo run --example hash_password <password>");
    let salt = SaltString::generate(&mut thread_rng());
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .expect("hashing failed")
        .to_string();
    println!("{}", hash);
}
