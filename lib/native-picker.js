/**
 * 原生「选择文件 / 选择文件夹」对话框（Windows 现代 IFileOpenDialog，DPI 感知，不发虚）。
 *
 * 背景：原来用 powershell + System.Windows.Forms 的 FolderBrowserDialog / OpenFileDialog，
 * 那是老式 Win32 对话框，进程默认非 DPI 感知，125%/150% 缩放下整块界面发糊。
 * 这里换成 COM 的 IFileOpenDialog（Vista+ 现代对话框，和 Chrome「上传文件」用的是同一个
 * Windows 控件），并在同一 powershell 进程里先开 Per-Monitor V2 DPI 感知，再弹框。
 *
 * 说明：habit-hint 与 ai-voice 是两个独立插件包、不能跨包 import，所以
 * `habit-hint/lib/native-picker.js` 和 `ai-voice/lib/native-picker.js` 各放一份同样的实现，
 * 改的时候两边一起改（脚本逻辑只有这一套，不搞走样）。
 */
import { execFile } from 'node:child_process'

/** C# 侧：DPI 感知 + IFileOpenDialog（文件夹模式 FOS_PICKFOLDERS）+ IShellItem 取路径。 */
const TYPE_DEFINITION = `using System;
using System.IO;
using System.Runtime.InteropServices;

public static class DshNativePicker {
  [DllImport("user32.dll")]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogRCW { }

  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr p);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint f);
    void GetOptions(out uint f);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IntPtr p);
    void GetCurrentSelection(out IntPtr p);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string l);
    void GetResult(out IntPtr p);
    void AddPlace(IntPtr p, int a);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string e);
    void Close(int h);
    void SetClientGuid(ref Guid g);
    void ClearClientData();
    void SetFilter(IntPtr p);
    void GetResults(out IntPtr p);
    void GetSelectedItems(out IntPtr p);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr b, ref Guid h, ref Guid r, out IntPtr p);
    void GetParent(out IntPtr p);
    void GetDisplayName(uint s, out IntPtr n);
    void GetAttributes(uint m, out uint a);
    void Compare(IntPtr i, uint h, out int o);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(
    [MarshalAs(UnmanagedType.LPWStr)] string path,
    IntPtr pbc,
    [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
    [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4；老系统回退 SetProcessDPIAware
  private static string EnableDpiAwareness() {
    try {
      if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
    } catch { }
    try {
      if (SetProcessDPIAware()) return "system";
    } catch { }
    return "unknown";
  }

  private static IShellItem ParseItem(string path) {
    try {
      if (string.IsNullOrEmpty(path)) return null;
      if (!Directory.Exists(path) && !File.Exists(path)) return null;
      Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
      IShellItem item;
      SHCreateItemFromParsingName(path, IntPtr.Zero, iid, out item);
      return item;
    } catch {
      return null;
    }
  }

  public static string Pick(string initialPath, string title, string okLabel, bool pickFolders) {
    try {
      EnableDpiAwareness();
      var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
      uint options;
      dialog.GetOptions(out options);
      // FOS_FORCEFILESYSTEM(0x40) | FOS_PATHMUSTEXIST(0x800) | FOS_NOCHANGEDIR(0x8)
      // | FOS_DONTADDTORECENT(0x02000000)
      options |= 0x40u | 0x800u | 0x8u | 0x02000000u;
      if (pickFolders) {
        options |= 0x20u;   // FOS_PICKFOLDERS：目录选择模式
      } else {
        options |= 0x1000u; // FOS_FILEMUSTEXIST：必须选到已存在的文件
      }
      dialog.SetOptions(options);
      if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
      if (!string.IsNullOrEmpty(okLabel)) dialog.SetOkButtonLabel(okLabel);

      string startFolder = initialPath;
      string startFile = null;
      if (!string.IsNullOrEmpty(initialPath)) {
        try {
          if (File.Exists(initialPath)) {
            startFile = Path.GetFileName(initialPath);
            startFolder = Path.GetDirectoryName(initialPath);
          }
        } catch { }
      }
      var folderItem = ParseItem(startFolder);
      if (folderItem != null) {
        try { dialog.SetFolder(folderItem); } catch { }
      }
      if (!pickFolders && !string.IsNullOrEmpty(startFile)) {
        try { dialog.SetFileName(startFile); } catch { }
      }

      // 用当前前台窗口当 owner：对话框不会窜到浏览器后面，也不会自己另起一个无主窗口
      int hr = dialog.Show(GetForegroundWindow());
      if (hr != 0) return "";

      IntPtr resultPtr;
      dialog.GetResult(out resultPtr);
      var shellItem = (IShellItem)Marshal.GetObjectForIUnknown(resultPtr);
      IntPtr namePtr;
      shellItem.GetDisplayName(0x80058000u, out namePtr); // SIGDN_FILESYSPATH
      try {
        return Marshal.PtrToStringUni(namePtr);
      } finally {
        Marshal.FreeCoTaskMem(namePtr);
      }
    } catch (Exception ex) {
      return "ERR:" + ex.GetType().Name + ":" + ex.Message;
    }
  }

  // 自检：只编译 + 创建 COM 对象 + SetFolder，不 Show，不弹窗
  public static string SelfTest() {
    try {
      string dpi = EnableDpiAwareness();
      var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | 0x60u | 0x800u);
      dialog.SetTitle("selftest");
      dialog.SetOkButtonLabel("打开");
      string probe = Environment.GetEnvironmentVariable("DSH_PICKER_SELFTEST_DIR");
      if (!string.IsNullOrEmpty(probe)) {
        var item = ParseItem(probe);
        if (item == null) return "ERR:ParseItem:probe dir not parsed: " + probe;
        dialog.SetFolder(item);
      }
      // 中文往返探针：env 传「习惯模型」，经同一条 Base64 stdout 通道回传，由 Node 侧校验
      string cnProbe = Environment.GetEnvironmentVariable("DSH_PICKER_SELFTEST_CN");
      string cn = "none";
      if (!string.IsNullOrEmpty(cnProbe)) {
        cn = (cnProbe == "\u4e60\u60ef\u6a21\u578b") ? "OK" : "BAD";
      }
      return "SELFTEST_OK dpi=" + dpi + " cn=" + cn;
    } catch (Exception ex) {
      return "ERR:" + ex.GetType().Name + ":" + ex.Message;
    }
  }
}`

function escapeSingleQuoted(value) {
  return String(value === undefined || value === null ? '' : value).replace(/'/g, "''")
}

function addTypeBlock() {
  return ["Add-Type -TypeDefinition @'", TYPE_DEFINITION, "'@ -Language CSharp -ErrorAction Stop"].join('\n')
}

/** 生成「弹现代选择框」的 powershell 脚本（供调试/复用）；kind='file' 或 'folder'。 */
export function buildNativePickerScript(options = {}) {
  const kind = options.kind === 'file' ? 'file' : 'folder'
  const pickFolders = kind !== 'file'
  const initial = escapeSingleQuoted(options.initial || '')
  const title = escapeSingleQuoted(options.title || (kind === 'folder' ? '选择文件夹' : '选择文件'))
  const okLabel = escapeSingleQuoted(options.okLabel || '打开')
  const call = "[DshNativePicker]::Pick('" + initial + "','" + title + "','" + okLabel + "', $" + (pickFolders ? 'true' : 'false') + ")"
  const script = [
    // 防御性：设置控制台输出为 UTF-8，让「错误信息」也少乱码（真正传值靠下面的 Base64）
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    addTypeBlock(),
    '$out = ' + call,
    // 关键：路径按 Base64(UTF-8) 输出（纯 ASCII），绕开 PowerShell 控制台默认 GBK 与 Node 默认 UTF-8 解码不一致导致的乱码
    '[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$out)))',
  ].join('\n')
  return script
}

/** 自检脚本：Add-Type 编译 + 创建 COM 对话框 + SetFolder，不 Show（不会弹窗）。 */
export function buildNativePickerSelfTestScript() {
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    addTypeBlock(),
    '$out = [DshNativePicker]::SelfTest()',
    '[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$out)))',
  ].join('\n')
}

/** 用 powershell.exe -STA 跑脚本并取回 stdout（对话框必须在 STA 线程里弹）。 */
export function runPowerShellSta(script, timeoutMs = 600000, env = undefined) {
  return new Promise((resolvePromise, rejectPromise) => {
    let encoded = ''
    try {
      encoded = Buffer.from(String(script), 'utf16le').toString('base64')
    } catch (error) {
      rejectPromise(error)
      return
    }
    const options = {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }
    if (env && typeof env === 'object') options.env = { ...process.env, ...env }
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim() || String(error.message || 'PowerShell 执行失败')
        rejectPromise(new Error(detail.slice(0, 600)))
        return
      }
      resolvePromise(String(stdout || '').trim())
    })
  })
}

function lastLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || ''
}

/**
 * PowerShell stdout 回传的是 Base64(UTF-8)（路径或自检文本，纯 ASCII），这里解回 UTF-8 字符串。
 * 不是合法 Base64 时（旧脚本/异常输出）原样返回，避免把内容解坏。
 */
function decodePowerShellText(line) {
  const text = String(line || '').trim()
  if (text === '') return ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return text
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch {
    return text
  }
}

/**
 * 弹 Windows 现代选择框并返回选中的绝对路径；取消返回 ''；失败抛错。
 * options: { kind: 'folder'|'file', initial, title, okLabel, timeoutMs }
 */
export async function pickNativePath(options = {}) {
  const script = buildNativePickerScript(options)
  const raw = await runPowerShellSta(script, options.timeoutMs || 600000)
  const picked = decodePowerShellText(lastLine(raw))
  if (picked.startsWith('ERR:')) {
    throw new Error('打开系统选择框失败：' + picked.slice(4))
  }
  return picked
}

/** 自检：返回 "SELFTEST_OK dpi=... cn=OK" 或 "ERR:..."（用于开发期验证，不弹窗）。 */
export async function selftestNativePicker(probeDir = '') {
  const script = buildNativePickerSelfTestScript()
  const env = { DSH_PICKER_SELFTEST_CN: '习惯模型' }
  if (probeDir) env.DSH_PICKER_SELFTEST_DIR = probeDir
  const raw = await runPowerShellSta(script, 120000, env)
  const text = decodePowerShellText(lastLine(raw))
  // 中文往返校验：C# 侧回 cn=OK 才算过（Base64 通道没乱码）
  return text.includes('cn=OK') || text.startsWith('ERR:') ? text : text + ' cn=FAILED'
}
