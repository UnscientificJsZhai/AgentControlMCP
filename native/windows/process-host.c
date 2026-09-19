// Windows 受管进程宿主：先挂入 Job Object 再恢复线程，宿主退出即清理整棵树。
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>
#include <stdio.h>

// 按 CommandLineToArgvW/CRT 规则转义，参数不经过 cmd.exe。
static wchar_t *quote(wchar_t *out, const wchar_t *arg) {
  *out++ = L'"';
  unsigned slashes = 0;
  while (*arg) {
    if (*arg == L'\\') { slashes++; arg++; continue; }
    if (*arg == L'"') { for (unsigned i = 0; i < slashes * 2 + 1; i++) *out++ = L'\\'; }
    else { for (unsigned i = 0; i < slashes; i++) *out++ = L'\\'; }
    slashes = 0; *out++ = *arg++;
  }
  for (unsigned i = 0; i < slashes * 2; i++) *out++ = L'\\';
  *out++ = L'"'; return out;
}
int wmain(int argc, wchar_t **argv) {
  if (argc < 4 || wcscmp(argv[1], L"--parent")) return 64;
  DWORD parentId = wcstoul(argv[2], NULL, 10);
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentId);
  if (!parent) return 70;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 70;
  size_t size = 1;
  for (int i = 3; i < argc; i++) size += 2 * wcslen(argv[i]) + 4;
  if (size > 32767) return 64;
  wchar_t *command = calloc(size, sizeof(wchar_t)), *position = command;
  if (!command) return 70;
  for (int i = 3; i < argc; i++) { if (i > 3) *position++ = L' '; position = quote(position, argv[i]); }
  *position = 0;
  STARTUPINFOW startup = {0}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child = {0};
  if (!CreateProcessW(argv[3], command, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &startup, &child)) { free(command); CloseHandle(job); CloseHandle(parent); return 71; }
  free(command);
  if (!AssignProcessToJobObject(job, child.hProcess)) { TerminateProcess(child.hProcess, 72); CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job); CloseHandle(parent); return 72; }
  ResumeThread(child.hThread); CloseHandle(child.hThread);
  HANDLE watched[2] = {child.hProcess, parent};
  DWORD winner = WaitForMultipleObjects(2, watched, FALSE, INFINITE), code = 1;
  if (winner == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &code);
  CloseHandle(job); CloseHandle(child.hProcess); CloseHandle(parent); return (int)code;
}
