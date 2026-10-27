$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CurrentUserDpapi {
  [StructLayout(LayoutKind.Sequential)] private struct Blob { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CryptProtectData(ref Blob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr p);
  public static byte[] Transform(byte[] data, bool protect) {
    Blob input = new Blob { cbData=data.Length, pbData=Marshal.AllocHGlobal(data.Length) };
    Marshal.Copy(data, 0, input.pbData, data.Length);
    Blob output;
    try {
      bool ok = protect ? CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out output) : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out output);
      if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      byte[] result = new byte[output.cbData]; Marshal.Copy(output.pbData, result, 0, output.cbData); LocalFree(output.pbData); return result;
    } finally { Marshal.FreeHGlobal(input.pbData); }
  }
}
'@
$operation = $args[0]
$encoded = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($encoded)
if ($operation -eq 'Protect') {
    $result = [CurrentUserDpapi]::Transform($bytes, $true)
} elseif ($operation -eq 'Unprotect') {
    $result = [CurrentUserDpapi]::Transform($bytes, $false)
} else {
    exit 2
}
[Console]::Out.Write([Convert]::ToBase64String($result))
