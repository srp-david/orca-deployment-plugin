// FTP 접속 정보: Windows 자격 증명 관리자(일반 자격 증명 `prod-deploy:<대상>`).
// 패널(워커)과 CLI 가 같은 곳을 읽는다. 값은 명령줄이 아니라 stdin(base64)으로만 오간다.
import { join } from 'node:path'
import { exec, Stop } from './util.ts'

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PdCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr p);
  public static string[] Read(string t) {
    IntPtr p;
    if (!CredReadW(t, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      string pw = c.CredentialBlobSize > 0 ? Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2) : "";
      return new string[] { c.UserName ?? "", pw };
    } finally { CredFree(p); }
  }
  public static void Write(string t, string user, string pw) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = t; c.UserName = user; c.Persist = 2;
    byte[] b = Encoding.Unicode.GetBytes(pw);
    c.CredentialBlobSize = b.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(Math.Max(b.Length, 1));
    Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try {
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
  public static bool Delete(string t) { return CredDeleteW(t, 1, 0); }
}
"@
$u8 = [Text.Encoding]::UTF8
function D([string]$s) { if ($s) { $u8.GetString([Convert]::FromBase64String($s)) } else { '' } }
function E([string]$s) { [Convert]::ToBase64String($u8.GetBytes($s)) }
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$t = D $req.target
switch ($req.op) {
  'read'   { $r = [PdCred]::Read($t); if ($r -eq $null) { 'none' } else { 'ok ' + (E $r[0]) + ' ' + (E $r[1]) } }
  'exists' { $r = [PdCred]::Read($t); if ($r -eq $null) { 'none' } else { 'ok ' + (E $r[0]) } }
  'write'  { [PdCred]::Write($t, (D $req.user), (D $req.password)); 'ok' }
  'delete' { if ([PdCred]::Delete($t)) { 'ok' } else { 'none' } }
}
`

function powershell(): string {
  const root = process.env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8')

async function call(req: Record<string, string>): Promise<string> {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')
  const r = await exec(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    input: JSON.stringify(req),
    timeoutMs: 60000
  })
  // 오류 메시지에 값이 섞이지 않도록 stderr 는 첫 줄만 쓴다(요청 값은 base64 로만 들어간다).
  if (r.code !== 0) throw new Stop(`자격 증명 관리자 호출 실패: ${r.err.trim().split('\n')[0]}`)
  return r.out.toString('utf8').trim()
}

export const credTarget = (id: string) => `prod-deploy:${id}`

export type Credential = { user: string; password: string }

export async function readCredential(id: string): Promise<Credential | null> {
  const out = await call({ op: 'read', target: b64(credTarget(id)) })
  if (out === 'none') return null
  const [, u, p] = out.split(' ')
  return { user: unb64(u ?? ''), password: unb64(p ?? '') }
}

/** 사용자 이름만(비밀번호는 꺼내지 않음). 없으면 null. */
export async function credentialUser(id: string): Promise<string | null> {
  const out = await call({ op: 'exists', target: b64(credTarget(id)) })
  if (out === 'none') return null
  return unb64(out.split(' ')[1] ?? '')
}

export async function writeCredential(id: string, c: Credential): Promise<void> {
  if (!c.user) throw new Stop('사용자 이름이 비었음')
  await call({ op: 'write', target: b64(credTarget(id)), user: b64(c.user), password: b64(c.password) })
}

export async function deleteCredential(id: string): Promise<boolean> {
  return (await call({ op: 'delete', target: b64(credTarget(id)) })) === 'ok'
}
