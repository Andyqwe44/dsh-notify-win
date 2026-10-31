namespace DshToastQuestion;

static partial class Program
{
    /// <summary>
    /// Whether DSH is already the foreground window AND the user can actually see
    /// it. A window hidden to the tray can keep the foreground slot (Windows only
    /// moves it when another window is activated), so a hidden window must not
    /// suppress the toast: the user is not looking at anything.
    /// </summary>
    static bool TestDshWindowFocused()
    {
        var hwnd = GetForegroundWindow();
        return IsDshWindow(hwnd) && IsWindowVisible(hwnd) && !IsIconic(hwnd);
    }

    /// <summary>Whether the window belongs to DSH, judged by its title.</summary>
    static bool IsDshWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        try
        {
            var sb = new StringBuilder(512);
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString().Contains(BrandName, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // Focus / launch DSH. The resident helper handles Activated in-process;
    // --focus covers a click on a toast after DSH/helper restarted, and the
    // dsh-notify:// protocol. A toast click should behave like clicking the
    // DSH tray icon: show the window if it is hidden, restore it if minimized,
    // and bring it to the front.
    // ---------------------------------------------------------------------
    const int SwShow = 5;
    const int SwRestore = 9;
    const byte VkMenu = 0x12;
    const uint KeyeventfKeyup = 0x2;
    static readonly IntPtr HwndTopmost = new(-1);
    static readonly IntPtr HwndNotTopmost = new(-2);
    const uint SwpNomove = 0x2;
    const uint SwpNosize = 0x1;
    const uint SwpNoactivate = 0x10;
    const uint SwpShowWindow = 0x40;

    static void FocusDsh()
    {
        try
        {
            var thread = new Thread(() =>
            {
                try
                {
                    var hwnd = FindDshWindow(includeHidden: true);
                    if (hwnd != IntPtr.Zero)
                    {
                        // A window hidden to the tray must be shown by the app
                        // itself: ShowWindow only reveals the native frame and
                        // leaves Chromium's renderer suspended, so the window
                        // would ignore mouse input. dsh://open runs the same
                        // focusPrimaryWindow path as the tray icon.
                        if (!IsWindowVisible(hwnd))
                        {
                            ActivateDshApp();
                            long deadline = Environment.TickCount64 + 1500;
                            while (!IsWindowVisible(hwnd) && Environment.TickCount64 < deadline) Thread.Sleep(50);
                            if (!IsWindowVisible(hwnd)) Log("app did not show the window; falling back to ShowWindow");
                            var shown = FindDshWindow(includeHidden: true);
                            if (shown != IntPtr.Zero) hwnd = shown;
                        }
                        // Never call SW_RESTORE on a maximized window: it would
                        // un-maximize it. Only fix the state that is wrong.
                        if (IsIconic(hwnd)) ShowWindow(hwnd, SwRestore);
                        if (!IsWindowVisible(hwnd)) ShowWindow(hwnd, SwShow); // last resort
                        ForceForeground(hwnd);
                        Log(GetForegroundWindow() == hwnd ? "focus: DSH is in front" : "focus: switch not confirmed");
                        return;
                    }
                    if (!LaunchDshApp()) Log("focus failed: DSH window and app not found");
                }
                catch (Exception error)
                {
                    Log("focus failed: " + error.Message);
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            thread.Join(3000);
        }
        catch (Exception error)
        {
            Log("focus thread failed: " + error.Message);
        }
    }

    /// <summary>
    /// Bring the window to the foreground even though the calling process does
    /// not own the foreground (a toast click is handled by the helper, not by
    /// DSH). A plain request is tried first; a single Alt keystroke marks the
    /// next one as user-initiated. A full-screen foreground app (video player,
    /// game) can refuse both, so the last resort raises DSH above it for the
    /// switch and then restores the normal Z-order. This only runs from a toast
    /// activation.
    /// </summary>
    static void ForceForeground(IntPtr hwnd)
    {
        if (GetForegroundWindow() == hwnd) return;
        SetForegroundWindow(hwnd);
        if (GetForegroundWindow() == hwnd) return;
        keybd_event(VkMenu, 0, 0, UIntPtr.Zero);
        keybd_event(VkMenu, 0, KeyeventfKeyup, UIntPtr.Zero);
        SetForegroundWindow(hwnd);
        if (GetForegroundWindow() == hwnd) return;
        SetWindowPos(hwnd, HwndTopmost, 0, 0, 0, 0, SwpNomove | SwpNosize | SwpShowWindow);
        SetForegroundWindow(hwnd);
        SetWindowPos(hwnd, HwndNotTopmost, 0, 0, 0, 0, SwpNomove | SwpNosize | SwpNoactivate);
        if (GetForegroundWindow() != hwnd) Log("focus failed: foreground switch was refused");
    }

    /// <summary>Ask the running DSH desktop app to show its window (tray path).</summary>
    static void ActivateDshApp()
    {
        try
        {
            Process.Start(new ProcessStartInfo("dsh://open") { UseShellExecute = true });
            Log("activated DSH app");
        }
        catch (Exception error)
        {
            Log("activate DSH app failed: " + error.Message);
        }
    }

    static bool LaunchDshApp()
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application");
        if (shellType == null) return false;
        dynamic shell = Activator.CreateInstance(shellType)!;
        object? folder = shell.NameSpace("shell:AppsFolder");
        if (folder == null) return false;
        dynamic items = ((dynamic)folder).Items();
        int count = (int)items.Count;
        for (int i = 0; i < count; i++)
        {
            dynamic item = items.Item(i);
            string name = (string?)item.Name ?? "";
            string path = (string?)item.Path ?? "";
            if (!name.Equals(BrandName, StringComparison.OrdinalIgnoreCase)) continue;
            if (!path.Contains("!App", StringComparison.OrdinalIgnoreCase)) continue;
            Process.Start(new ProcessStartInfo("explorer.exe", $"shell:AppsFolder\\{path}")
            {
                UseShellExecute = true,
            });
            Log("launched DSH app: " + path);
            return true;
        }
        return false;
    }

    /// <summary>
    /// Find the main DSH window. The flash needs a visible window (hidden
    /// windows have no taskbar button); focus passes includeHidden so a window
    /// minimized to the tray can be shown again.
    /// </summary>
    static IntPtr FindDshWindow(bool includeHidden = false)
    {
        IntPtr exact = IntPtr.Zero;
        IntPtr fallback = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!includeHidden && !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.Contains("— DeepSeek Harness", StringComparison.OrdinalIgnoreCase))
            {
                exact = h;
                return false;
            }
            if (title.Contains(BrandName, StringComparison.OrdinalIgnoreCase)) fallback = h;
            return true;
        }, IntPtr.Zero);
        return exact != IntPtr.Zero ? exact : fallback;
    }
}
