use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

pub fn valid(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn read(path: &Path) -> io::Result<String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let info = file.metadata()?;
    if !info.is_file()
        || info.uid() != unsafe { libc::getuid() }
        || info.mode() & 0o077 != 0
        || !(64..=65).contains(&info.len())
    {
        return Err(io::Error::other(
            "token file must be private and account-owned",
        ));
    }
    let mut raw = Vec::with_capacity(66);
    Read::by_ref(&mut file).take(66).read_to_end(&mut raw)?;
    let token = std::str::from_utf8(&raw).map_err(io::Error::other)?.trim();
    if !valid(token) {
        return Err(io::Error::other("invalid token format"));
    }
    Ok(token.to_owned())
}

pub fn create(path: &Path) -> io::Result<()> {
    let token = random_hex(32)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    writeln!(file, "{token}")?;
    file.sync_all()
}

pub fn random_hex(bytes: usize) -> io::Result<String> {
    let mut raw = vec![0; bytes];
    File::open("/dev/urandom")?.read_exact(&mut raw)?;
    Ok(raw.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn connection_id() -> io::Result<String> {
    let raw = random_hex(16)?;
    Ok(format!(
        "{}-{}-4{}-a{}-{}",
        &raw[..8],
        &raw[8..12],
        &raw[13..16],
        &raw[17..20],
        &raw[20..]
    ))
}
