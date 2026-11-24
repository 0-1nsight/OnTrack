// OnTrack Windows focus watcher.
//
// One long-running process that reports foreground changes as they happen, instead of
// being spawned every few seconds. Emits one JSON object per line on stdout.
//
// Metadata only: process name, window title, idle seconds, lock/sleep state,
// whether a microphone or camera is in use, and the virtual desktop id.
// No screenshots, keystrokes, clipboard or window contents.
//
// Build (done automatically by the agent):
//   csc.exe /nologo /target:exe /out:ontrack-focus-watcher.exe FocusWatcher.cs
//
// Targets .NET Framework 4.x, which ships with Windows 10 and 11.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

public static class FocusWatcher
{
    // ---- Win32 -------------------------------------------------------------------------
    delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    const int OBJID_WINDOW = 0;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
        WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hWinEventHook);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr hProcess,
        uint flags, StringBuilder exeName, ref uint size);

    [StructLayout(LayoutKind.Sequential)] struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public int ptX; public int ptY;
    }
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    // Virtual desktop id of a window. Documented COM interface, available on Windows 10 and 11.
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out bool onCurrent);
        [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
        [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }
    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")] class VirtualDesktopManagerClass { }

    // ---- State -------------------------------------------------------------------------
    static readonly object OutLock = new object();
    static readonly WinEventDelegate ForegroundCallback = OnWinEvent; // keep alive for the GC
    static IVirtualDesktopManager vdm;
    static volatile bool locked;
    static volatile bool sleeping;
    static TextWriter stdout;

    public static int Main(string[] args)
    {
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        try { vdm = (IVirtualDesktopManager)new VirtualDesktopManagerClass(); } catch { vdm = null; }

        // Exit when the agent goes away: stdin closes.
        var stdinThread = new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            Environment.Exit(0);
        }) { IsBackground = true };
        stdinThread.Start();

        SystemEvents.SessionSwitch += (s, e) =>
        {
            if (e.Reason == SessionSwitchReason.SessionLock || e.Reason == SessionSwitchReason.ConsoleDisconnect
                || e.Reason == SessionSwitchReason.RemoteDisconnect) { locked = true; Emit("lock"); }
            else if (e.Reason == SessionSwitchReason.SessionUnlock || e.Reason == SessionSwitchReason.ConsoleConnect
                || e.Reason == SessionSwitchReason.RemoteConnect) { locked = false; Emit("unlock"); }
        };
        SystemEvents.PowerModeChanged += (s, e) =>
        {
            if (e.Mode == PowerModes.Suspend) { sleeping = true; Emit("sleep"); }
            else if (e.Mode == PowerModes.Resume) { sleeping = false; Emit("resume"); }
        };

        IntPtr hookForeground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero,
            ForegroundCallback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        IntPtr hookName = SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero,
            ForegroundCallback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);

        if (hookForeground == IntPtr.Zero)
        {
            stdout.WriteLine("{\"type\":\"error\",\"message\":\"SetWinEventHook failed\"}");
            return 2;
        }

        Emit("start");

        // Idle, lock and media state change without a window event, so report them on a timer.
        // The agent treats a tick with an unchanged signature as a heartbeat, not a new segment.
        var tick = new Timer(_ => Emit("tick"), null, 2000, 2000);

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        UnhookWinEvent(hookForeground);
        if (hookName != IntPtr.Zero) UnhookWinEvent(hookName);
        GC.KeepAlive(tick);
        return 0;
    }

    static void OnWinEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        try
        {
            if (eventType == EVENT_SYSTEM_FOREGROUND) { Emit("foreground"); return; }
            // Title changes matter only for the window the user is looking at.
            if (eventType == EVENT_OBJECT_NAMECHANGE && idObject == OBJID_WINDOW && hwnd == GetForegroundWindow())
                Emit("title");
        }
        catch { }
    }

    static void Emit(string reason)
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            string title = "";
            string exe = "";
            uint pid = 0;
            if (hwnd != IntPtr.Zero)
            {
                title = ReadTitle(hwnd);
                GetWindowThreadProcessId(hwnd, out pid);
                exe = pid != 0 ? ReadExe(pid) : "";
            }

            uint idleSeconds = ReadIdleSeconds();
            bool media = ReadMediaInUse();
            string desktop = ReadDesktopId(hwnd);

            var sb = new StringBuilder(256);
            sb.Append("{\"type\":\"sample\",\"reason\":").Append(Json(reason))
              .Append(",\"atMs\":").Append(NowMs())
              .Append(",\"exe\":").Append(Json(exe))
              .Append(",\"title\":").Append(Json(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"idleSeconds\":").Append(idleSeconds)
              .Append(",\"locked\":").Append(locked ? "true" : "false")
              .Append(",\"sleeping\":").Append(sleeping ? "true" : "false")
              .Append(",\"mediaInUse\":").Append(media ? "true" : "false")
              .Append(",\"desktopId\":").Append(desktop == null ? "null" : Json(desktop))
              .Append("}");

            lock (OutLock) { stdout.WriteLine(sb.ToString()); }
        }
        catch (Exception ex)
        {
            lock (OutLock) { stdout.WriteLine("{\"type\":\"error\",\"message\":" + Json(ex.Message) + "}"); }
        }
    }

    static long NowMs()
    {
        return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    static string ReadTitle(IntPtr hwnd)
    {
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    // QueryFullProcessImageName works on elevated processes where Process.MainModule does not.
    static string ReadExe(uint pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            if (!QueryFullProcessImageName(h, 0, sb, ref size)) return "";
            return Path.GetFileNameWithoutExtension(sb.ToString());
        }
        finally { CloseHandle(h); }
    }

    static uint ReadIdleSeconds()
    {
        var lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref lii)) return 0;
        uint now = unchecked((uint)Environment.TickCount);
        return unchecked(now - lii.dwTime) / 1000;
    }

    static string ReadDesktopId(IntPtr hwnd)
    {
        if (vdm == null || hwnd == IntPtr.Zero) return null;
        try
        {
            Guid id;
            return vdm.GetWindowDesktopId(hwnd, out id) == 0 ? id.ToString() : null;
        }
        catch { return null; }
    }

    // Windows records which apps currently hold the microphone or camera. An open handle has
    // LastUsedTimeStop == 0. Reads registry values only; no audio or video is touched.
    static long lastMediaCheckMs;
    static bool lastMedia;
    static bool ReadMediaInUse()
    {
        long now = NowMs();
        if (now - lastMediaCheckMs < 4000) return lastMedia;
        lastMediaCheckMs = now;
        bool any = false;
        try
        {
            foreach (string device in new[] { "microphone", "webcam" })
            {
                using (RegistryKey root = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\" + device))
                {
                    if (root != null && AnyInUse(root, 0)) { any = true; break; }
                }
            }
        }
        catch { }
        lastMedia = any;
        return any;
    }

    static bool AnyInUse(RegistryKey key, int depth)
    {
        object start = key.GetValue("LastUsedTimeStart");
        object stop = key.GetValue("LastUsedTimeStop");
        if (start is long && stop is long && (long)start > 0 && (long)stop == 0) return true;
        if (depth >= 2) return false;
        foreach (string name in key.GetSubKeyNames())
        {
            using (RegistryKey sub = key.OpenSubKey(name))
            {
                if (sub != null && AnyInUse(sub, depth + 1)) return true;
            }
        }
        return false;
    }

    static string Json(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
