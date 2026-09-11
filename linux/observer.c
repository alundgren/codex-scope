#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#define MAX_PAYLOAD 61440

static void finish(int signal_number) {
    (void)signal_number;
    _exit(0);
}

int main(int argc, char **argv) {
    /* The timer also covers a producer that never closes stdin. */
    struct sigaction action = {.sa_handler = finish};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGALRM, &action, NULL) != 0) return 0;
    if (sigaction(SIGPIPE, &action, NULL) != 0) return 0;
    struct itimerval budget = {.it_value = {.tv_usec = 20000}};
    if (setitimer(ITIMER_REAL, &budget, NULL) != 0) return 0;

    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (argc != 2 || strlen(argv[1]) >= sizeof(address.sun_path)) return 0;
    memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
    int flags = fcntl(STDIN_FILENO, F_GETFL);
    if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) != 0) return 0;
    char payload[MAX_PAYLOAD + 1];
    size_t size = 0;
    for (;;) {
        ssize_t count = read(STDIN_FILENO, payload + size, sizeof(payload) - size);
        if (count > 0) {
            size += (size_t)count;
            if (size > MAX_PAYLOAD) return 0;
        } else if (count == 0) {
            break;
        } else if (errno == EAGAIN || errno == EWOULDBLOCK) {
            struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
            if (poll(&input, 1, 20) <= 0) return 0;
        } else {
            return 0;
        }
    }
    if (size == 0) return 0;
    int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) return 0;
    /* One atomic datagram: a full receiver must never delay the hook. */
    (void)sendto(fd, payload, size, MSG_DONTWAIT | MSG_NOSIGNAL,
                 (struct sockaddr *)&address, sizeof(address));
    close(fd);
    return 0;
}
