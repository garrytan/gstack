/* Trusted, dependency-free loopback service for runtime/verifier smoke tests.
 * This is infrastructure evidence, not a vulnerable/fixed evaluation pair. */
#include <arpa/inet.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  int server = socket(AF_INET, SOCK_STREAM, 0), reuse = 1;
  struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(34568),
                               .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  if (server < 0 || setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) ||
      bind(server, (void *)&address, sizeof(address)) || listen(server, 8)) return 2;
  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) continue;
    char request[2048] = {0}, response[256];
    ssize_t received = read(client, request, sizeof(request) - 1);
    const char *status = "404 Not Found", *body = "MISSING";
    if (received > 0 && strncmp(request, "GET /control ", 13) == 0) {
      status = "200 OK"; body = "CONTROL_OK";
    } else if (received > 0 && strncmp(request, "GET /security ", 14) == 0) {
      status = "403 Forbidden"; body = "DENIED";
    }
    int length = snprintf(response, sizeof(response),
        "HTTP/1.1 %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
        status, strlen(body), body);
    if (length > 0 && (size_t)length < sizeof(response)) {
      size_t sent = 0;
      while (sent < (size_t)length) {
        ssize_t count = write(client, response + sent, (size_t)length - sent);
        if (count <= 0) break;
        sent += (size_t)count;
      }
    }
    close(client);
  }
}
