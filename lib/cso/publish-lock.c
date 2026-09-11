/* Build-time serialization for publishing the native CSO bundle. */
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define CSO_COMMAND_CAP 32768

static int append(wchar_t *buffer, size_t *used, wchar_t value) {
  if (*used >= CSO_COMMAND_CAP - 1) return 0;
  buffer[(*used)++] = value;
  buffer[*used] = L'\0';
  return 1;
}

static int joined_path(wchar_t *output, size_t capacity,
                       const wchar_t *directory, const wchar_t *leaf) {
  int written = swprintf(output, capacity, L"%ls\\%ls", directory, leaf);
  return written >= 0 && (size_t)written < capacity;
}

static int argument(wchar_t *buffer, size_t *used, const wchar_t *value) {
  size_t slashes = 0;
  if (!append(buffer, used, L'"')) return 0;
  for (;; value++) {
    if (*value == L'\\') { slashes++; continue; }
    size_t count = (*value == L'"' || *value == L'\0') ? slashes * 2 : slashes;
    if (*value == L'"') count++;
    while (count--) if (!append(buffer, used, L'\\')) return 0;
    slashes = 0;
    if (*value == L'\0') break;
    if (!append(buffer, used, *value)) return 0;
  }
  return append(buffer, used, L'"');
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 4) { fputs("gstack-cso: publish lock requires a directory and command\n", stderr); return 69; }
  wchar_t directory[CSO_COMMAND_CAP];
  DWORD length = GetFullPathNameW(argv[1], CSO_COMMAND_CAP, directory, NULL);
  if (!length || length >= (DWORD)CSO_COMMAND_CAP) { fputs("gstack-cso: publication directory is invalid\n", stderr); return 69; }
  wchar_t gate_path[CSO_COMMAND_CAP];
  if (!joined_path(gate_path, CSO_COMMAND_CAP, directory, L".gstack-cso-generation.lock")) {
    fputs("gstack-cso: generation lock path is too long\n", stderr); return 69;
  }
  HANDLE gate = CreateFileW(gate_path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
      OPEN_ALWAYS, FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION gate_info;
  if (gate == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_SHARING_VIOLATION ? 73 : 69;
  if (!GetFileInformationByHandle(gate, &gate_info) ||
      (gate_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      gate_info.nNumberOfLinks != 1 || gate_info.nFileSizeHigh != 0 || gate_info.nFileSizeLow != 0) return 69;
  wchar_t *command = calloc(CSO_COMMAND_CAP, sizeof(wchar_t));
  if (!command) return 69;
  size_t used = 0;
  for (int i = 2; i < argc; i++)
    if ((i > 2 && !append(command, &used, L' ')) || !argument(command, &used, argv[i])) {
      fputs("gstack-cso: publication command is too large\n", stderr); return 69;
    }
  if (!SetEnvironmentVariableW(L"GSTACK_CSO_PUBLISH_LOCKED", L"1")) return 69;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, (DWORD)sizeof(limits))) return 69;
  STARTUPINFOW startup = {0}; PROCESS_INFORMATION child = {0}; startup.cb = (DWORD)sizeof(startup);
  if (!CreateProcessW(argv[2], command, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &startup, &child)) {
    fwprintf(stderr, L"gstack-cso: publication command could not start (Windows error %lu)\n", (unsigned long)GetLastError()); return 69;
  }
  if (!AssignProcessToJobObject(job, child.hProcess) || ResumeThread(child.hThread) == (DWORD)-1) {
    TerminateProcess(child.hProcess, 69); CloseHandle(child.hThread); CloseHandle(child.hProcess); return 69;
  }
  CloseHandle(child.hThread);
  DWORD code = 69;
  if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess); CloseHandle(job); CloseHandle(gate); free(command);
  return (int)code;
}
#else
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 4 || argv[2][0] != '/') {
    fputs("gstack-cso: publish lock requires a directory and absolute command\n", stderr); return 69;
  }
  int directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat state;
  if (directory < 0 || fstat(directory, &state) != 0 || !S_ISDIR(state.st_mode)) {
    fputs("gstack-cso: publication directory is unavailable\n", stderr); return 69;
  }
  if (flock(directory, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) return 73;
    fputs("gstack-cso: publication lock is unavailable\n", stderr); return 69;
  }
  if (setenv("GSTACK_CSO_PUBLISH_LOCKED", "1", 1) != 0) return 69;
  execv(argv[2], &argv[2]);
  fputs("gstack-cso: publication command could not start\n", stderr);
  return 69;
}
#endif
