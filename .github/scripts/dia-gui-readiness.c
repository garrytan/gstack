#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <ApplicationServices/ApplicationServices.h>
#include <Security/AuthSession.h>
#endif

struct root_fact {
  const char *state;
  const char *kind;
  int owner_matches;
  int ancestor_blocked;
};

static const char *kind_of(mode_t mode) {
  if (S_ISDIR(mode)) return "directory";
  if (S_ISREG(mode)) return "file";
  if (S_ISLNK(mode)) return "symlink";
  return "other";
}

static struct root_fact inspect_root(int home, const char *relative, uid_t owner) {
  struct root_fact fact = {"unavailable", NULL, -1, 0};
  char components[256];
  if (strlen(relative) >= sizeof(components)) return fact;
  memcpy(components, relative, strlen(relative) + 1);
  int directory = dup(home);
  if (directory < 0) return fact;
  char *state = NULL;
  char *component = strtok_r(components, "/", &state);
  while (component) {
    char *next = strtok_r(NULL, "/", &state);
    struct stat before;
    if (fstatat(directory, component, &before, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) fact.state = "absent";
      break;
    }
    fact.kind = kind_of(before.st_mode);
    fact.owner_matches = before.st_uid == owner;
    if (!next) { fact.state = "present"; break; }
    if (!S_ISDIR(before.st_mode) || before.st_uid != owner) { fact.ancestor_blocked = 1; break; }
    int child = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
    struct stat after;
    if (child < 0) { fact.ancestor_blocked = 1; break; }
    if (fstat(child, &after) != 0 || after.st_dev != before.st_dev || after.st_ino != before.st_ino
        || !S_ISDIR(after.st_mode) || after.st_uid != owner) {
      close(child);
      fact.ancestor_blocked = 1;
      break;
    }
    close(directory);
    directory = child;
    fact.kind = NULL;
    fact.owner_matches = -1;
    component = next;
  }
  close(directory);
  return fact;
}

static const char *boolean_or_null(int value) {
  return value < 0 ? "null" : value ? "true" : "false";
}

static void print_browser_roots(int home, uid_t owner) {
  const char *names[] = {"chrome", "chromium", "arc", "dia", "comet", "brave", "edge", "safari", "cookies"};
  const char *paths[] = {"Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
    "Library/Application Support/Arc", "Library/Application Support/Dia", "Library/Application Support/Comet",
    "Library/Application Support/BraveSoftware/Brave-Browser", "Library/Application Support/Microsoft Edge", "Library/Safari", "Library/Cookies"};
  printf("{");
  for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
    struct root_fact fact = inspect_root(home, paths[index], owner);
    printf("%s\"%s\":{\"state\":\"%s\",\"kind\":", index ? "," : "", names[index], fact.state);
    if (fact.kind) printf("\"%s\"", fact.kind); else printf("null");
    printf(",\"ownerMatches\":%s,\"ancestorBlocked\":%s}", boolean_or_null(fact.owner_matches), boolean_or_null(fact.ancestor_blocked));
  }
  printf("}");
}

#ifdef __APPLE__
static int dictionary_boolean(CFDictionaryRef dictionary, CFStringRef key) {
  CFTypeRef value = CFDictionaryGetValue(dictionary, key);
  return value && CFGetTypeID(value) == CFBooleanGetTypeID() ? CFBooleanGetValue(value) : -1;
}

int main(int argc, char **argv) {
  int browser_roots = argc == 2 && strcmp(argv[1], "--browser-roots") == 0;
  if (argc != 1 && !browser_roots) return 2;
  uid_t uid = getuid();
  struct passwd *account = getpwuid(uid);
  char registered[PATH_MAX], environment[PATH_MAX];
  const char *home = getenv("HOME");
  int home_matches = account && home && realpath(account->pw_dir, registered) && realpath(home, environment)
    && strcmp(registered, account->pw_dir) == 0 && strcmp(registered, environment) == 0;
  int home_fd = home_matches ? open(registered, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK) : -1;
  struct stat home_info;
  home_matches = home_fd >= 0 && fstat(home_fd, &home_info) == 0 && S_ISDIR(home_info.st_mode) && home_info.st_uid == uid;
  SessionAttributeBits attributes = 0;
  OSStatus status = SessionGetInfo(callerSecuritySession, NULL, &attributes);
  CFDictionaryRef quartz = CGSessionCopyCurrentDictionary();
  int same_uid = -1, login_done = -1, on_console = -1;
  if (quartz) {
    CFTypeRef value = CFDictionaryGetValue(quartz, kCGSessionUserIDKey);
    long long session_uid = -1;
    if (value && CFGetTypeID(value) == CFNumberGetTypeID() && CFNumberGetValue(value, kCFNumberLongLongType, &session_uid)) same_uid = session_uid == uid;
    if (same_uid == 1) {
      login_done = dictionary_boolean(quartz, kCGSessionLoginDoneKey);
      on_console = dictionary_boolean(quartz, kCGSessionOnConsoleKey);
    }
  }
  printf("{\"protocol\":1,\"supported\":true,\"identity\":{\"effectiveUidMatches\":%s,\"homeMatchesRegistered\":%s},",
    boolean_or_null(geteuid() == uid), boolean_or_null(home_matches));
  printf("\"security\":{\"status\":%d,\"graphicAccess\":%s,\"rootSession\":%s,\"tty\":%s,\"remote\":%s},",
    (int)status, boolean_or_null(status ? -1 : !!(attributes & sessionHasGraphicAccess)), boolean_or_null(status ? -1 : !!(attributes & sessionIsRoot)),
    boolean_or_null(status ? -1 : !!(attributes & sessionHasTTY)), boolean_or_null(status ? -1 : !!(attributes & sessionIsRemote)));
  printf("\"quartz\":{\"present\":%s,\"sameUid\":%s,\"loginDone\":%s,\"onConsole\":%s},\"browserRoots\":",
    boolean_or_null(quartz != NULL), boolean_or_null(same_uid), boolean_or_null(login_done), boolean_or_null(on_console));
  if (browser_roots && home_matches) print_browser_roots(home_fd, uid); else printf("null");
  printf("}\n");
  if (home_fd >= 0) close(home_fd);
  if (quartz) CFRelease(quartz);
  return 0;
}
#else
int main(void) {
  printf("{\"protocol\":1,\"supported\":false}\n");
  return 2;
}
#endif
