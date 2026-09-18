/* Native Windows startup boundary. Compile with the static MSVC CRT (/MT):
 * Bun must never run until the explicit environment block has been installed.
 * Source: https://learn.microsoft.com/windows/win32/procthread/changing-environment-variables
 */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "bcrypt.lib")

#define CSO_PATH_CAP 32768
#define CSO_ENV_VALUE_CAP 8193
#ifndef GSTACK_CSO_CORE_SHA256
#error GSTACK_CSO_CORE_SHA256 must bind the launcher to its compiled core
#endif
#ifndef GSTACK_CSO_GIT_PATH
#error GSTACK_CSO_GIT_PATH must bind the launcher to setup's resolved git.exe
#endif

static int fail(const char *message) {
  fprintf(stderr, "gstack-cso: %s\n", message);
  return 69;
}

static int append(wchar_t *buffer, size_t *used, wchar_t value) {
  if (*used >= CSO_PATH_CAP - 1) return 0;
  buffer[(*used)++] = value;
  buffer[*used] = L'\0';
  return 1;
}

static int joined_path(wchar_t *output, size_t capacity,
                       const wchar_t *directory, const wchar_t *leaf) {
  int written = swprintf(output, capacity, L"%ls\\%ls", directory, leaf);
  return written >= 0 && (size_t)written < capacity;
}

/* Quote each argument using the Windows CRT's backslash/quote rules. No shell
 * participates, including for arguments containing %, &, quotes or newlines. */
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

static int environment_entry(wchar_t *block, size_t *used,
                             const wchar_t *name, const wchar_t *value) {
  size_t length = wcslen(name) + wcslen(value) + 2;
  if (*used + length >= CSO_PATH_CAP) return 0;
  memcpy(block + *used, name, wcslen(name) * sizeof(wchar_t));
  *used += wcslen(name); block[(*used)++] = L'=';
  memcpy(block + *used, value, (wcslen(value) + 1) * sizeof(wchar_t));
  *used += wcslen(value) + 1; block[*used] = L'\0';
  return 1;
}

static int inherited_entry(wchar_t *block, size_t *used, const wchar_t *name) {
  wchar_t value[CSO_ENV_VALUE_CAP];
  value[0] = L'\0';
  DWORD length = GetEnvironmentVariableW(name, value, CSO_ENV_VALUE_CAP);
  if (length >= (DWORD)CSO_ENV_VALUE_CAP) return 0;
  return environment_entry(block, used, name, value);
}

/* Hash the already-open core. Its handle denies writes, deletes, and renames,
 * so the bytes checked here are the bytes CreateProcessW will resolve below. */
static int sha256_handle(HANDLE file, char output[65]) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  PUCHAR object = NULL;
  ULONG object_bytes = 0, hash_bytes = 0, returned = 0;
  UCHAR digest[32], buffer[64 * 1024];
  DWORD read_bytes = 0;
  LARGE_INTEGER start;
  int valid = 0;
  start.QuadPart = 0;

  if (!SetFilePointerEx(file, start, NULL, FILE_BEGIN)) goto cleanup;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
      MS_PRIMITIVE_PROVIDER, 0) < 0) goto cleanup;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
      (PUCHAR)&object_bytes, (ULONG)sizeof(object_bytes), &returned, 0) < 0 ||
      returned != (ULONG)sizeof(object_bytes) || object_bytes == 0 ||
      object_bytes > 1024UL * 1024UL) goto cleanup;
  if (BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
      (PUCHAR)&hash_bytes, (ULONG)sizeof(hash_bytes), &returned, 0) < 0 ||
      returned != (ULONG)sizeof(hash_bytes) || hash_bytes != (ULONG)sizeof(digest))
    goto cleanup;
  object = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, object_bytes);
  if (!object || BCryptCreateHash(algorithm, &hash, object, object_bytes,
      NULL, 0, 0) < 0) goto cleanup;
  for (;;) {
    if (!ReadFile(file, buffer, (DWORD)sizeof(buffer), &read_bytes, NULL))
      goto cleanup;
    if (read_bytes == 0) break;
    if (BCryptHashData(hash, buffer, (ULONG)read_bytes, 0) < 0) goto cleanup;
  }
  if (BCryptFinishHash(hash, digest, (ULONG)sizeof(digest), 0) < 0) goto cleanup;
  static const char hex[] = "0123456789abcdef";
  for (ULONG index = 0; index < (ULONG)sizeof(digest); index++) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 15];
  }
  output[64] = '\0';
  valid = 1;

cleanup:
  if (hash) BCryptDestroyHash(hash);
  if (object) {
    SecureZeroMemory(object, object_bytes);
    HeapFree(GetProcessHeap(), 0, object);
  }
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!SetFilePointerEx(file, start, NULL, FILE_BEGIN)) valid = 0;
  return valid;
}

static HANDLE inherited_stdio(DWORD id, DWORD access) {
  HANDLE source = GetStdHandle(id), copy = INVALID_HANDLE_VALUE;
  if (source && source != INVALID_HANDLE_VALUE) {
    if (DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy,
                        0, TRUE, DUPLICATE_SAME_ACCESS)) return copy;
    return INVALID_HANDLE_VALUE;
  }
  SECURITY_ATTRIBUTES security = {(DWORD)sizeof(security), NULL, TRUE};
  return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
}

int wmain(int argc, wchar_t **argv) {
  wchar_t module[CSO_PATH_CAP], core[CSO_PATH_CAP], windows[MAX_PATH + 1];
  wchar_t caller_cwd[CSO_ENV_VALUE_CAP];
  DWORD caller_length = GetCurrentDirectoryW(CSO_ENV_VALUE_CAP, caller_cwd);
  if (!caller_length || caller_length >= (DWORD)CSO_ENV_VALUE_CAP)
    return fail("caller working directory unavailable or too large");
  DWORD length = GetModuleFileNameW(NULL, module, CSO_PATH_CAP);
  if (!length || length >= (DWORD)CSO_PATH_CAP) return fail("launcher path unavailable");
  HANDLE executable = CreateFileW(module, FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, NULL);
  if (executable == INVALID_HANDLE_VALUE) return fail("launcher path unavailable");
  length = GetFinalPathNameByHandleW(executable, module, CSO_PATH_CAP, FILE_NAME_NORMALIZED);
  CloseHandle(executable);
  if (!length || length >= (DWORD)CSO_PATH_CAP) return fail("launcher path unavailable");
  wchar_t *slash = wcsrchr(module, L'\\');
  if (!slash) return fail("invalid launcher path");
  *slash = L'\0';
  wchar_t gate_path[CSO_PATH_CAP];
  if (!joined_path(gate_path, CSO_PATH_CAP, module, L".gstack-cso-generation.lock"))
    return fail("generation lock path too long");
  SECURITY_ATTRIBUTES gate_security = {(DWORD)sizeof(gate_security), NULL, TRUE};
  HANDLE generation_gate = CreateFileW(gate_path, GENERIC_READ, FILE_SHARE_READ,
      &gate_security, OPEN_EXISTING, FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION gate_info;
  if (generation_gate == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(generation_gate, &gate_info) ||
      (gate_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      gate_info.nNumberOfLinks != 1 || gate_info.nFileSizeHigh != 0 || gate_info.nFileSizeLow != 0)
    return fail("installation generation lock is missing or invalid; run gstack setup/build");
  if (!joined_path(core, CSO_PATH_CAP, module, L"gstack-cso-core.exe"))
    return fail("core path too long");
  HANDLE pinned_core = CreateFileW(core, GENERIC_READ, FILE_SHARE_READ, NULL,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION core_info;
  if (pinned_core == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(pinned_core, &core_info) ||
      (core_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      core_info.nNumberOfLinks != 1)
    return fail("trusted compiled helper is missing or invalid; run gstack setup/build");
  wchar_t generation_path[CSO_PATH_CAP];
  if (!joined_path(generation_path, CSO_PATH_CAP, module, L".gstack-cso-generation"))
    return fail("generation manifest path too long");
  HANDLE generation = CreateFileW(generation_path, GENERIC_READ, FILE_SHARE_READ, NULL,
      OPEN_EXISTING, FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION generation_info; char actual[66]; DWORD manifest_bytes = 0;
  if (generation == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(generation, &generation_info) ||
      (generation_info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      generation_info.nNumberOfLinks != 1 || generation_info.nFileSizeHigh != 0 || generation_info.nFileSizeLow != 65 ||
      !ReadFile(generation, actual, 65, &manifest_bytes, NULL) || manifest_bytes != 65)
    return fail("generation manifest is missing or invalid; run gstack setup/build");
  CloseHandle(generation); actual[65] = '\0';
  if (actual[64] != '\n' || strncmp(actual, GSTACK_CSO_CORE_SHA256, 64) != 0)
    return fail("launcher and compiled helper generations do not match; run gstack setup/build");
  char core_sha256[65];
  if (!sha256_handle(pinned_core, core_sha256) ||
      strcmp(core_sha256, GSTACK_CSO_CORE_SHA256) != 0)
    return fail("compiled helper digest does not match its launcher; run gstack setup/build");

  wchar_t *command = calloc(CSO_PATH_CAP, sizeof(wchar_t));
  wchar_t *environment = calloc(CSO_PATH_CAP, sizeof(wchar_t));
  if (!command || !environment) return fail("startup allocation failed");
  size_t used = 0;
  if (!argument(command, &used, core)) return fail("arguments are too large");
  for (int i = 1; i < argc; i++)
    if (!append(command, &used, L' ') || !argument(command, &used, argv[i]))
      return fail("arguments are too large");

  /* Alphabetical, case-insensitive Unicode order; every other variable is
   * absent, including BUN_OPTIONS, BUN_BE_BUN, NODE_OPTIONS and loader hooks. */
  used = 0;
  const wchar_t *names[] = {L"CLAUDE_PLUGIN_DATA", L"CLAUDE_PLUGIN_ROOT",
      L"DOCKER_CONFIG", L"DOCKER_CONTEXT", L"DOCKER_HOST"};
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++)
    if (!inherited_entry(environment, &used, names[i])) return fail("environment input is too large");
  if (!environment_entry(environment, &used, L"GSTACK_CSO_CALLER_CWD", caller_cwd) ||
      !environment_entry(environment, &used, L"GSTACK_CSO_GENERATION_GUARD", L"inherited-windows-generation-handle-v3") ||
      !environment_entry(environment, &used, L"GSTACK_CSO_TRUSTED_GIT", GSTACK_CSO_GIT_PATH) ||
      !inherited_entry(environment, &used, L"GSTACK_HOME") ||
      !inherited_entry(environment, &used, L"HOME")) return fail("environment input is too large");
  length = GetWindowsDirectoryW(windows, MAX_PATH + 1);
  if (!length || length > (DWORD)MAX_PATH) return fail("Windows system directory unavailable");
  wchar_t git_path[CSO_ENV_VALUE_CAP], git_directory[CSO_ENV_VALUE_CAP];
  if (wcslen(GSTACK_CSO_GIT_PATH) >= CSO_ENV_VALUE_CAP) return fail("trusted Git path is too large");
  wcscpy(git_path, GSTACK_CSO_GIT_PATH); wcscpy(git_directory, git_path);
  wchar_t *git_slash = wcsrchr(git_directory, L'\\');
  if (!git_slash || git_slash == git_directory) return fail("trusted Git path is invalid");
  *git_slash = L'\0';
  wchar_t trusted_path[CSO_ENV_VALUE_CAP];
  int trusted_length = swprintf(trusted_path, CSO_ENV_VALUE_CAP,
      L"%ls;%ls\\System32", git_directory, windows);
  if (trusted_length < 0 || (size_t)trusted_length >= CSO_ENV_VALUE_CAP)
    return fail("trusted system path is too large");
  if (!environment_entry(environment, &used, L"LANG", L"C.UTF-8") ||
      !environment_entry(environment, &used, L"LC_ALL", L"C.UTF-8") ||
      !environment_entry(environment, &used, L"PATH", trusted_path) ||
      !environment_entry(environment, &used, L"SystemRoot", windows) ||
      !environment_entry(environment, &used, L"TZ", L"UTC") ||
      !inherited_entry(environment, &used, L"USERPROFILE")) return fail("environment input is too large");

  STARTUPINFOEXW startup = {0};
  PROCESS_INFORMATION child = {0};
  startup.StartupInfo.cb = (DWORD)sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE handles[4] = {inherited_stdio(STD_INPUT_HANDLE, GENERIC_READ),
      inherited_stdio(STD_OUTPUT_HANDLE, GENERIC_WRITE), inherited_stdio(STD_ERROR_HANDLE, GENERIC_WRITE), generation_gate};
  for (size_t i = 0; i < 4; i++) if (handles[i] == INVALID_HANDLE_VALUE) return fail("standard handles unavailable");
  startup.StartupInfo.hStdInput = handles[0];
  startup.StartupInfo.hStdOutput = handles[1];
  startup.StartupInfo.hStdError = handles[2];
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_bytes);
  startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, attribute_bytes);
  if (!startup.lpAttributeList ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          handles, sizeof(handles), NULL, NULL)) return fail("standard handle isolation unavailable");
  BOOL created = CreateProcessW(core, command, NULL, NULL, TRUE,
      CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment,
      module, &startup.StartupInfo, &child);
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  for (size_t i = 0; i < 3; i++) CloseHandle(handles[i]);
  free(command); free(environment);
  if (!created) { CloseHandle(pinned_core); return fail("trusted compiled helper could not start"); }
  CloseHandle(child.hThread);
  DWORD code = 69;
  if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0)
    GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(child.hProcess); CloseHandle(pinned_core); CloseHandle(generation_gate);
  return (int)code;
}
