use std::{
    mem::{size_of, zeroed},
    os::unix::ffi::OsStrExt,
    ptr,
};

const MAX_PAYLOAD: usize = 61_440;

extern "C" fn finish(_: libc::c_int) {
    unsafe {
        libc::_exit(0);
    }
}

// libc does not expose setitimer on all Linux libc targets.
unsafe extern "C" {
    fn setitimer(
        which: libc::c_int,
        new: *const libc::itimerval,
        old: *mut libc::itimerval,
    ) -> libc::c_int;
}

fn main() {
    unsafe {
        observe();
    }
}

unsafe fn observe() {
    unsafe {
        let mut action: libc::sigaction = zeroed();
        action.sa_sigaction = finish as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGALRM, &action, ptr::null_mut()) != 0
            || libc::sigaction(libc::SIGPIPE, &action, ptr::null_mut()) != 0
        {
            return;
        }
        let mut budget: libc::itimerval = zeroed();
        budget.it_value.tv_usec = 20_000;
        if setitimer(libc::ITIMER_REAL, &budget, ptr::null_mut()) != 0 {
            return;
        }
        let mut args = std::env::args_os();
        let _ = args.next();
        let Some(path) = args.next() else {
            return;
        };
        if args.next().is_some() {
            return;
        }
        let path = path.as_bytes();
        let mut address: libc::sockaddr_un = zeroed();
        if path.is_empty() || path.len() >= address.sun_path.len() || path.contains(&0) {
            return;
        }
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        ptr::copy_nonoverlapping(
            path.as_ptr(),
            address.sun_path.as_mut_ptr().cast(),
            path.len(),
        );
        let flags = libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL);
        if flags < 0
            || libc::fcntl(libc::STDIN_FILENO, libc::F_SETFL, flags | libc::O_NONBLOCK) != 0
        {
            return;
        }
        let mut payload = [0u8; MAX_PAYLOAD + 1];
        let mut size = 0;
        loop {
            let count = libc::read(
                libc::STDIN_FILENO,
                payload.as_mut_ptr().add(size).cast(),
                payload.len() - size,
            );
            if count > 0 {
                size += count as usize;
                if size > MAX_PAYLOAD {
                    return;
                }
            } else if count == 0 {
                break;
            } else {
                let error = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if error != libc::EAGAIN && error != libc::EWOULDBLOCK {
                    return;
                }
                let mut input = libc::pollfd {
                    fd: libc::STDIN_FILENO,
                    events: libc::POLLIN,
                    revents: 0,
                };
                if libc::poll(&mut input, 1, 20) <= 0 {
                    return;
                }
            }
        }
        if size == 0 {
            return;
        }
        let fd = libc::socket(
            libc::AF_UNIX,
            libc::SOCK_DGRAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            0,
        );
        if fd < 0 {
            return;
        }
        libc::sendto(
            fd,
            payload.as_ptr().cast(),
            size,
            libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            (&address as *const libc::sockaddr_un).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        );
        libc::close(fd);
    }
}
