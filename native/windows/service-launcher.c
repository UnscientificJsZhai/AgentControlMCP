// 独立服务 launcher：明确执行 Job breakaway；凭证 ACL 只允许当前操作系统用户。
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <aclapi.h>
#include <wchar.h>
#include <stdlib.h>
#include <stdio.h>

static wchar_t *quote(wchar_t *out, const wchar_t *arg) {
  *out++ = L'"'; unsigned slashes = 0;
  while (*arg) {
    if (*arg == L'\\') { slashes++; arg++; continue; }
    if (*arg == L'"') { for (unsigned i = 0; i < slashes * 2 + 1; i++) *out++ = L'\\'; }
    else { for (unsigned i = 0; i < slashes; i++) *out++ = L'\\'; }
    slashes = 0; *out++ = *arg++;
  }
  for (unsigned i = 0; i < slashes * 2; i++) *out++ = L'\\';
  *out++ = L'"'; return out;
}
static wchar_t *commandLine(int argc, wchar_t **argv) {
  size_t size = 1;
  for (int i = 0; i < argc; i++) size += 2 * wcslen(argv[i]) + 4;
  if (size > 32767) return NULL;
  wchar_t *command = calloc(size, sizeof(wchar_t)), *position = command;
  if (!command) return NULL;
  for (int i = 0; i < argc; i++) { if (i) *position++ = L' '; position = quote(position, argv[i]); }
  *position = 0; return command;
}
static int privatePath(wchar_t *path) {
  HANDLE token = NULL; DWORD size = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 70;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = malloc(size);
  if (!user) { CloseHandle(token); return 70; }
  if (!GetTokenInformation(token, TokenUser, user, size, &size)) { free(user); CloseHandle(token); return 70; }
  EXPLICIT_ACCESSW access = {0};
  access.grfAccessPermissions = GENERIC_ALL; access.grfAccessMode = SET_ACCESS;
  access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.TrusteeType = TRUSTEE_IS_USER;
  access.Trustee.ptstrName = (LPWSTR)user->User.Sid;
  PACL acl = NULL;
  DWORD result = SetEntriesInAclW(1, &access, NULL, &acl);
  if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(path, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
  if (acl) LocalFree(acl);
  free(user); CloseHandle(token); return result == ERROR_SUCCESS ? 0 : 70;
}
static int launch(int argc, wchar_t **argv) {
  wchar_t *command = commandLine(argc, argv);
  if (!command) return 64;
  BOOL inJob = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), NULL, &inJob)) { free(command); return 70; }
  STARTUPINFOW startup = {0}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child = {0};
  DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT |
    (inJob ? CREATE_BREAKAWAY_FROM_JOB : 0);
  // 不回退到继承 Job 的启动方式，禁止 breakaway 时交给用户手动前台启动。
  BOOL ok = CreateProcessW(argv[0], command, NULL, NULL, FALSE, flags, NULL, NULL, &startup, &child);
  free(command);
  if (!ok) return 73;
  wprintf(L"%lu\n", child.dwProcessId); fflush(stdout);
  CloseHandle(child.hThread); CloseHandle(child.hProcess); return 0;
}
// CI 验收将 launcher 放入真正的 Job 后调用 --launch，不以文件存在替代行为断言。
static int jobTest(int argc, wchar_t **argv) {
  if (argc < 5) return 64;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
    (!wcscmp(argv[2], L"allowed") ? JOB_OBJECT_LIMIT_BREAKAWAY_OK : 0);
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 70;
  wchar_t **args = calloc((size_t)argc, sizeof(wchar_t *));
  if (!args) { CloseHandle(job); return 70; }
  args[0] = argv[0]; args[1] = L"--launch";
  for (int i = 3; i < argc; i++) args[i - 1] = argv[i];
  wchar_t *command = commandLine(argc - 1, args); free(args);
  if (!command) { CloseHandle(job); return 64; }
  STARTUPINFOW startup = {0}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child = {0};
  BOOL ok = CreateProcessW(argv[0], command, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &startup, &child);
  free(command);
  if (!ok) { CloseHandle(job); return 70; }
  if (!AssignProcessToJobObject(job, child.hProcess)) { TerminateProcess(child.hProcess, 72); CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job); return 72; }
  ResumeThread(child.hThread); CloseHandle(child.hThread);
  WaitForSingleObject(child.hProcess, INFINITE); DWORD code = 1;
  GetExitCodeProcess(child.hProcess, &code); CloseHandle(child.hProcess); CloseHandle(job); return (int)code;
}
int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && !wcscmp(argv[1], L"--private")) return privatePath(argv[2]);
  if (argc >= 3 && !wcscmp(argv[1], L"--launch")) return launch(argc - 2, argv + 2);
  if (argc >= 5 && !wcscmp(argv[1], L"--job")) return jobTest(argc, argv);
  return 64;
}
